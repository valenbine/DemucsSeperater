# 用户指令记忆

本文件记录了用户的指令、偏好和教导，用于在未来的交互中提供参考。

## 格式

### 用户指令条目
用户指令条目应遵循以下格式：

[用户指令摘要]
- Date: [YYYY-MM-DD]
- Context: [提及的场景或时间]
- Instructions:
  - [用户教导或指示的内容，逐行描述]

### 项目知识条目
Agent 在任务执行过程中发现的条目应遵循以下格式：

[项目知识摘要]
- Date: [YYYY-MM-DD]
- Context: Agent 在执行 [具体任务描述] 时发现
- Category: [代码结构|代码模式|代码生成|构建方法|测试方法|依赖关系|环境配置]
- Instructions:
  - [具体的知识点，逐行描述]

## 去重策略
- 添加新条目前，检查是否存在相似或相同的指令
- 若发现重复，跳过新条目或与已有条目合并
- 合并时，更新上下文或日期信息
- 这有助于避免冗余条目，保持记忆文件整洁

## 条目

[按上述格式记录的记忆条目]

### DemucsSeperater 项目构建与发布流程
- Date: 2026-05-11
- Context: Agent 在执行 Windows 安装包、托盘程序、图标和 GitHub Actions 发布流程时发现
- Category: 构建方法
- Instructions:
  - 当前项目是 Node.js 前后端一体服务，后端入口为 `server.js`，前端入口为 `index.html` 和 `src/main.js`，本地可通过 `PORT=8050 NO_AUTO_OPEN=1 npm start` 预览，也可默认使用 `npm start` 监听 8000。
  - Windows 构建 workflow 位于 `.github/workflows/build-windows.yml`，使用 Node.js 24，并使用 `actions/checkout@v5`、`actions/setup-node@v5`，避免 Node.js 20 actions deprecation warning。
  - workflow 不再使用 `actions/upload-artifact`，Windows 产物通过 `gh release upload` 发布到滚动 Release `windows-latest`，包含 `DemucsSeperater-Setup-x64.exe` 和 `DemucsSeperater-windows-x64.zip`。
  - Windows 打包会用 `esbuild` 将 `server.js` 打包为 `dist/pkg/server.cjs`，再用 `pkg` 生成 `dist/DemucsSeperater.exe`。
  - Windows 安装器脚本位于 `build/windows-installer.iss`，使用 Inno Setup 编译 `DemucsSeperater-Setup-x64.exe`。

### DemucsSeperater Windows 托盘与运行时约定
- Date: 2026-05-11
- Context: Agent 在实现 Windows 托盘控制、FFmpeg 打包和运行时日志时发现
- Category: 环境配置
- Instructions:
  - Windows 安装版入口是 `DemucsSeperater-Tray.exe`，由 `packaging/windows/DemucsSeperater-Tray.ps1` 通过 `ps2exe` 编译生成；托盘菜单支持打开网页界面、启动服务、停止服务、重启服务、打开日志目录和退出。
  - 托盘程序启动并管理 `DemucsSeperater.exe` 后端服务，双击托盘图标会打开 `http://127.0.0.1:8000`，退出托盘时会停止后端服务。
  - Windows 日志目录为 `%LOCALAPPDATA%\DemucsSeperater\logs`，主要日志包含 `app.log`、`tray.log` 和 `launcher.log`。
  - 打包版运行数据目录为 `%LOCALAPPDATA%\DemucsSeperater`，运行时目录为 `%LOCALAPPDATA%\DemucsSeperater\.runtime`，Torch 模型缓存目录为 `%LOCALAPPDATA%\DemucsSeperater\torch`。
  - Windows 安装包内置 BtbN FFmpeg full-shared build，并将 `{app}\bin` 加入 PATH，同时设置 `FFMPEG_BINARY={app}\bin\ffmpeg.exe`，以满足 TorchCodec 对 FFmpeg shared DLL 的要求。

### DemucsSeperater 功能实现约定
- Date: 2026-05-11
- Context: Agent 在实现模型联动、多轨播放、合并和下载修复时发现
- Category: 代码模式
- Instructions:
  - `/api/models` 返回模型及支持的 `stemCounts`；`htdemucs_6s` 只允许 2 轨和 6 轨，其他模型只允许 2 轨和 4 轨；后端通过 `validateModelStemCount` 做强校验。
  - 2 轨分离使用 Demucs 参数 `--two-stems vocals`，输出 `vocals` 和 `no_vocals`；4 轨输出 `vocals/drums/bass/other`；6 轨输出 `vocals/drums/bass/guitar/piano/other`。
  - 合并接口为 `POST /api/merge`，使用内置或系统 `ffmpeg` 的 `amix` 生成 `merged_*.wav`，并通过 `/api/download/:jobId/:stem` 复用下载和播放逻辑。
  - 前端下载不能使用 `window.location.href`，应使用隐藏 iframe 的 `triggerDownload`，避免下载失败时当前页面跳到 404 或空白页。
  - 多轨播放使用独立 Audio 对象和 WebAudio gain 节点；播放全部前等待音轨可播放并同步 `currentTime`，播放过程中用轻量校准减少不同步；合并音轨播放和上方分轨播放互斥。

### DemucsSeperater 图标与品牌资源
- Date: 2026-05-11
- Context: Agent 在设计并接入 Windows 应用图标时发现
- Category: 代码生成
- Instructions:
  - 品牌图标源文件位于 `packaging/windows/DemucsSeperater.svg`，设计为深色圆角底、青绿到蓝紫渐变、唱片核心和分轨声波符号。
  - 图标生成脚本为 `scripts/generate-windows-icon.mjs`，依赖 `sharp` 和 `png-to-ico`，构建时生成 `dist/DemucsSeperater.ico` 和 `dist/DemucsSeperater-256.png`。
  - `DemucsSeperater.ico` 会用于托盘图标、`ps2exe` 编译图标、Inno Setup 安装器图标、开始菜单快捷方式和桌面快捷方式。

### KeyBeat 仓库确认
- Date: 2026-04-27
- Context: 用户确认 Chordinor 后续要评估接入 KeyBeat 时提供仓库地址
- Instructions:
  - 用户确认 KeyBeat 仓库为 `https://github.com/therealtxr/keybeat`。
  - KeyBeat 的 PyPI 包名为 `keybeat-txrr`，核心 API 为 `from keybeat import analyze_audio`，返回 `bpm, key, mode`。
  - 后续若接入 KeyBeat，应作为本地 BPM 和调性候选来源参与融合，不替代现有 librosa、Essentia、Aubio 或 Chordino 主流程。

### Chordinor 音频分析路线调整
- Date: 2026-04-27
- Context: 用户要求放弃 KeyBeat，仅加入 Aubio，并重新规划综合音频特征与和弦识别顺序
- Instructions:
  - 不要接入 KeyBeat；Aubio 只作为 BPM 和 beat 候选来源参与融合。
  - 最终分析流程应调整为后端收到上传音频后，先综合分析 librosa BPM/beat/key、Essentia BPM/beat/beat confidence、Aubio BPM/beat，融合得到 bpm、beatTimes、downbeatTimes、timeSignature、key、bpmCandidates、keyCandidates，再运行 Chordino 分析和弦，前端展示统一结果。
  - 走带条应增加当前和弦显示或悬浮详情，不恢复底部和弦片段列表。
  - 和弦片段很多时应考虑走带条虚拟化或 Canvas 渲染提升性能。
  - 移调后的 JSON 文件名应追加移调后缀，例如 `song-transpose-plus-2.json`。
  - 斜杠和弦移调时 bass note 也要随 root 一起移调，例如 `C/E` 升两个半音应为 `D/F#`。
  - `requirements.txt` 应显式加入 NumPy 兼容范围或当前版本约束。
  - 后续应输出真实 `beatTimes` 和 `barLines`，并在走带条展示节拍线和小节线。
  - 拍号估算仍是启发式，需要提供更可靠的改进方案并明确置信度来源。
  - 需要过滤短于一拍的和弦片段：若短片段在第一拍附近，用后方和弦补拍；否则优先用前方和弦补拍。实现时应优先使用融合后的 beat 网格而不是简单 `总时间/总拍数`，因为总拍数不准确会放大误差。

### 静态 Web 应用运行方式
- Date: 2026-04-25
- Context: Agent 在执行 Chordino 音乐和弦识别 Web 应用开发时发现并更新
- Category: 构建方法
- Instructions:
  - 当前项目是 Node.js 前后端一体服务，可通过 `npm start` 在仓库根目录启动预览，默认端口为 8000。
  - 后端入口位于 `server.js`，提供 `/api/health` 和 `/api/analyze`，并默认调用工作区 `.runtime/tools/sonic-annotator-1.7.0-linux64-static/squashfs-root/usr/bin/sonic-annotator` 加载 `.runtime/vamp/nnls-chroma.so` 的原生 Vamp Chordino 插件。
  - 原生 Chordino 工具链可通过 `scripts/setup-chordino.sh` 重新生成；该脚本下载官方 sonic-annotator 和 Vamp Plugin Pack，并提取 `nnls-chroma.so`，使 `/api/health` 返回可用。
  - 歌曲调性、BPM、拍号使用 `/api/audio-features` 调用 `analyze_audio.py` 的本地分析；`/api/song-meta` 只合并文件名解析与本地分析来源展示，不再调用 Spotify、SongBPM、iTunes 或 MusicBrainz。
  - librosa 用于 BPM 和调性估算；拍号优先使用 Essentia `RhythmExtractor2013(method="multifeature")` 的 beat 序列和重音周期启发式估算，Essentia 不可用或失败时回退到 librosa beat 序列。
  - 浏览器端回退识别逻辑位于 `src/chordino.js`，页面交互位于 `src/main.js`，样式位于 `styles.css`。
