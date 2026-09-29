# 基板診断ファームウェア

対象は `specs/hardware-profile.json` の **XIAO ESP32-S3 Plus / v0.7配線** です。`hardware/circuit/` に残る旧回路には使用しないでください。診断ファームウェアはゲーム本体を置き換えます。書き込み後もWi-Fiやゲームサーバーには接続しません。

## 書き込み

1. 基板の型番と配線を確認します。USBで接続する際は、仕様書に従い電池・モーター・外部配線を取り外してください。
2. COM番号を確認します。Windowsでは `Get-CimInstance Win32_SerialPort` が利用できます。
3. リポジトリのルートから次を実行します。PythonとPlatformIOの準備が必要です。

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-firmware.ps1 -Environment board_diagnostics -Upload -Port COM3
```

`COM3` は実際の接続先に置き換えます。書き込み前にesptoolが識別したチップとフラッシュ容量を確認してください。

## 操作

VS Codeでは Microsoft の `Serial Monitor` 拡張（`ms-vscode.vscode-serial-monitor`）を使用します。下部の「Serial Monitor」タブを開き、Portを接続中のCOM番号（今回の実機はCOM3）、Baud rateを `115200`、Line endingを `LF` に設定して「Start Monitoring」を押します。下部の入力欄にコマンドを入れ、送信ボタンを押してください。書き込み時はCOMポートを同時に開けないため、先に「Stop Monitoring」を押します。

起動時は出力がすべてOFFです。接続中は1秒ごとに `STATUS` 行を出し続けます。リミットスイッチ（D10/GPIO9）の入力が変わると、次の定期表示を待たずに `EVENT LIMIT GPIO9 PRESSED` または `RELEASED` を表示します。GPIO9がLOWのとき押下と判定します。接点が跳ねる場合は短時間に複数のイベントが出ることがあります。コマンドごとに対象部品と配線・電源を確認してから実行してください。

| コマンド | 確認内容 |
|---|---|
| `status` | 定期表示を待たずに、稼働時間、チップ、フラッシュ容量、リミット入力とGPIO9のレベル、バッテリーADCの生値、LEDへの最後の指示、モーター出力状態、赤外線送信回数、各受信機の有効・無効フレーム数を表示 |
| `led red 1` など | 指定した1個のLEDを赤・緑・青で点灯。番号省略で6個すべて。`led off` で消灯 |
| `motor` | GPIO40を60 msだけHIGH。300 ms以内の再実行を拒否 |
| `ir` | GPIO6から38 kHzの既知フレームを1回送信 |
| `help` | コマンド一覧 |

有効な赤外線フレームを受信すると、対応する `rx1`、`rx2`、`rx3` のカウントを出力します。ADC値は分圧倍率を掛けていない値です。電池電圧として解釈する場合は、実際の回路で倍率を確認してください。LED、モーター、赤外線送信の表示はプログラムが指示した状態・回数であり、実際の発光・振動・送信強度の測定値ではありません。

各部品を接続していない状態では、その機能の合否は判断できません。ゲーム運用に戻すには通常の `xiao_s3_plus` ファームウェアを書き込み直します。
