# 銃側ファームウェア

- `src/`：XIAO ESP32-S3 Plusで動く本体プログラム
- `include/`：赤外線通信、GPIO、命中フィードバック定義
- `platformio.ini`：PlatformIOのビルド設定
- `release/v0.6/`：書込み用BINとハッシュ

ビルドはプロジェクト最上位から `powershell -File tools/build-firmware.ps1` を実行します。実機への書込みとWi-Fi設定は `書込みとWiFi設定.cmd` を使用します。

