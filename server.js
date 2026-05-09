import { spawn } from "node:child_process";
import { appendFileSync, createReadStream, createWriteStream, mkdirSync, unlink, existsSync } from "node:fs";
import { mkdir as mkdirAsync, stat, readdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const MODULE_ROOT = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.pkg
  ? path.join(path.dirname(process.execPath), "assets")
  : MODULE_ROOT;
const PORT = Number(process.env.PORT || 8000);
const APP_DATA_ROOT = process.pkg
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "DemucsSeperater")
  : path.join(__dirname, ".runtime");
const RUNTIME_ROOT = process.pkg
  ? path.join(APP_DATA_ROOT, ".runtime")
  : path.join(MODULE_ROOT, ".runtime");
const UPLOAD_DIR = path.join(RUNTIME_ROOT, "uploads");
const SEPARATED_DIR = path.join(RUNTIME_ROOT, "separated");
const LOG_DIR = path.join(APP_DATA_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");
const TORCH_HOME = process.env.TORCH_HOME || path.join(APP_DATA_ROOT, "torch");
const DEMUCS = process.env.DEMUCS || "demucs";
const MAX_UPLOAD_BYTES = 120 * 1024 * 1024;
const AUTO_DELETE_HOURS = 1;
const AVAILABLE_MODELS = [
  { id: "htdemucs", name: "htdemucs (标准 4 轨)", stems: 4 },
  { id: "htdemucs_ft", name: "htdemucs_ft (Fine-tuned)", stems: 4 },
  { id: "mdx", name: "mdx (MDX 基础)", stems: 4 },
  { id: "mdx_q", name: "mdx_q (MDX 量化版)", stems: 4 },
  { id: "mdx_extra_q", name: "mdx_extra_q (MDX 增强量化)", stems: 4 },
];

const jobs = new Map();

setupFileLogging();
console.log("[Startup] DemucsSeperater starting");
console.log(`[Startup] packaged=${Boolean(process.pkg)}`);
console.log(`[Startup] execPath=${process.execPath}`);
console.log(`[Startup] cwd=${process.cwd()}`);
console.log(`[Startup] appRoot=${APP_ROOT}`);
console.log(`[Startup] runtimeRoot=${RUNTIME_ROOT}`);
console.log(`[Startup] logFile=${LOG_FILE}`);
console.log(`[Startup] torchHome=${TORCH_HOME}`);

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

server.on("error", (error) => {
  console.error("Server listen error:", error);
  if (error?.code === "EADDRINUSE") {
    console.error(`[Startup] Port ${PORT} is already in use. Opening the existing app URL.`);
    if (process.pkg && process.env.NO_AUTO_OPEN !== "1") {
      openBrowser(`http://127.0.0.1:${PORT}`);
    }
    setTimeout(() => process.exit(0), 2000);
    return;
  }
  if (process.pkg) {
    setTimeout(() => process.exit(1), 5000);
  }
});

startServer();

async function startServer() {
  try {
    await mkdirAsync(UPLOAD_DIR, { recursive: true });
    await mkdirAsync(SEPARATED_DIR, { recursive: true });
    await mkdirAsync(TORCH_HOME, { recursive: true });
  } catch (error) {
    console.error("Startup directory initialization failed:", error);
    if (process.pkg) {
      setTimeout(() => process.exit(1), 5000);
    }
    return;
  }

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Demucs Stems server listening on http://127.0.0.1:${PORT}`);
    if (process.pkg && process.env.NO_AUTO_OPEN !== "1") {
      openBrowser(`http://127.0.0.1:${PORT}`);
    }
  });
}

function setupFileLogging() {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `\n===== ${new Date().toISOString()} =====\n`, "utf8");
  } catch (error) {
    console.error("Failed to initialize file logging:", error);
    return;
  }

  for (const method of ["log", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        const line = args
          .map((arg) => (arg instanceof Error ? `${arg.stack || arg.message}` : String(arg)))
          .join(" ");
        appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${method.toUpperCase()}] ${line}\n`, "utf8");
      } catch {}
    };
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      const child = spawn("explorer.exe", [url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (error) => {
        console.error("Failed to auto-open browser child process:", error);
      });
      child.unref();
      return;
    }

    if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.on("error", (error) => {
        console.error("Failed to auto-open browser child process:", error);
      });
      child.unref();
      return;
    }

    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
      console.error("Failed to auto-open browser child process:", error);
    });
    child.unref();
  } catch (error) {
    console.error("Failed to auto-open browser:", error);
  }
}

async function handleHealth(request, response) {
  try {
    const result = await runCommand(DEMUCS, ["--help"], 5000);
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

    const body = await readRequestBody(request, MAX_UPLOAD_BYTES);
    const file = await extractMultipartFile(body, boundary);
    const model = await extractModelFromBody(body);

    if (!file) {
      return sendJson(response, 400, {
        error: "missing_file",
        message: "没有找到名为 file 的音频字段。",
      });
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId,
      status: "processing",
      progress: 0,
      fileName: file.fileName,
      model: model,
      stems: {},
      createdAt: Date.now(),
      inputPath: file.path,
      outputDir: path.join(SEPARATED_DIR, jobId),
    };
    jobs.set(jobId, job);

    runDemucs(job).catch((err) => {
      const j = jobs.get(jobId);
      if (j) {
        j.status = "error";
        j.error = err.message;
      }
    });

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
    error: job.error,
    stems: job.stems,
    message: job.status === "completed" ? "分轨完成" : "处理中",
  });
}

async function handleDownload(request, response, jobId, stem) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const forceDownload = requestUrl.searchParams.get("download") === "1";
  const job = jobs.get(jobId);

  if (!job || job.status !== "completed") {
    return sendJson(response, 404, {
      error: "not_ready",
      message: "分轨任务未完成或不存在。",
    });
  }

  if (stem === "all") {
    return serveAllStemsZip(response, job, forceDownload);
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

  const rangeHeader = request.headers.range;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
      });
      response.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : fileStat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileStat.size) {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
      });
      response.end();
      return;
    }

    response.writeHead(206, {
      "Content-Type": "audio/wav",
      "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="${stem}.wav"`,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
      "Content-Length": end - start + 1,
    });

    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="${stem}.wav"`,
    "Accept-Ranges": "bytes",
    "Content-Length": fileStat.size,
  });

  createReadStream(filePath).pipe(response);
}

async function serveAllStemsZip(response, job, forceDownload = true) {
  const archive = archiver("zip", { zlib: { level: 9 } });

  response.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="stems_${job.id}.zip"`,
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

  const modelArg = job.model || "htdemucs";
  const result = await runCommand(
    DEMUCS,
    ["-o", job.outputDir, "-n", modelArg, job.inputPath],
    600000,
  );

  if (result.code !== 0) {
    throw new Error(`Demucs 执行失败: ${result.stderr || result.stdout}`);
  }

  job.status = "completed";
  job.progress = 100;

  const modelDir = path.join(job.outputDir, modelArg, path.basename(job.inputPath).replace(/\.[^.]+$/, ""));
  const stems = {};

  for (const stem of ["vocals", "drums", "bass", "other"]) {
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

  job.stems = stems;

  try {
    await unlink(job.inputPath).catch(() => {});
  } catch (e) {}

  scheduleCleanup(job);

  return stems;
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
    const child = spawn(command, args, { cwd: APP_ROOT, env: { ...process.env, TORCH_HOME } });
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

function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("上传文件过大。"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function extractMultipartFile(body, boundary) {
  const boundaryText = `--${boundary}`;
  const sections = body.toString("latin1").split(boundaryText);

  for (const section of sections) {
    if (!section.includes('name="file"')) {
      continue;
    }

    const headerEnd = section.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      continue;
    }

    const headers = section.slice(0, headerEnd);
    const fileName = headers.match(/filename="([^"]+)"/)?.[1] || "upload.audio";
    const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const content = section.slice(headerEnd + 4).replace(/\r\n--$/, "").replace(/\r\n$/, "");
    const target = path.join(UPLOAD_DIR, `${Date.now()}-${safeName}`);

    await writeFileFromLatin1(target, content);
    return { path: target, fileName: safeName };
  }

  return null;
}

async function extractModelFromBody(body) {
  return "htdemucs";
}

function writeFileFromLatin1(target, content) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(target);
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(Buffer.from(content, "latin1"));
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(APP_ROOT, normalized);

  if (!filePath.startsWith(APP_ROOT)) {
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
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("beforeExit", (code) => {
  console.error(`[Lifecycle] beforeExit code=${code}`);
});

process.on("exit", (code) => {
  console.error(`[Lifecycle] exit code=${code}`);
});

const keepAliveTimer = setInterval(() => {
  console.log(`[Watchdog] Server running, jobs: ${jobs.size}, time: ${new Date().toISOString()}`);
}, 30000);
keepAliveTimer.ref();

console.log("[Watchdog] Server started with watchdog enabled");
console.log(`[Config] Auto-delete after ${AUTO_DELETE_HOURS} hour(s)`);
