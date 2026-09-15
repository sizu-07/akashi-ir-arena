@echo off
cd /d "%~dp0"
if not exist config\ticket-local.json call npm run ticket:setup
npm run ticket:start
pause
