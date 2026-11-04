@echo off
title ORVEX
setlocal
cd /d "%~dp0"

rem IDE terminals sometimes export this; it turns Electron into plain Node and crashes the app.
set "ELECTRON_RUN_AS_NODE="

rem 1) Prefer the packaged build: no rebuild, starts in seconds.
rem    "Start-ORVEX.bat debug" also opens port 9222 so the UI checks can attach.
if exist "release\win-unpacked\ORVEX.exe" (
  if /i "%~1"=="debug" (
    echo Starting packaged ORVEX with CDP on 9222...
    start "" "release\win-unpacked\ORVEX.exe" --remote-debugging-port=9222
  ) else (
    echo Starting packaged ORVEX...
    start "" "release\win-unpacked\ORVEX.exe"
  )
  exit /b 0
)

rem 2) No packaged build yet: install (if needed), build and launch from source.
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
