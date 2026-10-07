# 銃側ファームウェア

- `src/`：XIAO ESP32-S3 Plusで動く本体プログラム
- `include/`：赤外線通信、GPIO、命中フィードバック定義
- `platformio.ini`：PlatformIOのビルド設定
- `release/v0.6/`：旧仕様のBIN。新しい6 LED・トリガー1個の回路には使用しない
- `release/v0.7/`：新仕様をコンパイルした書込み用BINとハッシュ。実機試験は未実施
- `player1_game`～`player4_game`：同じ4E基板4台用の完全ゲーム版。端末IDを個別に固定し、赤外線送受信・振動・8個LED・電池監視を使用。[仕様と書き込み方法](PLAYERS_GAME.md) / [保存済みBIN](release/players-4e/README.md)
- `legacy_4e_game`：現在組み立て済みの4E基板向けの通常ゲーム版。GPIO42に接続された8個のLEDを使用。配線と動作は [LEGACY_4E_GAME.md](LEGACY_4E_GAME.md) を参照
- `standalone-diagnostic/`：同じ4E基板向けの単体確認版。SW1でLED・モーター・赤外線送信を動かし、受信3方向の生信号をシリアル表示。[操作説明](standalone-diagnostic/README.md)

ビルドはプロジェクト最上位から `powershell -File tools/build-firmware.ps1` を実行します。実機への書込みとWi-Fi設定は `powershell -ExecutionPolicy Bypass -File tools/flash-and-provision.ps1` を実行します。

基板単体の入出力を確認する診断版は [DIAGNOSTICS.md](DIAGNOSTICS.md) を参照してください。ゲーム本体とは別のPlatformIOプロジェクトです。

GPIO44の受信素子だけを接続したplayer3用の本番ゲーム通信版は [RECEIVER_ONLY_GAME.md](RECEIVER_ONLY_GAME.md) と `receiver_only_game` を使用します。
