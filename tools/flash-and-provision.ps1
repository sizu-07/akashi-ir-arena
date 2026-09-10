param([string]$Python='python',[string]$Port,[ValidateSet('gun-001','gun-002','gun-003','gun-004')][string]$Device)
$ErrorActionPreference='Stop'
Set-Location (Join-Path $PSScriptRoot '..')
Write-Host '対象は XIAO ESP32-S3 Plus（16MB Flash）です。v0.5の基板・旧ESP32用BINは使用できません。'
Write-Host 'XIAOから電池・モーター・外部配線をすべて外し、USB Type-CだけでPCへ接続してください。'
if ((Read-Host '取り外して対象機器を確認したら YES を入力') -cne 'YES') { throw '中止しました。書込みしていません。' }
if (-not $Port) {
  Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Description | Format-Table
  $Port=Read-Host '対象のCOM番号（例 COM5）'
}
if ($Port -notmatch '^COM[1-9][0-9]*$') { throw 'COM番号が不正です' }
if (-not $Device) { $Device=Read-Host '設定する端末ID（gun-001 ～ gun-004）' }
if ($Device -notmatch '^gun-00[1-4]$') { throw '端末IDが不正です' }
$settings=Join-Path (Get-Location) "config/provision/$Device.json"
if (-not (Test-Path -LiteralPath $settings)) { throw '先にPCの運営画面でWi-Fi設定を作成してください。' }
$parsedSettings=Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
if ($parsedSettings.hardwareProfile -ne 'xiao-s3-plus-3rx-motor') { throw 'PC画面でv0.6のWi-Fi設定を作り直してください。' }
& "$PSScriptRoot/build-firmware.ps1" -Python $Python -Upload -Port $Port
if ($LASTEXITCODE -ne 0) { throw '書込み失敗' }
$runtimePort=Read-Host 'リセット後の実行用COM番号（変更なければEnter）'
if ($runtimePort) { if ($runtimePort -notmatch '^COM[1-9][0-9]*$') { throw 'COM番号が不正です' }; $Port=$runtimePort }
$oldPythonPath=$env:PYTHONPATH
try {
  if(Test-Path '.tools/python') { $env:PYTHONPATH=(Resolve-Path '.tools/python').Path }
  & $Python "$PSScriptRoot/provision.py" --port $Port --file $settings
  if ($LASTEXITCODE -ne 0) { throw '設定保存に失敗。端末を装着しないでください。' }
} finally { $env:PYTHONPATH=$oldPythonPath }
Write-Host "$Device の書込み・設定保存を確認しました。USBを抜き、IDラベルを貼ってください。接続先は新仕様に対応した検証済み回路に限ります。"
