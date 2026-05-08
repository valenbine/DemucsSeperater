const form = document.querySelector("#upload-form");
const input = document.querySelector("#audio-file");
const dropZone = document.querySelector("#drop-zone");
const fileMeta = document.querySelector("#file-meta");
const separateButton = document.querySelector("#separate-button");
const downloadAllButton = document.querySelector("#download-all-button");
const modelSelect = document.querySelector("#model-select");
const statusTitle = document.querySelector("#status-title");
const statusCopy = document.querySelector("#status-copy");
const statusPill = document.querySelector("#status-pill");
const progressBar = document.querySelector("#progress-bar");
const fileName = document.querySelector("#file-name");
const fileDuration = document.querySelector("#file-duration");
const modelUsed = document.querySelector("#model-used");
const masterProgress = document.querySelector("#master-progress");

let selectedFile = null;
let currentJobId = null;
let stemAudios = {};
let stemGains = {};
let stemSources = {};
let masterGain = null;
let allPlaying = false;
let isAllMuted = false;
let audioContext = null;
let isSeeking = false;

function initAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterGain.connect(audioContext.destination);
  }
  return audioContext;
}

async function ensureAudioContextRunning() {
  const ctx = initAudioContext();
  if (ctx.state !== "running") {
    await ctx.resume();
  }
}

function reportPlaybackError(prefix, error) {
  const reason = error?.message || String(error || "未知错误");
  console.error(prefix, error);
  setStatus("播放失败", "Error", `${prefix}: ${reason}`, 100, true);
}

checkHealth();
loadModels();

input.addEventListener("change", () => {
  setSelectedFile(input.files?.[0] || null);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = event.dataTransfer?.files?.[0] || null;
  if (file) {
    input.files = event.dataTransfer.files;
    setSelectedFile(file);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile || !modelSelect.value) {
    return;
  }
  await startSeparation();
});

downloadAllButton.addEventListener("click", () => {
  if (!currentJobId) return;
  window.location.href = `/api/download/${currentJobId}/all?download=1`;
});

document.getElementById("play-all-btn").addEventListener("click", playAllStems);
document.getElementById("stop-all-btn").addEventListener("click", stopAllStems);
document.getElementById("mute-all-btn").addEventListener("click", toggleMuteAll);
masterProgress.addEventListener("input", () => {
  isSeeking = true;
  syncProgressToAudios();
});
masterProgress.addEventListener("change", () => {
  syncProgressToAudios();
  isSeeking = false;
});

document.querySelectorAll(".stem-mute").forEach((btn) => {
  btn.addEventListener("click", () => toggleMute(btn.dataset.stem));
});

document.querySelectorAll(".stem-volume").forEach((slider) => {
  slider.addEventListener("input", (e) => {
    setVolume(e.target.dataset.stem, e.target.value / 100);
  });
});

document.querySelectorAll(".stem-play").forEach((btn) => {
  btn.addEventListener("click", () => toggleStemPlayback(btn.dataset.stem));
});

document.querySelectorAll(".stem-download").forEach((btn) => {
  btn.addEventListener("click", () => downloadStem(btn.dataset.stem));
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    if (health.ok) {
      setStatus("服务可用", "Ready", health.message, 0);
    } else {
      setStatus("服务不可用", "Error", health.message, 0, true);
    }
  } catch {
    setStatus("后端未连接", "Error", "无法连接到后端服务。", 0, true);
  }
}

async function loadModels() {
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    if (data.models && data.models.length > 0) {
      modelSelect.innerHTML = data.models
        .map((m) => `<option value="${m.id}">${m.name}</option>`)
        .join("");
    }
  } catch (e) {
    console.error("Failed to load models:", e);
  }
}

function setSelectedFile(file) {
  selectedFile = file;
  currentJobId = null;
  resetStemStates();

  if (!file) {
    fileMeta.hidden = true;
    separateButton.disabled = true;
    fileName.textContent = "--";
    fileDuration.textContent = "0:00";
    modelUsed.textContent = "--";
    return;
  }

  fileMeta.hidden = false;
  fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;
  fileName.textContent = truncateFileName(file.name);
  separateButton.disabled = false;
  modelUsed.textContent = modelSelect.options[modelSelect.selectedIndex]?.text.split(" ")[0] || "htdemucs";

  loadAudioPreview(file);
  setStatus("音频已选择", "Ready", "点击开始分轨后将使用选中的模型进行分离。", 0);
}

async function loadAudioPreview(file) {
  try {
    const ctx = initAudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    fileDuration.textContent = formatTime(audioBuffer.duration);
    drawEmptyWaveforms();
  } catch (e) {
    console.error("Failed to load audio preview:", e);
    fileDuration.textContent = "Error";
  }
}

function drawEmptyWaveforms() {
  ["vocals", "drums", "bass", "other"].forEach((stem) => {
    const canvas = document.getElementById(`canvas-${stem}`);
    if (canvas) {
      drawWaveform(canvas, new Array(100).fill(0.1));
    }
  });
}

function drawWaveform(canvas, data) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const barWidth = width / data.length;
  const maxValue = Math.max(...data, 0.01);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(0, 0, width, height);

  data.forEach((value, index) => {
    const normalized = value / maxValue;
    const barHeight = normalized * (height - 10);
    const x = index * barWidth;
    const y = (height - barHeight) / 2;

    const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
    gradient.addColorStop(0, "#86efac");
    gradient.addColorStop(1, "#4338ca");

    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth - 1, barHeight);
  });
}

async function startSeparation() {
  if (!selectedFile) return;

  setBusy(true);
  currentJobId = null;
  modelUsed.textContent = modelSelect.options[modelSelect.selectedIndex]?.text.split(" ")[0] || "htdemucs";
  resetStemStates();
  setStatus("正在上传", "Uploading", "正在上传音频文件到服务器...", 5);

  try {
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("model", modelSelect.value);

    const response = await fetch("/api/stems", {
      method: "POST",
      body: formData,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.message || "分轨任务创建失败。");
    }

    currentJobId = data.jobId;
    setStatus("处理中", "Processing", "分轨任务已创建，正在等待服务器处理...", 10);
    pollJobStatus(data.jobId);
  } catch (error) {
    setStatus("创建任务失败", "Error", error.message, 0, true);
    setBusy(false);
  }
}

async function pollJobStatus(jobId) {
  const maxAttempts = 300;
  let attempts = 0;

  const poll = async () => {
    if (attempts >= maxAttempts) {
      setStatus("处理超时", "Error", "分轨处理时间过长，请稍后重试。", 0, true);
      setBusy(false);
      return;
    }

    try {
      const response = await fetch(`/api/status/${jobId}`);
      const status = await response.json();

      if (status.status === "completed") {
        handleCompletion(jobId, status);
        return;
      }

      if (status.status === "error") {
        setStatus("处理失败", "Error", status.error || "分轨处理失败。", 0, true);
        setBusy(false);
        return;
      }

      const progress = Math.min(status.progress || 10, 95);
      setStatus("处理中", "Processing", `正在使用 ${status.model || "htdemucs"} 模型分离音轨...`, progress);
      attempts++;
      setTimeout(poll, 1000);
    } catch (e) {
      attempts++;
      setTimeout(poll, 2000);
    }
  };

  poll();
}

function handleCompletion(jobId, status) {
  setStatus("分轨完成", "Completed", "所有音轨已成功分离，可以播放或下载。", 100);

  const hasStems = status.stems && Object.keys(status.stems).length > 0;

  if (hasStems) {
    Object.entries(status.stems).forEach(([stemName, stemPath]) => {
      enableStemControls(stemName, jobId);
    });
    downloadAllButton.disabled = false;
    document.getElementById("play-all-btn").disabled = false;
    document.getElementById("stop-all-btn").disabled = false;
    masterProgress.disabled = false;
  } else {
    setStatus("分离完成", "Warning", "未能获取部分音轨文件，请刷新重试。", 100, true);
  }

  setBusy(false);
}

function enableStemControls(stemName, jobId) {
  const playBtn = document.querySelector(`.stem-play[data-stem="${stemName}"]`);
  const downloadBtn = document.querySelector(`.stem-download[data-stem="${stemName}"]`);

  if (playBtn) playBtn.disabled = false;
  if (downloadBtn) downloadBtn.disabled = false;

  initAudioContext();

  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  const gainNode = audioContext.createGain();
  const sourceNode = audioContext.createMediaElementSource(audio);
  gainNode.gain.value = 0.8;

  audio.src = `/api/download/${jobId}/${stemName}`;
  sourceNode.connect(gainNode);
  gainNode.connect(masterGain);

  stemAudios[stemName] = audio;
  stemGains[stemName] = gainNode;
  stemSources[stemName] = sourceNode;

  loadWaveformData(stemName).then((data) => {
    const canvas = document.getElementById(`canvas-${stemName}`);
    if (canvas && data) {
      drawWaveform(canvas, data);
    }
  });

  audio.addEventListener("loadedmetadata", () => {
    updateMasterTime();
  });

  audio.addEventListener("timeupdate", updateMasterTime);
  audio.addEventListener("error", () => {
    const mediaError = audio.error;
    const detail = mediaError ? `媒体错误码 ${mediaError.code}` : "媒体加载失败";
    reportPlaybackError(`音轨 ${stemName} 无法播放`, new Error(detail));
  });
}

async function loadWaveformData(stemName) {
  if (!audioContext || !currentJobId) return null;

  try {
    const response = await fetch(`/api/download/${currentJobId}/${stemName}`);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const rawData = audioBuffer.getChannelData(0);
    const samples = 100;
    const blockSize = Math.floor(rawData.length / samples);
    const data = [];

    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        sum += Math.abs(rawData[i * blockSize + j]);
      }
      data.push(sum / blockSize);
    }

    const maxVal = Math.max(...data);
    return data.map((v) => v / maxVal);
  } catch (e) {
    console.error(`Failed to load waveform for ${stemName}:`, e);
    return null;
  }
}

async function playAllStems() {
  const hasAnyPlaying = Object.values(stemAudios).some((audio) => !audio.paused);

  if (hasAnyPlaying) {
    Object.values(stemAudios).forEach((audio) => {
      audio.pause();
    });
    allPlaying = false;
    updatePlayAllButton();
    updatePlayButtons();
    return;
  }

  try {
    await ensureAudioContextRunning();
  } catch (error) {
    reportPlaybackError("音频上下文启动失败", error);
    return;
  }

  const currentTime = getMasterCurrentTime();

  Object.entries(stemAudios).forEach(([stemName, audio]) => {
    audio.currentTime = currentTime;
    audio.play().catch((error) => {
      reportPlaybackError(`音轨 ${stemName} 播放失败`, error);
    });
  });
  allPlaying = true;
  updatePlayAllButton();
}

function stopAllStems() {
  Object.values(stemAudios).forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
  allPlaying = false;
  masterProgress.value = "0";
  updatePlayAllButton();
  updatePlayButtons();
  updateMasterTime();
}

function toggleMuteAll() {
  isAllMuted = !isAllMuted;

  const muteBtn = document.getElementById("mute-all-btn");

  if (isAllMuted) {
    Object.entries(stemGains).forEach(([stemName, gain]) => {
      gain.gain.value = 0;
    });
    muteBtn.classList.add("is-muted");
    muteBtn.querySelector(".btn-icon").textContent = "🔇";
    muteBtn.querySelector(".btn-text").textContent = "取消静音";

    document.querySelectorAll(".stem-mute").forEach((btn) => {
      btn.classList.add("is-muted");
      btn.textContent = "🔇";
    });
  } else {
    document.querySelectorAll(".stem-volume").forEach((slider) => {
      const stemName = slider.dataset.stem;
      setVolume(stemName, slider.value / 100);
    });
    muteBtn.classList.remove("is-muted");
    muteBtn.querySelector(".btn-icon").textContent = "🔊";
    muteBtn.querySelector(".btn-text").textContent = "静音";

    document.querySelectorAll(".stem-mute").forEach((btn) => {
      btn.classList.remove("is-muted");
      btn.textContent = "🔊";
    });
  }
}

function toggleMute(stemName) {
  const muteBtn = document.querySelector(`.stem-mute[data-stem="${stemName}"]`);
  const gain = stemGains[stemName];

  if (!gain) return;

  if (gain.gain.value === 0) {
    const slider = document.querySelector(`.stem-volume[data-stem="${stemName}"]`);
    gain.gain.value = slider ? slider.value / 100 : 0.8;
    muteBtn.classList.remove("is-muted");
    muteBtn.textContent = "🔊";
  } else {
    gain.gain.value = 0;
    muteBtn.classList.add("is-muted");
    muteBtn.textContent = "🔇";
  }
}

function setVolume(stemName, value) {
  const gain = stemGains[stemName];
  if (gain) {
    gain.gain.value = Math.max(0, Math.min(1, value));
  }
}

function updatePlayAllButton() {
  const playBtn = document.getElementById("play-all-btn");
  if (Object.values(stemAudios).some((audio) => !audio.paused)) {
    playBtn.querySelector(".btn-icon").textContent = "⏸";
    playBtn.querySelector(".btn-text").textContent = "暂停";
    playBtn.classList.add("is-active");
  } else {
    playBtn.querySelector(".btn-icon").textContent = "▶";
    playBtn.querySelector(".btn-text").textContent = "播放";
    playBtn.classList.remove("is-active");
  }
}

function updateMasterTime() {
  const times = Object.values(stemAudios).map((a) => a.currentTime || 0);
  const maxTime = Math.max(...times);
  const durations = Object.values(stemAudios).map((a) => a.duration || 0);
  const maxDuration = Math.max(...durations);

  if (!isSeeking && maxDuration > 0) {
    masterProgress.value = String(Math.round((maxTime / maxDuration) * 1000));
  }

  document.getElementById("master-time").textContent =
    `${formatTime(maxTime)} / ${formatTime(maxDuration)}`;

  updatePlayAllButton();
  updatePlayButtons();
}

async function toggleStemPlayback(stemName) {
  const audio = stemAudios[stemName];
  if (!audio) return;

  if (audio.paused) {
    try {
      await ensureAudioContextRunning();
      await audio.play();
    } catch (error) {
      reportPlaybackError(`音轨 ${stemName} 播放失败`, error);
      return;
    }
  } else {
    audio.pause();
  }

  updatePlayButtons();
}

function syncProgressToAudios() {
  const durations = Object.values(stemAudios).map((a) => a.duration || 0);
  const maxDuration = Math.max(...durations);
  if (!maxDuration || maxDuration <= 0) {
    return;
  }

  const targetTime = (Number(masterProgress.value) / 1000) * maxDuration;
  Object.values(stemAudios).forEach((audio) => {
    audio.currentTime = targetTime;
  });
  updateMasterTime();
}

function getMasterCurrentTime() {
  const times = Object.values(stemAudios).map((a) => a.currentTime || 0);
  const maxTime = Math.max(...times);
  return Number.isFinite(maxTime) ? maxTime : 0;
}

function updatePlayButtons() {
  document.querySelectorAll(".stem-play").forEach((btn) => {
    const stemName = btn.dataset.stem;
    const audio = stemAudios[stemName];
    if (!audio) return;

    if (!audio.paused) {
      btn.textContent = "暂停";
    } else {
      btn.textContent = "播放";
    }
  });
}

function downloadStem(stemName) {
  if (!currentJobId) return;
  window.location.href = `/api/download/${currentJobId}/${stemName}?download=1`;
}

function resetStemStates() {
  Object.values(stemAudios).forEach((audio) => {
    if (audio) {
      audio.pause();
      audio.src = "";
    }
  });

  Object.values(stemGains).forEach((gain) => {
    if (gain) {
      gain.disconnect();
    }
  });

  Object.values(stemSources).forEach((source) => {
    if (source) {
      source.disconnect();
    }
  });

  stemAudios = {};
  stemGains = {};
  stemSources = {};
  allPlaying = false;
  isAllMuted = false;

  document.querySelectorAll(".stem-play").forEach((btn) => {
    btn.disabled = true;
    btn.textContent = "播放";
  });
  document.querySelectorAll(".stem-download").forEach((btn) => {
    btn.disabled = true;
  });

  document.querySelectorAll(".stem-mute").forEach((btn) => {
    btn.classList.remove("is-muted");
    btn.textContent = "🔊";
  });
  document.querySelectorAll(".stem-volume").forEach((slider) => {
    slider.value = 80;
  });

  document.getElementById("play-all-btn").disabled = true;
  document.getElementById("stop-all-btn").disabled = true;
  const muteBtn = document.getElementById("mute-all-btn");
  muteBtn.classList.remove("is-muted");
  muteBtn.querySelector(".btn-icon").textContent = "🔊";
  muteBtn.querySelector(".btn-text").textContent = "静音";

  downloadAllButton.disabled = true;
  masterProgress.disabled = true;
  masterProgress.value = "0";
  document.getElementById("master-time").textContent = "0:00 / 0:00";
}

function setBusy(isBusy) {
  separateButton.disabled = isBusy || !selectedFile;
  input.disabled = isBusy;
  modelSelect.disabled = isBusy;
}

function setStatus(title, pill, copy, progress, isError = false) {
  statusTitle.textContent = title;
  statusPill.textContent = pill;
  statusCopy.textContent = copy;
  statusCopy.classList.toggle("is-error", isError);
  progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, seconds || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const rest = Math.floor(safeSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncateFileName(name, maxLength = 20) {
  if (name.length <= maxLength) return name;
  const ext = name.split(".").pop();
  const base = name.slice(0, name.length - ext.length - 1);
  return `${base.slice(0, maxLength - ext.length - 4)}...${ext}`;
}
