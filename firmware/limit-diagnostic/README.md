# 旧回路基板の3スイッチ診断

`hardware/circuit/4E赤外線.kicad_sch` と同名のPCBデータにある3つのスイッチ端子を読みます。この回路は現行のv0.7ハードウェア仕様とは異なるため、診断専用です。前の診断版が読んだD10/GPIO9は、このPCBでは `MOTOR_PWM` であり、スイッチ入力ではありません。

| コネクタ | 回路上の値 | ネット | XIAO端子 | GPIO | コネクタ1番 / 2番 |
|---|---|---|---|---:|---|
| J8 | SW1 | `SW_TRIGGER` | D1 | 2 | 信号 / GND |
| J9 | SW2 | `SW_MODE` | D4 | 5 | 信号 / GND |
| J10 | SW3 | `SW_RELOAD` | D3 | 4 | 信号 / GND |

3本とも内部プルアップ付き入力に設定します。スイッチが信号とGNDを短絡するとLOW=`PRESSED`、開放するとHIGH=`RELEASED` です。各入力の変化を `EDGE`、3入力すべての現在値を500 msごとの `STATE` に表示します。生の変化を調べるためチャタリング除去はしていません。赤外線、LED、モーター、Wi-Fi、電池ADCは初期化しません。

書き込み前に電池・モーター・外部配線を外し、USBだけで接続します。VS CodeのSerial Monitorは「Stop Monitoring」で閉じてから書き込みます。

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-firmware.ps1 -Environment limit_diagnostics -Upload -Port COM3
```

書き込み後、スイッチを接続してシリアルモニターを115200 bpsで開きます。各スイッチを順番に押すと、その番号の `EDGE ... raw=LOW state=PRESSED`、離すと `EDGE ... raw=HIGH state=RELEASED` が出ることを確認します。起動後は3本とも `STATE ... HIGH(RELEASED)` が期待値です。常時LOWなら、該当ネットとGNDの短絡やスイッチ配線を確認してください。
