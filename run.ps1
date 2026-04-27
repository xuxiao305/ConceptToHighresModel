# Concept to Highres Model — One-click launcher
#
# 功能：
#   1. 检查 Node.js / npm 是否安装
#   2. 如果 node_modules 不存在则自动 npm install
#   3. 启动 Vite 开发服务器
#   4. 自动在默认浏览器打开 http://localhost:5173/
#
# 用法：
#   双击 run.bat 即可（推荐），或在 PowerShell 中运行：
#     .\run.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Concept to Highres Model — UI Mockup" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Node.js
try {
    $nodeVer = node --version 2>$null
    Write-Host "[✓] Node.js $nodeVer" -ForegroundColor Green
}
catch {
    Write-Host "[✗] Node.js 未安装" -ForegroundColor Red
    Write-Host "    请前往 https://nodejs.org/ 下载安装 LTS 版本" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit 1
}

# 2. Install dependencies if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "[…] 首次运行，正在安装依赖（约需 30 秒）..." -ForegroundColor Yellow
    npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[✗] 依赖安装失败" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit 1
    }
    Write-Host "[✓] 依赖安装完成" -ForegroundColor Green
}
else {
    Write-Host "[✓] 依赖已就绪" -ForegroundColor Green
}

Write-Host ""
Write-Host "[→] 启动开发服务器..." -ForegroundColor Cyan
Write-Host "    地址: http://localhost:5173/" -ForegroundColor White
Write-Host "    按 Ctrl+C 停止服务" -ForegroundColor Gray
Write-Host ""

# 3. Open browser after a short delay (background)
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:5173/"
} | Out-Null

# 4. Start Vite (foreground, blocks until Ctrl+C)
npm run dev
