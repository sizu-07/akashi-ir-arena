# 4E基板・3方向の赤外線受信診断

`all_receivers_diagnostics` は、組み立て済み4E基板の受信機3個のデジタル出力を記録します。ゲーム形式の判定やプロトコル解読はしません。USBシリアルは115200 bpsです。Wi-Fi設定は変更せず、赤外線送信・モーター・LEDを動かしません。この診断版を書き込んでいる間は通常ゲームに参加できません。

| 表示 | 内容 |
|---|---|
| `BOOT` | rx1=GPIO44、rx2=GPIO7、rx3=GPIO8の初期化結果。`ready=111`が全系統成功 |
| `IR_RAW` | 受信したデジタル波形のパルス長。`L9000,H4500` はLOW 9000 µs、HIGH 4500 µs |
| `IR_ACTIVITY` | GPIO入力変化の数と、RMTが取り込んだブロックの累計 |
| `IR_STATUS` | 5秒ごとの初期化状態、GPIOレベル、各受信部のブロック累計 |
| `IR_ERROR` | 受信系統の初期化失敗 |

```powershell
pwsh -File tools/build-firmware.ps1 -Environment all_receivers_diagnostics -Upload -Port COM5
```

COM番号は接続時に確認してください。受信素子は変調信号を復調するため、すべての赤外光を検出するものではありません。無変調の赤外光、受信素子の対応帯域外の信号、シリアル転送量やRMTバッファを超える連続信号は記録できない場合があります。
