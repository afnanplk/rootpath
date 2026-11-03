@echo off
cd /d "%~dp0"
if exist "release\win-unpacked\Rootpath.exe" (
  start "" "release\win-unpacked\Rootpath.exe"
  exit /b
)
if not exist node_modules (
  echo Run npm install and npm run build in this folder first.
  pause
  exit /b 1
)
if not exist dist (
  echo Run npm run build in this folder first.
  pause
  exit /b 1
)
call npm start
if errorlevel 1 pause
