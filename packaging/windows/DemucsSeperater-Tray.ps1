Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverExe = Join-Path $appDir "DemucsSeperater.exe"
$logDir = Join-Path $env:LOCALAPPDATA "DemucsSeperater\logs"
$launcherLog = Join-Path $logDir "tray.log"
$appLog = Join-Path $logDir "app.log"
$port = if ($env:PORT) { $env:PORT } else { "8000" }
$appUrl = "http://127.0.0.1:$port"
$serverProcess = $null

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}

function Write-TrayLog($message) {
  $line = "[{0}] {1}" -f (Get-Date).ToString("s"), $message
  Add-Content -Path $launcherLog -Value $line -Encoding UTF8
}

function Test-ServerRunning {
  return $null -ne $serverProcess -and -not $serverProcess.HasExited
}

function Start-Server {
  if (Test-ServerRunning) {
    return
  }

  if (-not (Test-Path $serverExe)) {
    [System.Windows.Forms.MessageBox]::Show("找不到服务程序: $serverExe", "DemucsSeperater", "OK", "Error") | Out-Null
    return
  }

  $env:PATH = "$appDir\bin;$env:PATH"
  $env:FFMPEG_BINARY = "$appDir\bin\ffmpeg.exe"

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $serverExe
  $startInfo.WorkingDirectory = $appDir
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  Write-TrayLog "Starting server: $serverExe"
  $script:serverProcess = New-Object System.Diagnostics.Process
  $script:serverProcess.StartInfo = $startInfo
  $script:serverProcess.EnableRaisingEvents = $true
  Register-ObjectEvent -InputObject $script:serverProcess -EventName OutputDataReceived -Action {
    if ($EventArgs.Data) { Add-Content -Path $Event.MessageData -Value $EventArgs.Data -Encoding UTF8 }
  } -MessageData $appLog | Out-Null
  Register-ObjectEvent -InputObject $script:serverProcess -EventName ErrorDataReceived -Action {
    if ($EventArgs.Data) { Add-Content -Path $Event.MessageData -Value $EventArgs.Data -Encoding UTF8 }
  } -MessageData $appLog | Out-Null
  Register-ObjectEvent -InputObject $script:serverProcess -EventName Exited -Action {
    Add-Content -Path $Event.MessageData -Value ("[{0}] Server exited" -f (Get-Date).ToString("s")) -Encoding UTF8
  } -MessageData $launcherLog | Out-Null

  [void]$script:serverProcess.Start()
  $script:serverProcess.BeginOutputReadLine()
  $script:serverProcess.BeginErrorReadLine()
}

function Stop-Server {
  if (-not (Test-ServerRunning)) {
    return
  }

  Write-TrayLog "Stopping server pid=$($serverProcess.Id)"
  try {
    $serverProcess.CloseMainWindow() | Out-Null
    if (-not $serverProcess.WaitForExit(3000)) {
      $serverProcess.Kill()
      $serverProcess.WaitForExit(3000)
    }
  } catch {
    Write-TrayLog "Failed to stop server: $($_.Exception.Message)"
  }
}

function Restart-Server {
  Stop-Server
  Start-Sleep -Milliseconds 500
  Start-Server
  Start-Sleep -Seconds 2
  Open-WebUi
}

function Open-WebUi {
  Start-Process $appUrl
}

function Open-Logs {
  Start-Process explorer.exe $logDir
}

function Update-MenuState {
  $isRunning = Test-ServerRunning
  $openItem.Enabled = $isRunning
  $startItem.Enabled = -not $isRunning
  $stopItem.Enabled = $isRunning
  $restartItem.Enabled = $true
  $notifyIcon.Text = if ($isRunning) { "DemucsSeperater 正在运行" } else { "DemucsSeperater 已停止" }
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true
$notifyIcon.Text = "DemucsSeperater"

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $contextMenu.Items.Add("打开网页界面")
$startItem = $contextMenu.Items.Add("启动服务")
$stopItem = $contextMenu.Items.Add("停止服务")
$restartItem = $contextMenu.Items.Add("重启服务")
$contextMenu.Items.Add("-") | Out-Null
$logsItem = $contextMenu.Items.Add("打开日志目录")
$exitItem = $contextMenu.Items.Add("退出")

$openItem.add_Click({ Open-WebUi })
$startItem.add_Click({ Start-Server; Start-Sleep -Seconds 2; Open-WebUi; Update-MenuState })
$stopItem.add_Click({ Stop-Server; Update-MenuState })
$restartItem.add_Click({ Restart-Server; Update-MenuState })
$logsItem.add_Click({ Open-Logs })
$exitItem.add_Click({
  Stop-Server
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.add_DoubleClick({ if (Test-ServerRunning) { Open-WebUi } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ Update-MenuState })
$timer.Start()

Write-TrayLog "Tray started from $appDir"
Start-Server
Start-Sleep -Seconds 2
Open-WebUi
Update-MenuState

[System.Windows.Forms.Application]::Run()
