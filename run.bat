@echo off
REM Concept to Highres Model — One-click launcher (Windows double-click)
REM 双击此文件即可启动 Mockup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
pause
