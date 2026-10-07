# 赤外線受信のみのブレッドボード診断

`receiver_diagnostics` / `receiver-only-44-1`。XIAO ESP32-S3 PlusのGPIO44へOSRB38C9AAのOUTを接続し、GNDを共通にします。受信機VCCは3V3。OUT–3V3間の外付け10 kΩに加え、GPIOの内部プルアップも有効です。既存基板ではJ1がGPIO44に対応します。

2026年10月7日、実際に受信した波形・CRC破損・途中で切れた波形等の判定テストとビルドに成功し、接続されていたCOM4のESP32-S3へ書き込みました。esptoolによる書き込みデータのハッシュ検証も成功しています。

同日、利用者が送信専用版 `transmitter-only-6-1` で光学的な送受信を確認し、受信ログ `count=9 pulse_count=67` に続く `type=GAME frame=0x40454447 game_crc=OK version=1 shooter=1 seq=21 weapon=1 flags=0 kind=SHOT` が得られました。提示された1フレームの受信・判定成功を確認したもので、count=9を9回連続成功や受信成功率として扱いません。以前の短いLOW・欠落パルスの原因や、モーター・LED同時動作時の安定性は未確定です。

受信1系統だけを使用します。GPIO7・8の受信、ボタン、モーターPWM、テープLED送信、赤外線送信、Wi-Fi・MQTTは使用しません。既存基板のGPIO6・9・42はLOWに保持します。GPIO44とUART受信を競合させず、USB CDCでシリアル表示します。保存済みのネットワーク設定は変更しません。

シリアルは115200 bps。入力変化がないときは表示せず、受信時に次を表示します（初期化失敗時のみRX_ERROR）。

- `RX_EDGE`: HIGH/LOWの変化、起動後時刻（µs）、前の変化からの時間。最初の時間差は0。
- `RX_RAW`: RMTで取得した全パルス。`L9000,H4500` はLOW 9000 µs、HIGH 4500 µs。ソフトウェアの短パルスフィルタは無効。
- `RX_RESULT type=GAME`: 9 ms/4.5 msのヘッダ、32ビット（MSB順）、終端LOWを確認し、既存ゲームの `irValid()` と同じバージョン1・weapon=1・flags=0/1・CRC-8の条件が一致。`kind=SHOT` は発射、`kind=RESCUE` は救助信号。銃IDと発射番号も表示。
- `RX_RESULT type=GAME_LIKE_INVALID`: 32ビットの波形は読めたがゲームの条件が不一致。一般のNECリモコンや、壊れたゲーム信号が含まれます。ゲーム信号ではないと断定しません。
- `RX_RESULT type=OTHER_OR_UNDECODED`: 完全なゲーム形式の波形として解読できない入力。別方式、短い信号、途中で切れたゲーム信号、ノイズを含みます。
- `RX_OVERFLOW`: GPIO変化のキュー超過や解読配列の上限超過を報告。解読配列を超えてもRMTで取得したRAWパルスは省略しません。

判定はゲーム形式との一致を示し、送信元の認証ではありません。OSRB38C9AAが検出する約38 kHzの赤外線信号の復調出力を記録するもので、あらゆる赤外光・搬送波を記録する機器ではありません。受信機の帯域、RMTメモリ、割り込みキュー、USB出力速度による取りこぼしはあり得ます。RMTの無信号区切りは12 ms、1 µs単位。連続した非常に長い入力はRAWが分割・欠落して解読できないことがあります。

コンデンサなしでの確認は、モーター等を動作させずUSB給電で行います。ゲーム送信機または一般の赤外線リモコンを使用し、スマホ顔認証の光だけで受信可否を判定しないでください。

```powershell
pwsh -File tools/build-firmware.ps1 -Environment receiver_diagnostics -Upload -Port COM4
```

COM番号は接続状態によって変わります。自動テストの波形は、実機で正常受信した `0x40454447` を使います。
