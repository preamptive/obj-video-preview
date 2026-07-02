@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies for the first time, this may take a minute...
  call npm install
)

echo Starting OBJ Video Preview...
call npm run dev -- --open
pause
