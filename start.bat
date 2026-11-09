@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установи его с https://nodejs.org (кнопка LTS^) и запусти этот файл ещё раз.
  start https://nodejs.org
  pause
  exit /b
)
start "" http://localhost:3000
node server.js
pause
