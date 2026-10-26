param(
  [Parameter(Mandatory=$true)][ValidateRange(1,4)][int]$Player,
  [string]$Port,
  [string]$Python,
  [switch]$NoProvision,
  [switch]$DryRun
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$device='gun-00'+$Player
$release=Join-Path $root "firmware/release/players-4e/player$Player"
$manifestPath=Join-Path $release 'manifest.json'
$hashPath=Join-Path $release 'sha256.json'
$settings=Join-Path $root "config/provision/players-4e/$device.json"

if(-not $Python){
  $bundled=Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
  $Python=if(Test-Path -LiteralPath $bundled){$bundled}else{'python'}
}
if(-not(Get-Command $Python -ErrorAction SilentlyContinue)){throw 'Pythonが見つかりません。-Python でPython実行ファイルを指定してください。'}
if(-not(Test-Path -LiteralPath $manifestPath) -or -not(Test-Path -LiteralPath $hashPath)){throw "player$Player の保存済みファームウェアがありません。"}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$hashes=Get-Content -LiteralPath $hashPath -Raw | ConvertFrom-Json
if($manifest.player -ne $Player -or $manifest.deviceId -ne $device -or -not $manifest.firmwareVersion -or $manifest.chip -ne 'esp32s3' -or $manifest.flashMB -ne 16 -or $manifest.hardwareProfile -ne 'xiao-s3-plus-3rx-6led-motor-trigger'){throw '保存済みファームウェアの対象・版・基板が一致しません。'}
$images=@(
  @{Name='bootloader.bin';Offset='0x0'},
  @{Name='partitions.bin';Offset='0x8000'},
  @{Name='boot_app0.bin';Offset='0xe000'},
  @{Name='firmware.bin';Offset='0x10000'}
)
function Get-Sha256([string]$file) {
  $stream=[System.IO.File]::OpenRead($file)
  $algorithm=[System.Security.Cryptography.SHA256]::Create()
  try {[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
  finally {$algorithm.Dispose();$stream.Dispose()}
}
foreach($image in $images){
  $file=Join-Path $release $image.Name
  if(-not(Test-Path -LiteralPath $file)){throw "書き込みファイルがありません: $($image.Name)"}
  $actual=Get-Sha256 $file
  if($actual -ne $hashes.($image.Name)){throw "ファイルのSHA-256が一致しません: $($image.Name)"}
}
if(-not $NoProvision){
  if(-not(Test-Path -LiteralPath $settings)){
    $base=Join-Path $root 'config/provision/gun-001.json'
    $local=Join-Path $root 'config/local.json'
    if(-not(Test-Path -LiteralPath $base) -or -not(Test-Path -LiteralPath $local)){throw 'Wi-Fi設定がありません。先にメインPCでWi-Fi設定を作成してください。'}
    Write-Host '4台分の保存済み設定を生成します。'
    Push-Location $root
    try {& node tools/prepare-player-settings.mjs;if($LASTEXITCODE -ne 0){throw '設定の生成に失敗しました'}}
    finally {Pop-Location}
  }
  $config=Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
  if($config.id -ne $device -or $config.hardwareProfile -ne 'xiao-s3-plus-3rx-6led-motor-trigger' -or $config.bench -ne $false -or -not $config.key){throw '端末ID・基板・ゲーム用設定が一致しません。'}
}

if($Port -and $Port -notmatch '^COM[1-9][0-9]*$'){throw 'COM番号は COM3 のように指定してください。'}
if(-not $Port -and -not $DryRun){
  $ports=@([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique)
  if($ports.Count -eq 0){throw 'COMポートがありません。対象端末をUSB接続し、必要ならBOOTを押しながら接続してください。'}
  if($ports.Count -ne 1){throw "COMポートが複数あります: $($ports -join ', ')。対象端末だけ接続するか、第2引数でCOM番号を指定してください。"}
  $Port=$ports[0]
}
if(-not $DryRun -and $Port -notin @([System.IO.Ports.SerialPort]::GetPortNames())){throw "$Port がWindowsに表示されていません。USB接続とシリアルモニターを確認してください。"}
$initialPorts=@([System.IO.Ports.SerialPort]::GetPortNames())

$portLabel=if($Port){$Port}else{'未指定'}
Write-Host "対象: player$Player ($device) / $($manifest.firmwareVersion) / $portLabel"
Write-Host '接続した基板のplayer番号を確認し、シリアルモニターを閉じてください。'
if($DryRun){Write-Host 'DRY RUN: ファイルと設定を確認しました。書き込みは実行していません。';exit 0}

$previousPythonPath=$env:PYTHONPATH
try {
  $packagePath=Join-Path $root '.tools/python'
  $esptool=Join-Path $root '.tools/platformio/packages/tool-esptoolpy/esptool.py'
  if(Test-Path -LiteralPath $esptool){
    $env:PYTHONPATH=$packagePath+[IO.Path]::PathSeparator+$previousPythonPath
    $esptoolArgs=@($esptool)
  }else{
    $flashTools=Join-Path $root '.tools/flash-python'
    if(-not(Test-Path -LiteralPath (Join-Path $flashTools 'esptool/__main__.py'))){
      Write-Host '初回のみ書き込みツールを準備します。'
      & $Python -m pip install --target $flashTools 'esptool==4.5.1' 'pyserial==3.5'
      if($LASTEXITCODE -ne 0){throw '書き込みツールの準備に失敗しました。ネット接続を確認してください。'}
    }
    $env:PYTHONPATH=$flashTools+[IO.Path]::PathSeparator+$previousPythonPath
    $esptoolArgs=@('-m','esptool')
  }
  $noStub=$false
  foreach($connectionMode in @('normal','rom')){
    $connectionArgs=if($connectionMode -eq 'rom'){@('--no-stub')}else{@()}
    $probe=@($esptoolArgs)+@('--chip','esp32s3','--port',$Port,'--baud','115200')+$connectionArgs+@('flash_id')
    $savedPreference=$ErrorActionPreference
    try {
      $ErrorActionPreference='Continue'
      $probeOutput=(& $Python @probe 2>&1 | Out-String)
    }finally{$ErrorActionPreference=$savedPreference}
    if($LASTEXITCODE -eq 0){$noStub=$connectionMode -eq 'rom';break}
    if($connectionMode -eq 'normal'){Write-Warning '通常の接続確認に失敗したため、低速の接続方法を試します。'}
  }
  if($LASTEXITCODE -ne 0){throw "$Port の接続確認に失敗しました。シリアルモニターを閉じ、必要ならBOOT操作後に再実行してください。`n$probeOutput"}
  if($probeOutput -notmatch 'Detected flash size:\s*16MB'){throw "16MBのESP32-S3として確認できませんでした。別の基板へは書き込みません。`n$probeOutput"}
  Write-Host "${Port}: ESP32-S3 / 16MB を確認しました。書き込みます。"
  $pairs=@();foreach($image in $images){$pairs+=@($image.Offset,(Join-Path $release $image.Name))}
  $flashed=$false
  $baudRates=if($noStub){@(115200)}else{@(460800,115200)}
  foreach($baud in $baudRates){
    $writeConnectionArgs=if($noStub){@('--no-stub')}else{@()}
    $arguments=@($esptoolArgs)+@('--chip','esp32s3','--port',$Port,'--baud',"$baud",'--after','hard_reset')+$writeConnectionArgs+@('write_flash','--no-progress','--verify','--flash_mode','keep','--flash_freq','keep','--flash_size','keep')+$pairs
    & $Python @arguments
    if($LASTEXITCODE -eq 0){$flashed=$true;break}
    Write-Warning "$baud bpsで失敗しました。低速で再試行します。"
  }
  if(-not $flashed){throw '書き込みに失敗しました。USBケーブル・COM番号・BOOT操作を確認してください。'}
  if($NoProvision){Write-Host "player$Player のファームウェア書き込みが完了しました（Wi-Fi設定の転送は省略）。";exit 0}
  Start-Sleep -Seconds 2
  $deadline=(Get-Date).AddSeconds(25)
  do {
    $current=@([System.IO.Ports.SerialPort]::GetPortNames())
    $newPorts=@($current | Where-Object {$_ -notin $initialPorts})
    if($newPorts.Count -eq 1){$runtimePort=$newPorts[0];break}
    if($Port -in $current){$runtimePort=$Port;break}
    if($current.Count -eq 1){$runtimePort=$current[0];break}
    Start-Sleep -Milliseconds 500
  }while((Get-Date) -lt $deadline)
  if(-not $runtimePort){throw '書き込みは完了しましたが、実行用COMポートが見つかりません。USBを再接続して設定転送を実行してください。'}
  $provisioned=$false
  for($attempt=1;$attempt -le 3;$attempt++){
    & $Python "$PSScriptRoot/provision.py" --port $runtimePort --file $settings
    if($LASTEXITCODE -eq 0){$provisioned=$true;break}
    Start-Sleep -Seconds 2
  }
  if(-not $provisioned){throw '書き込みは完了しましたが、Wi-Fi設定の保存応答がありません。実行用COMポートとシリアルモニターを確認してください。'}
  Write-Host "完了: player$Player ($device) のファームウェアとWi-Fi設定を保存しました。"
}finally{$env:PYTHONPATH=$previousPythonPath}
