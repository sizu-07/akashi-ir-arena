param([Parameter(Mandatory=$true)][string]$Subnet,[int]$HttpPort=8080,[int]$MqttPort=1883,[switch]$Apply)
$ErrorActionPreference='Stop'

function Resolve-NodeExecutable {
  $command=Get-Command node -ErrorAction SilentlyContinue
  if($command) { return $command.Source }

  $bundled=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if(Test-Path -LiteralPath $bundled) { return $bundled }

  throw 'Node.js 20以上が見つかりません。Node.js LTSをインストールしてから再実行してください。'
}
if ($Subnet -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9.]+/(2[0-9]|3[0-2]|1[6-9])$') { throw '会場のプライベートIPv4サブネットをCIDR形式で指定してください（例: 192.168.11.0/24）' }
if ($HttpPort -lt 1024 -or $HttpPort -gt 65535 -or $MqttPort -lt 1024 -or $MqttPort -gt 65535) { throw 'ポート範囲が不正です' }
$nodePath=Resolve-NodeExecutable
Write-Host "許可予定: $nodePath / TCP $HttpPort,$MqttPort / Privateのみ / 接続元 $Subnet"
if (-not $Apply) { Write-Host '確認だけで終了しました。反映する時だけ管理者として -Apply を付けて実行してください。'; exit }
$name='Akashi IR Arena Private LAN'
if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) { throw '同名ルールが既にあります。既存の内容を確認してください。自動上書きはしません。' }
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Program $nodePath -Protocol TCP -LocalPort $HttpPort,$MqttPort -RemoteAddress $Subnet -Profile Private
