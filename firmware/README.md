# 銃側ファームウェア

- `src/`：XIAO ESP32-S3 Plusで動く本体プログラム
- `include/`：赤外線通信、GPIO、命中フィードバック定義
- `platformio.ini`：PlatformIOのビルド設定
- `release/v0.6/`：旧仕様のBIN。新しい6 LED・トリガー1個の回路には使用しない
- `release/v0.7/`：新仕様をコンパイルした書込み用BINとハッシュ。実機試験は未実施

ビルドはプロジェクト最上位から `powershell -File tools/build-firmware.ps1` を実行します。実機への書込みとWi-Fi設定は `powershell -ExecutionPolicy Bypass -File tools/flash-and-provision.ps1` を実行します。

基板単体の入出力を確認する診断版は [DIAGNOSTICS.md](DIAGNOSTICS.md) を参照してください。ゲーム本体とは別のPlatformIOプロジェクトです。
