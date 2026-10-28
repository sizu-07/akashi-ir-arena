# 銃側ファームウェア

- `src/`：XIAO ESP32-S3 Plusで動く本体プログラム
- `include/`：赤外線通信、GPIO、命中フィードバック定義
- `platformio.ini`：PlatformIOのビルド設定
- `release/v0.6/`：旧仕様のBIN。新しい6 LED・トリガー1個の回路には使用しない
- `release/v0.7/`：新仕様をコンパイルした書込み用BINとハッシュ。実機試験は未実施
- `player1_game`～`player4_game`：4E基板4台用の個人戦ゲーム版。端末IDを個別に固定し、赤外線送受信・振動・8個LED・電池監視を使用。[仕様と書き込み方法](PLAYERS_GAME.md) / [保存済みBIN](release/players-4e/README.md)
- `legacy_4e_game`：組み立て済み4E基板向けの通常ゲーム版。LEDのデータ線には実機で確認したGPIO42を使用。[配線と動作](LEGACY_4E_GAME.md)
- `standalone-diagnostic/`：4E基板の入出力を単体確認する診断版。[操作説明](standalone-diagnostic/README.md)

ビルドはプロジェクト最上位から `powershell -File tools/build-firmware.ps1` を実行します。実機への書込みとWi-Fi設定は `powershell -ExecutionPolicy Bypass -File tools/flash-and-provision.ps1` を実行します。

player1～4の保存済みゲーム版を1台ずつ書き込む場合は、最上位で `./flash-player.cmd 1` のように番号を指定します。COMポートを明示するときは `./flash-player.cmd 1 COM3` です。シリアルモニターを閉じ、対象のplayer番号と基板を照合してください。

基板単体の入出力確認は [DIAGNOSTICS.md](DIAGNOSTICS.md) を参照してください。GPIO44の受信素子だけを使う専用端末は [RECEIVER_ONLY_GAME.md](RECEIVER_ONLY_GAME.md) を参照してください。
