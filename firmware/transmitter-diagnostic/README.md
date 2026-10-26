# 4E基板・赤外線送信だけの比較試験

`transmitter_diagnostics` / `transmitter-only-6-1`。受信側へ書き込まず、赤外線LEDを接続した送信側XIAOに使用します。

- 4E基板のGPIO6で赤外線送信。SW1/J8/GPIO2を押すと1フレームを送信し、押し続けると送信終了から1秒ごとに再送します。ボタンのチャタリング除去は20 ms、起動時に押されている場合は一度離します。
- ゲームと同じ38 kHz・デューティ33%、ヘッダ9 ms/4.5 ms、32ビットMSB順、560 µsのマークと560/1690 µsのスペース、終端560 µs。
- 固定フレーム `0x40454447`（銃ID1・発射番号21・武器1・flags0・CRC正常）。過去に実機で受信成功したデータと同一です。固定発射番号なので実際の試合には使わず、受信試験に使用してください。
- GPIO9のモーターをLOW保持。GPIO42のWS2812B 8個には起動時に消灯データを1回だけ送信し、その後はLOW保持。受信・Wi-Fi・MQTTは使用せず、保存済みネットワーク設定も変更しません。
- USB CDC/115200 bpsの `TX_TEST ... result=OK` はRMT送信APIの成功を示し、LEDの発光や電流を測定した結果ではありません。
- 受信側 `receiver-only-44-1` で `RX_RESULT type=GAME frame=0x40454447 game_crc=OK` が得られるか確認します。はじめは距離約1 m、送信LEDと受光窓を向かい合わせにします。

モーター・LEDを動かさない条件で比較し、さらに距離、向き、受信側の短い配線を確認します。改善しない場合は送信側の光波形・受信側の電源・受信機OUTを計測して原因を分ける必要があります。データが欠落している状態でCRCや形式検査を緩めて被弾判定に使わないでください。

```powershell
pwsh -File tools/build-firmware.ps1 -Environment transmitter_diagnostics -Upload -Port <送信機のCOM番号>
```

2026年10月7日、送信機COM3（MAC `44:b1:76:b0:2a:ac`）へ書き込みました。通常のesptool補助プログラムでは起動後に通信が止まったため、`--no-stub`・115200 bpsによるROM書き込みで成功しています。16 MBフラッシュを確認し、ブートローダー・パーティション・boot_app0・アプリの全データでハッシュ検証に成功しました。受信側のCOM4には、この送信専用版を書き込んでいません。

同日、利用者の実機試験ログで、受信側に `pulse_count=67` と `RX_RESULT ... type=GAME frame=0x40454447 game_crc=OK ... kind=SHOT` が出ることを確認しました。提示された1フレームについて光学的な送受信とゲーム形式の判定に成功しています。モーター・LED同時動作時の受信や、連続送信に対する成功率は別途確認が必要です。

通常の書き込みが同じエラーになる場合のROM書き込み（ビルド後、COM番号を確認して使用）:

```powershell
$env:PYTHONPATH = ((Join-Path (Get-Location) '.tools/python'), (Join-Path (Get-Location) '.tools/platformio/packages/tool-esptoolpy')) -join ';'
python -m esptool --chip esp32s3 --port COM3 --baud 115200 --no-stub write_flash --flash_mode keep --flash_freq keep --flash_size 16MB 0x0 firmware/transmitter-diagnostic/.pio/build/transmitter_diagnostics/bootloader.bin 0x8000 firmware/transmitter-diagnostic/.pio/build/transmitter_diagnostics/partitions.bin 0xe000 .tools/platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin 0x10000 firmware/transmitter-diagnostic/.pio/build/transmitter_diagnostics/firmware.bin
```

上の `python` はビルドに使用したPython実行ファイルを指定します。
