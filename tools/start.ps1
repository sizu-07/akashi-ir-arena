param([switch]$Demo)
$ErrorActionPreference='Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$nodeCommand=Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js 20以上をインストールしてから開き直してください。' }
if (-not (Test-Path 'node_modules/aedes')) { throw '先に npm install または pnpm install を実行してください。' }
& node tools/setup.mjs
if ($Demo) { & node apps/server/main.mjs --demo } else { & node apps/server/main.mjs }
