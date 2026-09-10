param([string]$Python = 'python',[switch]$Upload,[string]$Port)
$ErrorActionPreference='Stop'
$projectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectPath
try { & node tools/generate-firmware-profile.mjs --check; if ($LASTEXITCODE -ne 0) { throw 'GPIO profile is stale' } } finally { Pop-Location }
$letter = @('R','S','T','U','V','W','X','Y','Z') | Where-Object { -not (Test-Path ($_ + ':\')) } | Select-Object -First 1
if (-not $letter) { throw '空きドライブ文字がありません。ASCIIのみのパスへProjectをコピーしてビルドしてください。' }
$drive = $letter + ':'
& subst.exe $drive $projectPath
if ($LASTEXITCODE -ne 0) { throw '一時ドライブの作成に失敗しました' }
$previousPythonPath=$env:PYTHONPATH
$previousCore=$env:PLATFORMIO_CORE_DIR
try {
  if (Test-Path "$drive/.tools/python") { $env:PYTHONPATH="$drive/.tools/python" }
  $env:PLATFORMIO_CORE_DIR="$drive/.tools/platformio"
  $arguments=@('-m','platformio','run','-e','xiao_s3_plus','-d',"$drive/firmware")
  if ($Upload) { if (-not $Port) { throw '-Uploadには-Port COM番号が必要です' }; $arguments+=@('-t','upload','--upload-port',$Port) }
  & $Python @arguments
  if ($LASTEXITCODE -ne 0) { throw 'ファームウェアのビルドに失敗しました' }
} finally {
  $env:PYTHONPATH=$previousPythonPath
  $env:PLATFORMIO_CORE_DIR=$previousCore
  & subst.exe $drive /D
}
