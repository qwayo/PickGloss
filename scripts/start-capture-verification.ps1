param(
  [Parameter(Mandatory = $true)]
  [string]$CandidateRoot
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $CandidateRoot).Path
$manifestPath = Join-Path $root 'candidate-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw '候选包缺少 candidate-manifest.json。'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$executable = Join-Path (Join-Path $root $manifest.packageDirectory) 'PickGloss.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw '候选包缺少 PickGloss.exe。'
}
$expected = $manifest.files | Where-Object { $_.path -eq 'PickGloss.exe' } | Select-Object -First 1
if (-not $expected -or (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $expected.sha256) {
  throw 'PickGloss.exe 与候选包清单不一致。'
}
if (Get-Process -Name PickGloss -ErrorAction SilentlyContinue) {
  throw '发现正在运行的拾译。请用户先从托盘正常退出，再单独启动本次隔离验收包；脚本不会终止现有进程。'
}

$isolatedLocalAppData = Join-Path $env:TEMP ('pickgloss-ticket17-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $isolatedLocalAppData | Out-Null
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $executable
$start.WorkingDirectory = Split-Path -Parent $executable
$start.UseShellExecute = $false
$start.EnvironmentVariables['LOCALAPPDATA'] = $isolatedLocalAppData
$process = [System.Diagnostics.Process]::Start($start)
if (-not $process) { throw '候选包未能启动；隔离目录已保留。' }
Start-Sleep -Milliseconds 500
$process.Refresh()
if ($process.HasExited) { throw '候选包启动后已退出；隔离目录已保留，请核对单实例状态。' }

[pscustomobject]@{
  CandidateId = $manifest.candidateId
  AppPid = $process.Id
  IsolatedLocalAppData = $isolatedLocalAppData
  Executable = $executable
} | Format-List
Write-Host '仅此拾译子进程使用新的临时 LOCALAPPDATA；没有修改当前终端或用户级环境。验证结束后请从托盘正常退出。'
