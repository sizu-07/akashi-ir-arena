@echo off
setlocal
set "player=%~1"
if not "%player%"=="1" if not "%player%"=="2" if not "%player%"=="3" if not "%player%"=="4" goto usage
if "%~2"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\flash-player-game.ps1" -Player %player%
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\flash-player-game.ps1" -Player %player% -Port "%~2"
)
exit /b %errorlevel%
:usage
echo Usage: flash-player.cmd PLAYER [COM]
echo Example: flash-player.cmd 1
echo Example: flash-player.cmd 2 COM5
exit /b 2
