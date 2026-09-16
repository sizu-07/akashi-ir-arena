param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Demo', 'Production')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Resolve-NodeExecutable {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }

  throw 'Node.js 20 or later was not found. Install the LTS release from https://nodejs.org/.'
}

function Install-DependenciesIfNeeded {
  if (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\aedes\package.json')) { return }

  Write-Host 'Installing packages required for the first launch...'
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($pnpm) {
    & $pnpm.Source install --frozen-lockfile
  } elseif ($npm) {
    & $npm.Source install --no-package-lock
  } else {
    throw 'npm or pnpm was not found. Install the Node.js LTS release, which includes npm, and run this file again.'
  }
  if ($LASTEXITCODE -ne 0) { throw 'Package installation failed.' }
}

function Get-RunningGameState([int]$Port) {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -Method Get -TimeoutSec 2
  } catch {
    return $null
  }
}

function Stop-PreviousGameMode([int]$Port, [bool]$DemoRequested) {
  $running = Get-RunningGameState -Port $Port
  if ($null -eq $running -or [bool]$running.demo -eq $DemoRequested) { return }

  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $listener) {
    throw "Could not identify the previous server on port $Port. Stop Node.js in Task Manager, then try again."
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.Name -notmatch '^node(\.exe)?$' -or $process.CommandLine -notmatch 'apps[\\/]server[\\/]main\.mjs') {
    throw "Port $Port is used by another application. It will not be stopped automatically."
  }

  $oldMode = if ([bool]$running.demo) { 'demo' } else { 'production' }
  $newMode = if ($DemoRequested) { 'demo' } else { 'production' }
  Write-Host "Stopping the previous $oldMode server and switching to $newMode mode." -ForegroundColor Yellow
  Stop-Process -Id $listener.OwningProcess -Force
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    if ($null -eq (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return }
  }
  throw "Could not stop the previous server on port $Port."
}

try {
  $node = Resolve-NodeExecutable
  Install-DependenciesIfNeeded

  & $node 'tools/setup.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'Initial setup failed.' }

  $config = Get-Content -LiteralPath 'config/local.json' -Raw | ConvertFrom-Json
  Stop-PreviousGameMode -Port ([int]$config.httpPort) -DemoRequested ($Mode -eq 'Demo')
  if (-not $config.ticketServerUrl -or -not $config.ticketServerApiKey) {
    Write-Warning 'The public ticket server is not configured. The game UI will start without ticket integration.'
  }

  $arguments = @('apps/server/main.mjs', '--open')
  if ($Mode -eq 'Demo') { $arguments += '--demo' }
  & $node @arguments
  exit $LASTEXITCODE
} catch {
  Write-Host ''
  Write-Host ('Launch failed: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
