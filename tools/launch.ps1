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

try {
  $node = Resolve-NodeExecutable
  Install-DependenciesIfNeeded

  & $node 'tools/setup.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'Initial setup failed.' }

  $config = Get-Content -LiteralPath 'config/local.json' -Raw | ConvertFrom-Json
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
