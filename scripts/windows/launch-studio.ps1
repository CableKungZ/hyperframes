<#
  HyperFrames Studio launcher for Windows.
  Double-click "HyperFrames Studio.bat" at the repo root; this script:
    1. checks Node.js and Bun,
    2. installs dependencies and builds on first run (and again when sources change),
    3. asks for a project folder once (remembered afterwards; empty folder = new project),
    4. starts Studio and opens it in the browser.
  Flags: -ChooseProject (pick another folder), -Rebuild (force a build), -InstallShortcut.
#>
param(
  [switch]$ChooseProject,
  [switch]$Rebuild,
  [switch]$InstallShortcut
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root
$Host.UI.RawUI.WindowTitle = 'HyperFrames Studio'

$ConfigDir = Join-Path $env:APPDATA 'HyperFramesStudio'
$ConfigFile = Join-Path $ConfigDir 'config.json'
$StampFile = Join-Path $Root '.hyperframes-launcher-build'
$Cli = Join-Path $Root 'packages\cli\bin\hyperframes.mjs'

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Stop-WithMessage([string]$Text) {
  Say ''
  Say $Text 'Red'
  Say ''
  Read-Host 'กด Enter เพื่อปิด'
  exit 1
}

function Invoke-Step([string]$Title, [scriptblock]$Action) {
  Say ''
  Say "==> $Title" 'Cyan'
  $global:LASTEXITCODE = 0
  & $Action
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Stop-WithMessage "ขั้นตอน '$Title' ล้มเหลว (exit $LASTEXITCODE)" }
}

if ($InstallShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktop 'HyperFrames Studio.lnk'))
  $link.TargetPath = Join-Path $Root 'HyperFrames Studio.bat'
  $link.WorkingDirectory = $Root
  $icon = Join-Path $Root 'packages\studio\public\favicon.ico'
  if (Test-Path $icon) { $link.IconLocation = $icon }
  $link.Save()
  Say 'สร้างทางลัด "HyperFrames Studio" บนเดสก์ท็อปแล้ว' 'Green'
  Start-Sleep -Seconds 2
  exit 0
}

# ── 1. Tools ────────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithMessage 'ไม่พบ Node.js: ติดตั้งเวอร์ชัน 22 หรือ 24 จาก https://nodejs.org แล้วเปิดใหม่'
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Say 'ไม่พบ Bun: กำลังติดตั้งให้...' 'Yellow'
  Invoke-Step 'ติดตั้ง Bun' { powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex' }
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Stop-WithMessage 'ติดตั้ง Bun ไม่สำเร็จ: ดู https://bun.sh' }
}

# ── 2. Install + build ──────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Invoke-Step 'ติดตั้ง dependencies (ครั้งแรกเท่านั้น)' { bun install }
}

function Get-SourceStamp {
  $dirs = 'packages\cli\src', 'packages\studio\src', 'packages\studio-server\src', 'packages\core\src', 'packages\producer\src', 'packages\engine\src'
  $newest = Get-ChildItem -Path ($dirs | ForEach-Object { Join-Path $Root $_ }) -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '\.test\.' } |
    ForEach-Object { $_.LastWriteTimeUtc.Ticks } |
    Measure-Object -Maximum
  return [string]$newest.Maximum
}

$stamp = Get-SourceStamp
$built = (Test-Path (Join-Path $Root 'packages\cli\dist\cli.js')) -and (Test-Path (Join-Path $Root 'packages\studio\dist\index.html'))
$lastStamp = if (Test-Path $StampFile) { (Get-Content $StampFile -Raw).Trim() } else { '' }
if ($Rebuild -or -not $built -or $lastStamp -ne $stamp) {
  Say 'กำลัง build (ครั้งแรกอาจใช้เวลาหลายนาที)...' 'Yellow'
  Invoke-Step 'Build' { bun run build }
  # The build regenerates a few files under src, so stamp what it left behind.
  Set-Content -Path $StampFile -Value (Get-SourceStamp) -Encoding UTF8
}

# ── 3. Project folder ───────────────────────────────────────────────────────
function Test-Project([string]$Dir) {
  return $Dir -and (Test-Path $Dir) -and ((Test-Path (Join-Path $Dir 'index.html')) -or (Test-Path (Join-Path $Dir 'hyperframes.json')))
}

$config = @{}
if (Test-Path $ConfigFile) {
  try { (Get-Content $ConfigFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $config[$_.Name] = $_.Value } } catch { }
}
$project = $config['lastProject']

if ($ChooseProject -or -not (Test-Project $project)) {
  Add-Type -AssemblyName System.Windows.Forms
  $defaultRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'HyperFrames'
  New-Item -ItemType Directory -Force -Path $defaultRoot | Out-Null
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'เลือกโฟลเดอร์โปรเจกต์วิดีโอ (เลือกโฟลเดอร์ว่าง หรือกด Make New Folder เพื่อสร้างโปรเจกต์ใหม่)'
  $dialog.SelectedPath = if ($project -and (Test-Path $project)) { $project } else { $defaultRoot }
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
  $project = $dialog.SelectedPath

  if (-not (Test-Project $project)) {
    $isEmpty = -not (Get-ChildItem -Path $project -Force | Select-Object -First 1)
    if ($isEmpty) {
      $parent = Split-Path $project -Parent
      $name = Split-Path $project -Leaf
    } else {
      # A folder that already holds other files: make the project inside it.
      $parent = $project
      $name = 'video-' + (Get-Date -Format 'yyyyMMdd-HHmm')
      $project = Join-Path $parent $name
    }
    Push-Location $parent
    try {
      Invoke-Step "สร้างโปรเจกต์ใหม่: $project" { node $Cli init $name --non-interactive --example blank --skip-skills }
    } finally { Pop-Location }
  }

  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  $config['lastProject'] = $project
  $config | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
}

# ── 4. AI check (informational) ─────────────────────────────────────────────
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Say 'AI: พบ Claude Code (ใช้ Subscription ที่ล็อกอินไว้)' 'Green'
} else {
  Say 'AI: ยังไม่พบ Claude Code. ติดตั้งด้วย  npm install -g @anthropic-ai/claude-code  แล้วรัน  claude  หนึ่งครั้งเพื่อล็อกอิน' 'Yellow'
}

# ── 5. Start Studio ─────────────────────────────────────────────────────────
Say ''
Say "เปิด Studio: $project" 'Green'
Say 'ปิดหน้าต่างนี้ หรือกด Ctrl+C เพื่อหยุด Studio' 'DarkGray'
node $Cli preview $project --foreground
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Stop-WithMessage "Studio หยุดทำงาน (exit $LASTEXITCODE)" }
