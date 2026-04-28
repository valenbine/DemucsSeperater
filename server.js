import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, unlink, existsSync } from "node:fs";
import { mkdir as mkdirAsync, stat, readdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const UPLOAD_DIR = path.join(__dirname, ".runtime", "uploads");
const SEPARATED_DIR = path.join(__dirname, ".runtime", "separated");
const DEMUCS_CANDIDATES = [process.env.DEMUCS, "demucs", "/usr/local/bin/demucs"].filter(Boolean);
let resolvedDemucsCommand = null;
const MAX_UPLOAD_BYTES = 120 * 1024 * 1024;
const AUTO_DELETE_HOURS = 1;
const AVAILABLE_MODELS = [
  { id: "htdemucs", name: "htdemucs (标准 4 轨)", stems: 4 },
  { id: "htdemucs_ft", name: "htdemucs_ft (Fine-tuned)", stems: 4 },
  { id: "htdemucs_6s", name: "htdemucs_6s (实验 6 轨)", stems: 6 },
  { id: "mdx", name: "mdx (MDX 基础)", stems: 4 },
  { id: "mdx_extra", name: "mdx_extra (MDX 高精度)", stems: 4 },
  { id: "mdx_q", name: "mdx_q (MDX 量化版)", stems: 4 },
  { id: "mdx_extra_q", name: "mdx_extra_q (MDX 增强量化)", stems: 4 },
  { id: "hdemucs_mmi", name: "hdemucs_mmi (V3 兼容旗舰)", stems: 4 },
];

const jobs = new Map();
const pendingJobs = [];
let activeJob = null;

await mkdirAsync(UPLOAD_DIR, { recursive: true });
await mkdirAsync(SEPARATED_DIR, { recursive: true });

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/api/health") {
      return handleHealth(request, response);
    }

    if (request.method === "GET" && request.url === "/api/models") {
      return handleModels(request, response);
    }

    if (request.method === "POST" && request.url === "/api/stems") {
      return handleStems(request, response);
    }

    if (request.method === "GET" && request.url.startsWith("/api/status/")) {
      const jobId = request.url.split("/")[3];
      return handleStatus(request, response, jobId);
    }

    if (request.method === "GET" && request.url.startsWith("/api/download/")) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const jobId = pathParts[2];
      const stem = pathParts[3];
      return handleDownload(request, response, jobId, stem);
    }

    return serveStatic(request, response);
  } catch (error) {
    console.error("Server error:", error);
    return sendJson(response, 500, {
      error: "internal_error",
      message: error.message || "服务器内部错误。",
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Demucs Stems server listening on http://127.0.0.1:${PORT}`);
});

async function handleHealth(request, response) {
  try {
    const demucsCommand = await resolveDemucsCommand();
    const result = await runCommand(demucsCommand, ["--help"], 5000);
    const demucsAvailable = result.code === 0;
    sendJson(response, 200, {
      ok: demucsAvailable,
      version: demucsAvailable ? "available" : "not found",
      message: demucsAvailable
        ? "Demucs 可用"
        : "未检测到 Demucs，请安装: pip install demucs",
    });
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      version: null,
      message: `Demucs 不可用: ${error.message}`,
    });
  }
}

async function handleModels(request, response) {
  sendJson(response, 200, {
    models: AVAILABLE_MODELS,
  });
}

async function handleStems(request, response) {
  try {
    const contentType = request.headers["content-type"] || "";
    const boundary = contentType.match(/boundary=(.+)$/)?.[1];

    if (!boundary) {
      return sendJson(response, 400, {
        error: "invalid_upload",
        message: "请求必须使用 multipart/form-data 上传音频。",
      });
    }

    const upload = await parseMultipartStream(request, boundary, MAX_UPLOAD_BYTES);
    const file = upload.file;
    const model = normalizeModel(upload.fields.model);
    const separationMode = normalizeSeparationMode(upload.fields.separationMode);

    if (!file) {
      return sendJson(response, 400, {
        error: "missing_file",
        message: "没有找到名为 file 的音频字段。",
      });
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId,
      status: "queued",
      progress: 0,
      fileName: file.fileName,
      model: model,
      separationMode,
      stems: {},
      createdAt: Date.now(),
      inputPath: file.path,
      outputDir: path.join(SEPARATED_DIR, jobId),
    };
    jobs.set(jobId, job);
    pendingJobs.push(jobId);
    processNextJob();

    sendJson(response, 202, {
      jobId,
      message: "分轨任务已创建，请使用 jobId 查询状态。",
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.payload?.error || "stems_failed",
      message: error.message || "分轨处理失败。",
    });
  }
}

async function handleStatus(request, response, jobId) {
  const job = jobs.get(jobId);

  if (!job) {
    return sendJson(response, 404, {
      error: "job_not_found",
      message: "未找到指定的任务或已过期。",
    });
  }

  sendJson(response, 200, {
    status: job.status,
    progress: job.progress,
    model: job.model,
    separationMode: job.separationMode,
    error: job.error,
    stems: job.stems,
    message:
      job.status === "completed"
        ? "分轨完成"
        : job.status === "error"
          ? "分轨失败"
          : job.status === "queued"
            ? "排队中"
          : "处理中",
  });
}

async function handleDownload(request, response, jobId, stem) {
  const job = jobs.get(jobId);

  if (!job || job.status !== "completed") {
    return sendJson(response, 404, {
      error: "not_ready",
      message: "分轨任务未完成或不存在。",
    });
  }

  if (stem === "all") {
    return serveAllStemsZip(response, job);
  }

  const filePath = job.stems[stem];
  if (!filePath) {
    return sendJson(response, 404, {
      error: "stem_not_found",
      message: `未找到音轨: ${stem}`,
    });
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    return sendJson(response, 404, {
      error: "file_not_found",
      message: "音轨文件不存在。",
    });
  }

  response.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Disposition": `attachment; filename="${stem}.wav"`,
    "Content-Length": fileStat.size,
  });

  createReadStream(filePath).pipe(response);
}

async function serveAllStemsZip(response, job) {
  const archive = archiver("zip", { zlib: { level: 9 } });

  response.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="stems_${job.id}.zip"`,
  });

  archive.pipe(response);

  for (const [stemName, filePath] of Object.entries(job.stems)) {
    try {
      const statResult = await stat(filePath);
      if (statResult.isFile()) {
        archive.file(filePath, { name: `${stemName}.wav` });
      }
    } catch (e) {
      console.error(`Failed to add ${stemName}:`, e);
    }
  }

  archive.finalize();
}

async function runDemucs(job) {
  await mkdirAsync(job.outputDir, { recursive: true });

  job.status = "downloading";
  job.progress = 5;

  const modelConfig = AVAILABLE_MODELS.find((item) => item.id === job.model) || AVAILABLE_MODELS[0];
  const modelArg = modelConfig.id;
  const commandArgs = ["-o", job.outputDir, "-n", modelArg];
  if (job.separationMode === "vocals") {
    commandArgs.push("--two-stems", "vocals");
  }
  commandArgs.push(job.inputPath);

  const demucsCommand = await resolveDemucsCommand();
  const result = await runCommand(demucsCommand, commandArgs, 600000);

  if (result.code !== 0) {
    throw new Error(`Demucs 执行失败: ${result.stderr || result.stdout}`);
  }

  job.status = "completed";
  job.progress = 100;

  const modelDir = path.join(job.outputDir, modelArg, path.basename(job.inputPath).replace(/\.[^.]+$/, ""));
  const stems = {};

  if (job.separationMode === "vocals") {
    const vocalsPath = path.join(modelDir, "vocals.wav");
    const noVocalsPath = path.join(modelDir, "no_vocals.wav");
    const accompanimentPath = path.join(modelDir, "accompaniment.wav");
    const otherPath = path.join(modelDir, "other.wav");
    const candidates = [
      ["vocals", vocalsPath],
      ["other", noVocalsPath],
      ["other", accompanimentPath],
      ["other", otherPath],
    ];
    for (const [key, filePath] of candidates) {
      try {
        const statResult = await stat(filePath);
        if (statResult.isFile()) {
          stems[key] = filePath;
        }
      } catch (e) {
        console.error(`Stem not found: ${key}`);
      }
    }
  } else {
    for (const stem of ["vocals", "drums", "bass", "other", "guitar", "piano"]) {
      const stemPath = path.join(modelDir, `${stem}.wav`);
      try {
        const statResult = await stat(stemPath);
        if (statResult.isFile()) {
          stems[stem] = stemPath;
        }
      } catch (e) {
        console.error(`Stem not found: ${stem}`);
      }
    }
  }

  job.stems = stems;

  try {
    await unlink(job.inputPath).catch(() => {});
  } catch (e) {}

  scheduleCleanup(job);

  return stems;
}

function processNextJob() {
  if (activeJob || pendingJobs.length === 0) {
    return;
  }

  const nextJobId = pendingJobs.shift();
  const job = jobs.get(nextJobId);
  if (!job) {
    processNextJob();
    return;
  }

  activeJob = nextJobId;
  job.status = "processing";
  job.progress = Math.max(job.progress, 1);

  runDemucs(job)
    .catch((err) => {
      const currentJob = jobs.get(nextJobId);
      if (currentJob) {
        currentJob.status = "error";
        currentJob.error = err.message;
      }
    })
    .finally(() => {
      activeJob = null;
      processNextJob();
    });
}

function scheduleCleanup(job) {
  const delay = AUTO_DELETE_HOURS * 60 * 60 * 1000;
  console.log(`[Cleanup] Scheduled deletion of job ${job.id} in ${AUTO_DELETE_HOURS} hour(s)`);

  setTimeout(async () => {
    const j = jobs.get(job.id);
    if (j && j.status === "completed") {
      console.log(`[Cleanup] Deleting job ${job.id} files...`);
      try {
        await unlink(job.inputPath).catch(() => {});
        await cleanupDir(job.outputDir);
        jobs.delete(job.id);
        console.log(`[Cleanup] Job ${job.id} deleted`);
      } catch (e) {
        console.error(`[Cleanup] Failed to delete job ${job.id}:`, e);
      }
    }
  }, delay);
}

async function resolveDemucsCommand() {
  if (resolvedDemucsCommand) {
    return resolvedDemucsCommand;
  }

  for (const command of DEMUCS_CANDIDATES) {
    try {
      const result = await runCommand(command, ["--help"], 5000);
      if (result.code === 0) {
        resolvedDemucsCommand = command;
        return command;
      }
    } catch (e) {
      continue;
    }
  }

  throw new Error("未找到可用的 Demucs 命令，请安装 Demucs 或设置环境变量 DEMUCS");
}

async function cleanupDir(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await cleanupDir(fullPath);
      } else {
        await unlink(fullPath).catch(() => {});
      }
    }
    await unlink(dirPath).catch(() => {});
  } catch (e) {}
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: __dirname, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: -1, stdout, stderr, error: "Command timeout" });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function normalizeModel(requestedModel) {
  const modelIds = new Set(AVAILABLE_MODELS.map((item) => item.id));
  if (requestedModel && modelIds.has(requestedModel)) {
    return requestedModel;
  }
  return "htdemucs";
}

function normalizeSeparationMode(mode) {
  if (mode === "vocals") {
    return "vocals";
  }
  if (mode === "six") {
    return "six";
  }
  return "four";
}

function parseMultipartStream(request, boundary, maxBytes) {
  return new Promise((resolve, reject) => {
    const boundaryBuf = Buffer.from(`--${boundary}`);
    const headerSep = Buffer.from("\r\n\r\n");
    const partEndMarker = Buffer.from(`\r\n--${boundary}`);

    const state = {
      buffer: Buffer.alloc(0),
      mode: "seek_boundary",
      current: null,
      fields: {},
      file: null,
      total: 0,
      finished: false,
      rejected: false,
      processing: false,
      scheduled: false,
    };

    const fail = (error) => {
      if (state.rejected) return;
      state.rejected = true;
      if (state.current?.stream) {
        state.current.stream.destroy();
      }
      reject(error);
    };

    const finishCurrentPart = () => {
      if (!state.current) {
        return Promise.resolve();
      }

      if (state.current.type === "file" && state.current.stream) {
        return new Promise((partResolve, partReject) => {
          state.current.stream.on("finish", partResolve);
          state.current.stream.on("error", partReject);
          state.current.stream.end();
        });
      }

      const value = Buffer.concat(state.current.chunks || []).toString("utf8").trim();
      state.fields[state.current.name] = value;
      return Promise.resolve();
    };

    const parseDisposition = (headersText) => {
      const name = headersText.match(/name="([^"]+)"/)?.[1] || null;
      const fileName = headersText.match(/filename="([^"]*)"/)?.[1] || null;
      return { name, fileName };
    };

    const processBuffer = async () => {
      while (!state.finished) {
        if (state.mode === "seek_boundary") {
          const idx = state.buffer.indexOf(boundaryBuf);
          if (idx < 0) {
            const keep = Math.max(boundaryBuf.length - 1, 0);
            if (state.buffer.length > keep) {
              state.buffer = state.buffer.slice(state.buffer.length - keep);
            }
            return;
          }

          state.buffer = state.buffer.slice(idx + boundaryBuf.length);
          if (state.buffer.slice(0, 2).toString("latin1") === "--") {
            state.finished = true;
            return;
          }

          if (state.buffer.slice(0, 2).toString("latin1") === "\r\n") {
            state.buffer = state.buffer.slice(2);
          }
          state.mode = "headers";
          continue;
        }

        if (state.mode === "headers") {
          const idx = state.buffer.indexOf(headerSep);
          if (idx < 0) {
            return;
          }

          const headersText = state.buffer.slice(0, idx).toString("latin1");
          state.buffer = state.buffer.slice(idx + headerSep.length);

          const disposition = parseDisposition(headersText);
          if (!disposition.name) {
            fail(new Error("无效的 multipart 字段。"));
            return;
          }

          if (disposition.name === "file") {
            const safeName = path
              .basename(disposition.fileName || "upload.audio")
              .replace(/[^a-zA-Z0-9._-]/g, "_");
            const target = path.join(UPLOAD_DIR, `${Date.now()}-${safeName}`);
            state.current = {
              type: "file",
              name: "file",
              fileName: safeName,
              path: target,
              stream: createWriteStream(target),
            };
            state.current.stream.on("error", fail);
          } else {
            state.current = {
              type: "field",
              name: disposition.name,
              chunks: [],
            };
          }

          state.mode = "content";
          continue;
        }

        if (state.mode === "content") {
          const idx = state.buffer.indexOf(partEndMarker);
          if (idx < 0) {
            const keep = partEndMarker.length;
            if (state.buffer.length > keep) {
              const consumable = state.buffer.slice(0, state.buffer.length - keep);
              if (state.current?.type === "file") {
                state.current.stream.write(consumable);
              } else if (state.current?.type === "field") {
                state.current.chunks.push(consumable);
              }
              state.buffer = state.buffer.slice(state.buffer.length - keep);
            }
            return;
          }

          const contentChunk = state.buffer.slice(0, idx);
          if (state.current?.type === "file") {
            state.current.stream.write(contentChunk);
          } else if (state.current?.type === "field") {
            state.current.chunks.push(contentChunk);
          }

          await finishCurrentPart();
          if (state.current?.type === "file") {
            state.file = {
              path: state.current.path,
              fileName: state.current.fileName,
            };
          }

          state.current = null;
          state.buffer = state.buffer.slice(idx + 2);
          state.mode = "seek_boundary";
          continue;
        }
      }
    };

    const scheduleProcess = () => {
      if (state.processing || state.rejected) {
        state.scheduled = true;
        return;
      }

      state.processing = true;
      processBuffer()
        .catch(fail)
        .finally(() => {
          state.processing = false;
          if (state.scheduled && !state.rejected) {
            state.scheduled = false;
            scheduleProcess();
          }
        });
    };

    request.on("data", (chunk) => {
      if (state.rejected) return;

      state.total += chunk.length;
      if (state.total > maxBytes) {
        fail(new Error("上传文件过大。"));
        request.destroy();
        return;
      }

      state.buffer = Buffer.concat([state.buffer, chunk]);
      scheduleProcess();
    });

    request.on("end", async () => {
      if (state.rejected) return;
      try {
        while (state.processing) {
          await new Promise((r) => setTimeout(r, 10));
        }
        await processBuffer();
        if (state.current) {
          await finishCurrentPart();
          if (state.current.type === "file") {
            state.file = {
              path: state.current.path,
              fileName: state.current.fileName,
            };
          }
        }

        if (!state.file) {
          reject(new Error("没有找到名为 file 的音频字段。"));
          return;
        }

        resolve({ file: state.file, fields: state.fields });
      } catch (error) {
        fail(error);
      }
    });

    request.on("error", fail);
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, normalized);

  if (!filePath.startsWith(__dirname)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => {
    response.destroy();
  });

  response.writeHead(200, { "Content-Type": getContentType(filePath) });
  stream.pipe(response);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    }[extension] || "application/octet-stream"
  );
}

function sendJson(response, statusCode, data) {
  const payload = data instanceof Error ? { message: data.message } : data;
  response.writeHead(data.statusCode || statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

process.on("uncaughtException", (error) => {
  console.error(error);
});

setInterval(() => {
  console.log(`[Watchdog] Server running, jobs: ${jobs.size}, time: ${new Date().toISOString()}`);
}, 60000);

console.log("[Watchdog] Server started with watchdog enabled");
console.log(`[Config] Auto-delete after ${AUTO_DELETE_HOURS} hour(s)`);
