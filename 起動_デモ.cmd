@echo off
cd /d "%~dp0"
set "ARENA_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "ARENA_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%ARENA_NODE%" tools/setup.mjs
if errorlevel 1 goto done
"%ARENA_NODE%" apps/server/main.mjs --demo
:done
pause
