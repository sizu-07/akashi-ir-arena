@echo off
cd /d "%~dp0"
set "ARENA_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "ARENA_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "node_modules\ws\package.json" goto dependencies_ready
echo Installing packages required for first launch...
where pnpm >nul 2>nul
if not errorlevel 1 goto install_with_pnpm
where npm >nul 2>nul
if not errorlevel 1 goto install_with_npm
echo Package installation requires Node.js 20 or later with npm or pnpm.
goto done
:install_with_pnpm
call pnpm install --frozen-lockfile
if errorlevel 1 goto done
goto dependencies_ready
:install_with_npm
call npm install --no-package-lock
if errorlevel 1 goto done
:dependencies_ready
"%ARENA_NODE%" tools/setup-ticket.mjs
if errorlevel 1 goto done
"%ARENA_NODE%" tools/start-ticket.mjs
:done
pause
