const form = document.querySelector("#upload-form");
const input = document.querySelector("#audio-file");
const dropZone = document.querySelector("#drop-zone");
const fileMeta = document.querySelector("#file-meta");
const separateButton = document.querySelector("#separate-button");
const downloadAllButton = document.querySelector("#download-all-button");
const modelSelect = document.querySelector("#model-select");
const stemCountSelect = document.querySelector("#stem-count-select");
const statusTitle = document.querySelector("#status-title");
const statusCopy = document.querySelector("#status-copy");
const statusPill = document.querySelector("#status-pill");
const progressBar = document.querySelector("#progress-bar");
const fileName = document.querySelector("#file-name");
const fileDuration = document.querySelector("#file-duration");
const modelUsed = document.querySelector("#model-used");
const masterProgress = document.querySelector("#master-progress");
const stemsGrid = document.querySelector("#stems-grid");
const mergePanel = document.querySelector("#merge-panel");
const mergeToggleButton = document.querySelector("#merge-toggle-button");
const mergeStartButton = document.querySelector("#merge-start-button");
const mergeCopy = document.querySelector("#merge-copy");
const mergedPlayer = document.querySelector("#merged-player");
const mergedProgress = document.querySelector("#merged-progress");
const mergedTime = document.querySelector("#merged-time");
const mergedPlayButton = document.querySelector("#merged-play-button");
const mergedDownloadButton = document.querySelector("#merged-download-button");

const FALLBACK_MODELS = [
  { id: "htdemucs", name: "htdemucs (标准)", stemCounts: [2, 4] },
  { id: "htdemucs_ft", name: "htdemucs_ft (Fine-tuned)", stemCounts: [2, 4] },
  { id: "htdemucs_6s", name: "htdemucs_6s (6 轨)", stemCounts: [2, 6] },
  { id: "hdemucs_mmi", name: "hdemucs_mmi", stemCounts: [2, 4] },
  { id: "mdx", name: "mdx (MDX 基础)", stemCounts: [2, 4] },
  { id: "mdx_q", name: "mdx_q (MDX 量化版)", stemCounts: [2, 4] },
  { id: "mdx_extra", name: "mdx_extra (MDX 增强)", stemCounts: [2, 4] },
  { id: "mdx_extra_q", name: "mdx_extra_q (MDX 增强量化)", stemCounts: [2, 4] },
];
const STEMS_BY_COUNT = {
  2: ["vocals", "no_vocals"],
  4: ["vocals", "drums", "bass", "other"],
  6: ["vocals", "drums", "bass", "guitar", "piano", "other"],
};
const STEM_META = {
  vocals: { label: "人声", icon: "🎤" },
  no_vocals: { label: "伴奏", icon: "🎧" },
  drums: { label: "鼓组", icon: "🥁" },
  bass: { label: "贝斯", icon: "🎸" },
  guitar: { label: "吉他", icon: "🎸" },
  piano: { label: "钢琴", icon: "🎹" },
  other: { label: "其他", icon: "🎹" },
};

let availableModels = FALLBACK_MODELS;
let selectedFile = null;
let currentJobId = null;
let currentStems = [];
let stemAudios = {};
let stemGains = {};
let stemSources = {};
let masterGain = null;
let audioContext = null;
let isSeeking = false;
let mergeMode = false;
let mergedAudio = null;
let mergedSource = null;
let mergedGain = null;
let mergedId = null;
let mergedSeeking = false;
let stemSyncTimer = null;

checkHealth();
loadModels();
renderStemCards(STEMS_BY_COUNT[4]);
window.__demucsDebug = {
  getStemStates: () => Object.fromEntries(Object.entries(stemAudios).map(([stem, audio]) => [stem, {
    currentTime: audio.currentTime || 0,
    duration: audio.duration || 0,
    paused: audio.paused,
    readyState: audio.readyState,
  }])),
  getMergedState: () => mergedAudio ? {
    currentTime: mergedAudio.currentTime || 0,
    duration: mergedAudio.duration || 0,
    paused: mergedAudio.paused,
    readyState: mergedAudio.readyState,
  } : null,
};

input.addEventListener("change", () => setSelectedFile(input.files?.[0] || null));
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
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
  if (selectedFile && modelSelect.value) await startSeparation();
});

modelSelect.addEventListener("change", () => updateSelectionSummary());
stemCountSelect.addEventListener("change", () => {
  syncModelOptionsForStemCount();
  updateSelectionSummary();
  if (!currentJobId) renderStemCards(STEMS_BY_COUNT[Number(stemCountSelect.value)] || STEMS_BY_COUNT[4]);
});

downloadAllButton.addEventListener("click", () => {
  if (currentJobId) window.location.href = `/api/download/${currentJobId}/all?download=1`;
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

stemsGrid.addEventListener("click", (event) => {
  const target = event.target;
  const stem = target.dataset.stem;
  if (!stem) return;
  if (target.classList.contains("stem-play")) toggleStemPlayback(stem);
  if (target.classList.contains("stem-download")) downloadStem(stem);
  if (target.classList.contains("stem-mute")) toggleMute(stem);
});
stemsGrid.addEventListener("input", (event) => {
  const target = event.target;
  if (target.classList.contains("stem-volume")) setVolume(target.dataset.stem, target.value / 100);
  if (target.classList.contains("merge-check")) updateMergeButtonState();
});

mergeToggleButton.addEventListener("click", () => {
  mergeMode = !mergeMode;
  stemsGrid.classList.toggle("is-merge-mode", mergeMode);
  mergeToggleButton.textContent = mergeMode ? "取消选择" : "选择合并轨道";
  updateMergeButtonState();
});
mergeStartButton.addEventListener("click", mergeSelectedStems);
mergedPlayButton.addEventListener("click", toggleMergedPlayback);
mergedDownloadButton.addEventListener("click", () => {
  if (currentJobId && mergedId) window.location.href = `/api/download/${currentJobId}/${mergedId}?download=1`;
});
mergedProgress.addEventListener("input", () => {
  mergedSeeking = true;
  syncMergedProgressToAudio();
});
mergedProgress.addEventListener("change", () => {
  syncMergedProgressToAudio();
  mergedSeeking = false;
});

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
  if (ctx.state !== "running") await ctx.resume();
}

function reportPlaybackError(prefix, error) {
  const reason = error?.message || String(error || "未知错误");
  console.error(prefix, error);
  setStatus("播放失败", "Error", `${prefix}: ${reason}`, 100, true);
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    setStatus(health.ok ? "服务可用" : "服务不可用", health.ok ? "Ready" : "Error", health.message, 0, !health.ok);
  } catch {
    setStatus("后端未连接", "Error", "无法连接到后端服务。", 0, true);
  }
}

async function loadModels() {
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    if (data.models?.length) availableModels = data.models;
  } catch (error) {
    console.error("Failed to load models:", error);
  }
  syncModelOptionsForStemCount();
  updateSelectionSummary();
}

function syncModelOptionsForStemCount() {
  const stemCount = Number(stemCountSelect.value);
  const allowedModels = availableModels.filter((model) => model.stemCounts?.includes(stemCount));
  const current = modelSelect.value;
  modelSelect.innerHTML = allowedModels.map((model) => `<option value="${model.id}">${model.name}</option>`).join("");
  if (allowedModels.some((model) => model.id === current)) {
    modelSelect.value = current;
  } else if (stemCount === 6) {
    modelSelect.value = "htdemucs_6s";
  }
}

function setSelectedFile(file) {
  selectedFile = file;
  currentJobId = null;
  resetStemStates();
  resetMergedTrack();
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
  updateSelectionSummary();
  loadAudioPreview(file);
  setStatus("音频已选择", "Ready", "点击开始分轨后将使用选中的模型和轨道数进行分离。", 0);
}

async function loadAudioPreview(file) {
  try {
    const ctx = initAudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    fileDuration.textContent = formatTime(audioBuffer.duration);
    drawEmptyWaveforms();
  } catch (error) {
    console.error("Failed to load audio preview:", error);
    fileDuration.textContent = "Error";
  }
}

function updateSelectionSummary() {
  modelUsed.textContent = `${modelSelect.value || "--"} / ${stemCountSelect.value || "--"}轨`;
}

function renderStemCards(stems) {
  currentStems = stems;
  stemsGrid.innerHTML = stems.map((stem) => {
    const meta = STEM_META[stem] || { label: stem, icon: "🎚" };
    return `
      <div class="stem-card" data-stem="${stem}">
        <div class="stem-card__header">
          <label class="merge-check-wrap" title="选择用于合并">
            <input type="checkbox" class="merge-check" data-stem="${stem}" disabled />
          </label>
          <span class="stem-icon">${meta.icon}</span>
          <h3>${meta.label}</h3>
          <button class="mute-btn stem-mute" data-stem="${stem}" title="静音" disabled>🔊</button>
          <input type="range" class="volume-slider stem-volume" data-stem="${stem}" min="0" max="100" value="80" title="音量" disabled>
        </div>
        <div class="stem-waveform" id="waveform-${stem}">
          <canvas id="canvas-${stem}" width="400" height="80"></canvas>
        </div>
        <div class="stem-controls">
          <button class="play-action stem-play" data-stem="${stem}" disabled>播放</button>
          <button class="secondary-action stem-download" data-stem="${stem}" disabled>下载</button>
        </div>
      </div>`;
  }).join("");
  drawEmptyWaveforms();
}

function drawEmptyWaveforms() {
  currentStems.forEach((stem) => {
    const canvas = document.getElementById(`canvas-${stem}`);
    if (canvas) drawWaveform(canvas, new Array(100).fill(0.1));
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
    const barHeight = (value / maxValue) * (height - 10);
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
  setBusy(true);
  currentJobId = null;
  resetStemStates();
  resetMergedTrack();
  updateSelectionSummary();
  setStatus("正在上传", "Uploading", "正在上传音频文件到服务器...", 5);
  try {
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("model", modelSelect.value);
    formData.append("stemCount", stemCountSelect.value);
    const response = await fetch("/api/stems", { method: "POST", body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "分轨任务创建失败。");
    currentJobId = data.jobId;
    pollJobStatus(data.jobId);
  } catch (error) {
    setStatus("创建任务失败", "Error", error.message, 0, true);
    setBusy(false);
  }
}

async function pollJobStatus(jobId) {
  let attempts = 0;
  const poll = async () => {
    if (attempts >= 300) {
      setStatus("处理超时", "Error", "分轨处理时间过长，请稍后重试。", 0, true);
      setBusy(false);
      return;
    }
    try {
      const response = await fetch(`/api/status/${jobId}`);
      const status = await response.json();
      if (status.status === "completed") return handleCompletion(jobId, status);
      if (status.status === "error") {
        setStatus("处理失败", "Error", status.error || "分轨处理失败。", 0, true);
        setBusy(false);
        return;
      }
      setStatus("处理中", "Processing", `正在使用 ${status.model || modelSelect.value} 模型分离 ${status.stemCount || stemCountSelect.value} 轨...`, Math.min(status.progress || 10, 95));
      attempts++;
      setTimeout(poll, 1000);
    } catch {
      attempts++;
      setTimeout(poll, 2000);
    }
  };
  poll();
}

function handleCompletion(jobId, status) {
  setStatus("分轨完成", "Completed", "所有音轨已成功分离，可以播放、下载或合并。", 100);
  const stems = Object.keys(status.stems || {});
  if (!stems.length) {
    setStatus("分离完成", "Warning", "未能获取部分音轨文件，请刷新重试。", 100, true);
    setBusy(false);
    return;
  }
  renderStemCards(stems);
  stems.forEach((stem) => enableStemControls(stem, jobId));
  downloadAllButton.disabled = false;
  document.getElementById("play-all-btn").disabled = false;
  document.getElementById("stop-all-btn").disabled = false;
  masterProgress.disabled = false;
  mergePanel.hidden = false;
  mergeToggleButton.disabled = false;
  setBusy(false);
}

function enableStemControls(stem, jobId) {
  document.querySelector(`.stem-play[data-stem="${stem}"]`).disabled = false;
  document.querySelector(`.stem-download[data-stem="${stem}"]`).disabled = false;
  document.querySelector(`.stem-mute[data-stem="${stem}"]`).disabled = false;
  document.querySelector(`.stem-volume[data-stem="${stem}"]`).disabled = false;
  document.querySelector(`.merge-check[data-stem="${stem}"]`).disabled = false;
  initAudioContext();
  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  audio.playsInline = true;
  const gainNode = audioContext.createGain();
  const sourceNode = audioContext.createMediaElementSource(audio);
  gainNode.gain.value = 0.8;
  audio.src = `/api/download/${jobId}/${stem}`;
  sourceNode.connect(gainNode);
  gainNode.connect(masterGain);
  stemAudios[stem] = audio;
  stemGains[stem] = gainNode;
  stemSources[stem] = sourceNode;
  loadWaveformData(stem).then((data) => {
    const canvas = document.getElementById(`canvas-${stem}`);
    if (canvas && data) drawWaveform(canvas, data);
  });
  audio.addEventListener("loadedmetadata", updateMasterTime);
  audio.addEventListener("timeupdate", updateMasterTime);
  audio.addEventListener("ended", updateMasterTime);
  audio.addEventListener("error", () => reportPlaybackError(`音轨 ${stem} 无法播放`, new Error(audio.error ? `媒体错误码 ${audio.error.code}` : "媒体加载失败")));
}

async function loadWaveformData(stem) {
  if (!audioContext || !currentJobId) return null;
  try {
    const response = await fetch(`/api/download/${currentJobId}/${stem}`);
    const audioBuffer = await audioContext.decodeAudioData(await response.arrayBuffer());
    const rawData = audioBuffer.getChannelData(0);
    const samples = 100;
    const blockSize = Math.max(1, Math.floor(rawData.length / samples));
    const data = [];
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) sum += Math.abs(rawData[i * blockSize + j] || 0);
      data.push(sum / blockSize);
    }
    const maxVal = Math.max(...data, 0.01);
    return data.map((value) => value / maxVal);
  } catch (error) {
    console.error(`Failed to load waveform for ${stem}:`, error);
    return null;
  }
}

async function playAllStems() {
  stopMergedPlayback();
  const hasAnyPlaying = Object.values(stemAudios).some((audio) => !audio.paused);
  if (hasAnyPlaying) {
    Object.values(stemAudios).forEach((audio) => audio.pause());
    stopStemSyncTimer();
    updateMasterTime();
    return;
  }
  try {
    await ensureAudioContextRunning();
    const audios = Object.values(stemAudios);
    await Promise.all(audios.map((audio) => waitForCanPlay(audio)));
    const currentTime = getMasterCurrentTime();
    syncStemTimes(currentTime);
    await Promise.all(audios.map((audio) => audio.play()));
    startStemSyncTimer();
    updateMasterTime();
  } catch (error) {
    reportPlaybackError("音频上下文启动失败", error);
  }
}

function stopAllStems() {
  Object.values(stemAudios).forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
  stopStemSyncTimer();
  masterProgress.value = "0";
  updateMasterTime();
}

function toggleMuteAll() {
  const muted = !Object.values(stemGains).every((gain) => gain.gain.value === 0);
  Object.values(stemGains).forEach((gain) => { gain.gain.value = muted ? 0 : 0.8; });
  const muteBtn = document.getElementById("mute-all-btn");
  muteBtn.classList.toggle("is-muted", muted);
  muteBtn.querySelector(".btn-icon").textContent = muted ? "🔇" : "🔊";
  muteBtn.querySelector(".btn-text").textContent = muted ? "取消静音" : "静音";
  document.querySelectorAll(".stem-mute").forEach((btn) => {
    btn.classList.toggle("is-muted", muted);
    btn.textContent = muted ? "🔇" : "🔊";
  });
}

function toggleMute(stem) {
  const gain = stemGains[stem];
  const btn = document.querySelector(`.stem-mute[data-stem="${stem}"]`);
  if (!gain || !btn) return;
  const muted = gain.gain.value !== 0;
  gain.gain.value = muted ? 0 : Number(document.querySelector(`.stem-volume[data-stem="${stem}"]`)?.value || 80) / 100;
  btn.classList.toggle("is-muted", muted);
  btn.textContent = muted ? "🔇" : "🔊";
}

function setVolume(stem, value) {
  if (stemGains[stem]) stemGains[stem].gain.value = Math.max(0, Math.min(1, value));
}

async function toggleStemPlayback(stem) {
  const audio = stemAudios[stem];
  if (!audio) return;
  stopMergedPlayback();
  stopStemSyncTimer();
  if (audio.paused) {
    try {
      await ensureAudioContextRunning();
      await waitForCanPlay(audio);
      await audio.play();
    } catch (error) {
      reportPlaybackError(`音轨 ${stem} 播放失败`, error);
    }
  } else {
    audio.pause();
  }
  updateMasterTime();
}

function updateMasterTime() {
  const times = Object.values(stemAudios).map((audio) => audio.currentTime || 0);
  const durations = Object.values(stemAudios).map((audio) => audio.duration || 0);
  const maxTime = Math.max(...times, 0);
  const maxDuration = Math.max(...durations, 0);
  if (!isSeeking && maxDuration > 0) masterProgress.value = String(Math.round((maxTime / maxDuration) * 1000));
  document.getElementById("master-time").textContent = `${formatTime(maxTime)} / ${formatTime(maxDuration)}`;
  updatePlayButtons();
}

function syncProgressToAudios() {
  const maxDuration = Math.max(...Object.values(stemAudios).map((audio) => audio.duration || 0), 0);
  if (!maxDuration) return;
  const targetTime = (Number(masterProgress.value) / 1000) * maxDuration;
  Object.values(stemAudios).forEach((audio) => { audio.currentTime = targetTime; });
  updateMasterTime();
}

function syncStemTimes(targetTime) {
  Object.values(stemAudios).forEach((audio) => {
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(targetTime, Math.max(0, audio.duration - 0.05));
    }
  });
}

function startStemSyncTimer() {
  stopStemSyncTimer();
  stemSyncTimer = window.setInterval(() => {
    const playing = Object.values(stemAudios).filter((audio) => !audio.paused && !audio.ended);
    if (playing.length <= 1) {
      stopStemSyncTimer();
      return;
    }

    const masterTime = Math.min(...playing.map((audio) => audio.currentTime || 0));
    playing.forEach((audio) => {
      if (Math.abs((audio.currentTime || 0) - masterTime) > 0.08) {
        audio.currentTime = masterTime;
      }
    });
  }, 500);
}

function stopStemSyncTimer() {
  if (stemSyncTimer) {
    window.clearInterval(stemSyncTimer);
    stemSyncTimer = null;
  }
}

function getMasterCurrentTime() {
  return Math.max(...Object.values(stemAudios).map((audio) => audio.currentTime || 0), 0);
}

function updatePlayButtons() {
  const anyPlaying = Object.values(stemAudios).some((audio) => !audio.paused);
  const playAllBtn = document.getElementById("play-all-btn");
  playAllBtn.querySelector(".btn-icon").textContent = anyPlaying ? "⏸" : "▶";
  playAllBtn.querySelector(".btn-text").textContent = anyPlaying ? "暂停" : "播放";
  playAllBtn.classList.toggle("is-active", anyPlaying);
  document.querySelectorAll(".stem-play").forEach((btn) => {
    const audio = stemAudios[btn.dataset.stem];
    btn.textContent = audio && !audio.paused ? "暂停" : "播放";
  });
}

function downloadStem(stem) {
  if (currentJobId) window.location.href = `/api/download/${currentJobId}/${stem}?download=1`;
}

function updateMergeButtonState() {
  const count = getSelectedMergeStems().length;
  mergeStartButton.disabled = !currentJobId || count < 1;
  mergeCopy.textContent = count ? `已选择 ${count} 条音轨，点击开始合并。` : "勾选需要合并的音轨，然后点击开始合并。";
}

function getSelectedMergeStems() {
  return [...document.querySelectorAll(".merge-check:checked")].map((input) => input.dataset.stem);
}

async function mergeSelectedStems() {
  const stems = getSelectedMergeStems();
  if (!currentJobId || !stems.length) return;
  stopAllStems();
  resetMergedTrack();
  mergeStartButton.disabled = true;
  mergeCopy.textContent = "正在合并选中音轨...";
  let merged = false;
  try {
    const response = await fetch("/api/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: currentJobId, stems }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "合并失败。");
    setupMergedTrack(data.mergeId);
    merged = true;
    mergeCopy.textContent = `合并完成：${stems.join(", ")}`;
  } catch (error) {
    mergeCopy.textContent = error.message;
  } finally {
    mergeStartButton.disabled = !merged && getSelectedMergeStems().length < 1;
  }
}

function setupMergedTrack(id) {
  mergedId = id;
  initAudioContext();
  mergedAudio = new Audio(`/api/download/${currentJobId}/${id}`);
  mergedAudio.crossOrigin = "anonymous";
  mergedAudio.preload = "auto";
  mergedAudio.playsInline = true;
  mergedGain = audioContext.createGain();
  mergedSource = audioContext.createMediaElementSource(mergedAudio);
  mergedSource.connect(mergedGain);
  mergedGain.connect(masterGain);
  mergedAudio.addEventListener("timeupdate", updateMergedTime);
  mergedAudio.addEventListener("loadedmetadata", updateMergedTime);
  mergedAudio.addEventListener("ended", updateMergedTime);
  mergedPlayer.hidden = false;
}

async function toggleMergedPlayback() {
  if (!mergedAudio) return;
  stopAllStems();
  if (mergedAudio.paused) {
    try {
      await ensureAudioContextRunning();
      await waitForCanPlay(mergedAudio);
      await mergedAudio.play();
    } catch (error) {
      reportPlaybackError("合并音轨播放失败", error);
      return;
    }
  } else {
    mergedAudio.pause();
  }
  updateMergedTime();
}

function stopMergedPlayback() {
  if (mergedAudio) mergedAudio.pause();
  updateMergedTime();
}

function waitForCanPlay(audio) {
  if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("音频加载超时"));
    }, 15000);
    const cleanup = () => {
      window.clearTimeout(timer);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("loadeddata", onCanPlay);
      audio.removeEventListener("error", onError);
    };
    const onCanPlay = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(audio.error ? `媒体错误码 ${audio.error.code}` : "音频加载失败"));
    };
    audio.addEventListener("canplay", onCanPlay, { once: true });
    audio.addEventListener("loadeddata", onCanPlay, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.load();
  });
}

function updateMergedTime() {
  if (!mergedAudio) return;
  if (!mergedSeeking && mergedAudio.duration > 0) {
    mergedProgress.value = String(Math.round((mergedAudio.currentTime / mergedAudio.duration) * 1000));
  }
  mergedTime.textContent = `${formatTime(mergedAudio.currentTime)} / ${formatTime(mergedAudio.duration)}`;
  mergedPlayButton.textContent = mergedAudio.paused ? "播放合并音轨" : "暂停合并音轨";
}

function syncMergedProgressToAudio() {
  if (!mergedAudio?.duration) return;
  mergedAudio.currentTime = (Number(mergedProgress.value) / 1000) * mergedAudio.duration;
  updateMergedTime();
}

function resetMergedTrack() {
  if (mergedAudio) {
    mergedAudio.pause();
    mergedAudio.src = "";
  }
  if (mergedSource) mergedSource.disconnect();
  if (mergedGain) mergedGain.disconnect();
  mergedAudio = null;
  mergedSource = null;
  mergedGain = null;
  mergedId = null;
  mergedProgress.value = "0";
  mergedTime.textContent = "0:00 / 0:00";
  mergedPlayer.hidden = true;
}

function resetStemStates() {
  Object.values(stemAudios).forEach((audio) => {
    audio.pause();
    audio.src = "";
  });
  stopStemSyncTimer();
  Object.values(stemGains).forEach((gain) => gain.disconnect());
  Object.values(stemSources).forEach((source) => source.disconnect());
  stemAudios = {};
  stemGains = {};
  stemSources = {};
  currentStems = STEMS_BY_COUNT[Number(stemCountSelect.value)] || STEMS_BY_COUNT[4];
  renderStemCards(currentStems);
  masterProgress.disabled = true;
  masterProgress.value = "0";
  document.getElementById("master-time").textContent = "0:00 / 0:00";
  document.getElementById("play-all-btn").disabled = true;
  document.getElementById("stop-all-btn").disabled = true;
  const muteBtn = document.getElementById("mute-all-btn");
  muteBtn.classList.remove("is-muted");
  muteBtn.querySelector(".btn-icon").textContent = "🔊";
  muteBtn.querySelector(".btn-text").textContent = "静音";
  downloadAllButton.disabled = true;
  mergePanel.hidden = true;
  mergeToggleButton.disabled = true;
  mergeStartButton.disabled = true;
  mergeToggleButton.textContent = "选择合并轨道";
  mergeCopy.textContent = "勾选需要合并的音轨，然后点击开始合并。";
  mergeMode = false;
}

function setBusy(isBusy) {
  separateButton.disabled = isBusy || !selectedFile;
  input.disabled = isBusy;
  modelSelect.disabled = isBusy;
  stemCountSelect.disabled = isBusy;
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
  const rest = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncateFileName(name, maxLength = 20) {
  if (name.length <= maxLength) return name;
  const ext = name.split(".").pop();
  const base = name.slice(0, name.length - ext.length - 1);
  return `${base.slice(0, maxLength - ext.length - 4)}...${ext}`;
}
