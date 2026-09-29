# リミット入力だけの診断

XIAO ESP32-S3 Plus の D10（GPIO9）だけを読みます。赤外線、LED、モーター、Wi-Fi、電池ADCは初期化しません。D10とGNDの間に無電圧接点を接続する想定で、内部プルアップを有効にしています。LOWを `PRESSED`、HIGHを `RELEASED` と表示します。接点の変化は `EDGE`、現在値は500 msごとに `STATE` として表示します。生の変化を調べるためチャタリング除去はしていません。

書き込み前に電池・モーター・外部配線を外し、USBだけで接続します。VS CodeのSerial Monitorは「Stop Monitoring」で閉じてから書き込みます。

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-firmware.ps1 -Environment limit_diagnostics -Upload -Port COM3
```

書き込み後、USBを抜き、スイッチのCOM端子とNO端子をD10とGNDへ接続してからUSBを接続します。電池・モーターはつなぎません。VS CodeのSerial Monitorを COM3、115200 bps、LF で開くと状態が流れます。押下時に `EDGE ... raw=LOW limit=PRESSED`、解除時に `EDGE ... raw=HIGH limit=RELEASED` を期待します。COMとNCを使うと表示が逆になります。

何も接続していないのに常にLOWなら、スイッチ以前にD10の端子・配線・基板上の短絡を確認してください。表示される `STATE` はGPIOの電気的な読取結果で、スイッチ機構そのものの合否を自動判定するものではありません。
