@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python, then run this file again.
  pause
  exit /b 1
)
start "Daybook local server" /min python -m http.server 8080 --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" http://localhost:8080/?v=7
