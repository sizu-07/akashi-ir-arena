param([Parameter(Mandatory=$true)][ValidateRange(1,4)][int]$Player,[string]$Port,[string]$Python)
$ErrorActionPreference='Stop'
$projectPath=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectPath
try {
  if(-not $Python){
    $bundled=Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
    if(Test-Path -LiteralPath $bundled){$Python=$bundled}else{$Python='python'}
  }
  $device='gun-00'+$Player
  $settings=Join-Path $projectPath "config/provision/players-4e/$device.json"
  if(-not(Test-Path -LiteralPath $settings)){throw '先に node tools/prepare-player-settings.mjs を実行してください。'}
  $config=Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
  if($config.id -ne $device -or $config.hardwareProfile -ne 'xiao-s3-plus-3rx-6led-motor-trigger' -or $config.bench -ne $false){throw 'プレイヤー設定・構成・bench=falseを確認してください。'}
  Write-Host "player$Player / $device / 組み立て済み4E基板（LED GPIO42）の完全ゲーム版を書き込みます。"
  Write-Host '対象のXIAO ESP32-S3 PlusをUSBだけで接続し、シリアルモニターを停止してください。'
  if((Read-Host '対象と接続を確認したら YES を入力') -cne 'YES'){throw '書き込みを中止しました。'}
  if(-not $Port){Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Description | Format-Table;$Port=Read-Host '対象のCOM番号'}
  if($Port -notmatch '^COM[1-9][0-9]*$'){throw 'COM番号が不正です'}
  & "$PSScriptRoot/build-firmware.ps1" -Environment "player${Player}_game" -Python $Python -Upload -Port $Port
  if($LASTEXITCODE -ne 0){throw '書き込みに失敗しました'}
  $runtimePort=Read-Host '実行用COM番号（変わらなければEnter）'
  if($runtimePort){if($runtimePort -notmatch '^COM[1-9][0-9]*$'){throw 'COM番号が不正です'};$Port=$runtimePort}
  $previousPythonPath=$env:PYTHONPATH
  try {
    if(Test-Path '.tools/python'){$env:PYTHONPATH=(Resolve-Path '.tools/python').Path}
    & $Python "$PSScriptRoot/provision.py" --port $Port --file $settings
    if($LASTEXITCODE -ne 0){throw '端末設定の保存に失敗しました'}
  }finally{$env:PYTHONPATH=$previousPythonPath}
  Write-Host "player$Player の書き込み・設定保存が完了しました。実ゲームは 起動_本番.cmd で確認してください。"
}finally{Pop-Location}
