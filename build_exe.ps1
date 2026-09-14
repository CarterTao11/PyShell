# PyShell one-file build script (no console window + tray icon)
# Usage:  .\build_exe.ps1
param(
    [string]$Icon = "pyshell.ico"   # set to "" to skip the exe icon
)
$ErrorActionPreference = "Stop"

# 旧 pyc 干扰过 Config 属性加载，构建前一律清掉
$pycache = Get-ChildItem backend -Recurse -Directory -Filter __pycache__ -ErrorAction SilentlyContinue
if ($pycache) {
    $pycache | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# 旧的 exe 若还在运行会锁住输出文件
$stale = Get-Process PyShell -ErrorAction SilentlyContinue
if ($stale) {
    $stale | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

$root = $PSScriptRoot
$iconArgs = @()
if ($Icon -and (Test-Path (Join-Path $root $Icon))) {
    $iconArgs = @("-i", (Join-Path $root $Icon))
    Write-Host "exe icon: $Icon"
} else {
    Write-Host "no exe icon found ($Icon) - building without one"
}

# 注意：--hidden-import pystray._win32 是托盘图标的必需项
#       （pystray 运行时才动态导入 win32 后端，PyInstaller 静态分析发现不了）
& (Join-Path $root ".venv\Scripts\pyinstaller.exe") `
    --clean --noconfirm --onefile --windowed --name PyShell `
    @iconArgs `
    --add-data "$(Join-Path $root 'web');web" `
    --add-data "$(Join-Path $root 'pyshell.ico');." `
    --paths backend `
    --hidden-import pystray._win32 `
    backend\app.py

if ($LASTEXITCODE -ne 0) { Write-Error "pyinstaller failed"; exit 1 }

Write-Host ""
Write-Host "Build OK -> $root\dist\PyShell.exe"
Write-Host "data dir : dist\data\  (db / sessions / pyshell.log)"
