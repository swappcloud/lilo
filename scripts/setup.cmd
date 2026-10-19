@echo off
rem One-command setup for Windows. Installs Node 22 when missing, then hands
rem over to scripts/setup.mjs (Rust, MSVC build tools, WebView2, npm install).
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 is required. Installing it with winget...
  winget install --id OpenJS.NodeJS.22 --exact --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo Failed to install Node.js — get it from https://nodejs.org and run setup.cmd again.
    exit /b 1
  )
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)

node "%~dp0setup.mjs"
exit /b %errorlevel%
