@echo off
title ORVEX
setlocal
cd /d "%~dp0"

rem IDE terminals sometimes export this; it turns Electron into plain Node and crashes the app.
set "ELECTRON_RUN_AS_NODE="

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js / npm not found. Install Node.js 20+ first.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto fail
)

echo Building ORVEX...
call npm run build
if errorlevel 1 goto fail

echo Launching ORVEX...
call npx --no-install electron .
if errorlevel 1 goto fail

exit /b 0

:fail
echo.
echo ORVEX failed to start. Read the messages above.
pause
exit /b 1
