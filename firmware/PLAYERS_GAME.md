# player1～4の完全ゲーム版（組み立て済み4E基板）

4台とも通常ゲームの共通ソース `src/main.cpp` を使用し、プレイヤー番号をビルド時に固定します。受信専用・送信診断版ではありません。ファームウェアの識別子は `0.7.2-4e42` です。

| プレイヤー | ビルド環境 | 端末ID / 銃ID | 本番の登録チーム | 今回の固定IP | 保存済みBIN |
|---|---|---|---|---|---|
| player1 | `player1_game` | `gun-001` / 1 | A | 192.168.137.2 | [player1/firmware.bin](release/players-4e/player1/firmware.bin) |
| player2 | `player2_game` | `gun-002` / 2 | A | 192.168.137.3 | [player2/firmware.bin](release/players-4e/player2/firmware.bin) |
| player3 | `player3_game` | `gun-003` / 3 | B | 192.168.137.4 | [player3/firmware.bin](release/players-4e/player3/firmware.bin) |
| player4 | `player4_game` | `gun-004` / 4 | B | 192.168.137.5 | [player4/firmware.bin](release/players-4e/player4/firmware.bin) |

チーム、名前、HP、試合状態は本番サーバーが通知します。各BINは異なる端末IDを要求し、USBから別プレイヤーの設定を送ると拒否します。サーバーから届く銃IDがビルド時の番号と一致しない場合も射撃を許可しません。

## 接続

| 機能 | GPIO | 実装 |
|---|---:|---|
| 発射SW1 | 2 | LOWで押下、内部プルアップ、20 msのチャタリング除去 |
| 赤外線送信 | 6 | 38 kHz・33%キャリア、32 bitゲーム信号・CRC |
| 赤外線受信 前・左・右 | 44・7・8 | 3受信部を読み取り、銃ID・連番・受信部IDをPCへ報告 |
| 振動モーター | 9 | 基板上のMOSFETへ5 kHz・8 bit PWM |
| WS2812B ECO | 42 | 8個。射撃時に全て白色20%（RGB各51/255）を約310 ms表示 |
| 電池監視 | 1 | 1 MΩ / 100 kΩ分圧を11倍換算 |
| SW2・SW3 | 5・4 | 入力状態を通信。射撃操作には使用しない |

この配線は、実機でLED DATAをGPIO42へ変更した4E基板用です。

## ゲーム動作

- `起動_本番.cmd` の本番MQTTサーバーへ各端末のキーで接続し、時刻同期、試合開始ACK、HP、チームを共有します。
- 有効な押下で攻撃フレームを1回送信し、同じ連番の `shot_fired` をPCへ報告します。1秒間の再射撃禁止中に押した分は破棄し、後から射撃しません。長押しで攻撃弾を追加しません。
- 長押し中は別フラグの復活照射を送り、保持状態をPCへ報告します。死亡した味方に3秒間継続して照射すると、PCが復活を成立させます。
- 受信フレームは形式とCRCを検証します。PCが発射報告との照合、敵味方、重複、無敵時間を判定します。受信だけでマイコンがHPを減らすことはありません。
- 標準ルールはHP100、被弾5、復活HP50、味方撃ち無効、試合300秒。運営画面で設定したルールに従います。
- 振動は現在の通常ゲーム仕様を使用します。射撃60 ms・PWM220、確定被弾180 ms・PWM255、死亡180 msを2回、復活80 msを3回。カウントダウンは80 ms・PWM150→170→190→210→230、開始時180 ms・PWM255。各振動は最大250 ms、開始間隔は最低300 msです。
- 通常はLEDの先頭を射撃可能表示、残り7個をチーム色のHPバーに使用します。被弾は赤、死亡は赤点滅、復活は緑、停止は青、通信等の異常は橙／青で示します。
- 通信・時刻同期・設定・電池の異常では射撃と振動を停止します。電池停止の現行値は3.3 V未満、3.0 V未満が3秒以上でラッチです。PWMや電池閾値は回路の電圧を直接測定・制限するものではありません。
- 効果音は、PCが確定したゲームイベントを投影画面で再生します。運営画面からのデモ振動指示はこの完全版の射撃・被弾判定には使いません。

## シリアル（115200 bps）

起動、接続・同期・試合状態・HP・異常の変化、有効な射撃、ゲーム信号の受信だけを出力します。毎秒の状態表示、HIGH/LOWエッジ、生波形、復活照射の繰り返しは表示しません。同じ射撃を3受信部で受けた場合のシリアル表示は抑制しますが、PCへの報告と受信カウンターは省略しません。

```text
BOOT firmware=0.7.2-4e42 player=1 id=gun-001
STATE id=gun-001 wifi=ON mqtt=ON sync=OK phase=ACTIVE hp=100 armed=YES battery=3.80V gate=OK
SHOT shooter=1 seq=0
RX_GAME firmware=0.7.2-4e42 shooter=3 seq=0 receiver=rx1
STATE id=gun-001 wifi=ON mqtt=ON sync=OK phase=ACTIVE hp=95 armed=YES battery=3.80V gate=OK
```

`RX_GAME` は有効フレームの受信で、命中確定を意味しません。`STATE hp=...` でPCが確定したHPを確認します。`gate` は停止原因を示し、`NETWORK`、`SYNC`、`PROFILE`、`LEASE`、`BENCH`、`LOW_BATTERY`、`BATTERY_LATCH` を区別します。パスワード・端末キーは表示しません。

## 設定・ビルド・書き込み

保存済みplayer1のWi-Fi設定と本番サーバーの各端末キーから、4台の完全版設定を生成できます。設定ファイルはGit管理外の `config/provision/players-4e/gun-001.json`～`gun-004.json` に保存します。既存の受信診断用設定は残します。

```powershell
node tools/prepare-player-settings.mjs
pwsh -File tools/build-firmware.ps1 -Environment player1_game
pwsh -File tools/build-firmware.ps1 -Environment player2_game
pwsh -File tools/build-firmware.ps1 -Environment player3_game
pwsh -File tools/build-firmware.ps1 -Environment player4_game
node tools/export-player-firmware.mjs
```

各プレイヤーの書き込みは、対象をUSBだけで接続し、次のスクリプトを使用します。`-Player` と `-Port` を実際の機器に合わせます。ビルド環境と設定ファイルを同じプレイヤーにそろえて書き込みます。

```powershell
pwsh -File tools/flash-player-game.ps1 -Player 1 -Port COM3
```

各保存フォルダには `bootloader.bin`、`partitions.bin`、`boot_app0.bin`、`firmware.bin` とSHA-256・manifestがあります。これらにはWi-Fiパスワード・端末キーを含めていません。`firmware.bin` 単体の書き込み先は `0x10000` で、初回は他の領域も必要です。スクリプトで書き込む場合は自動で設定されます。

2026年10月7日作成。4台分のビルド、BINの個別識別子・SHA-256、赤外線ID、シリアル表示の抑制、通常ゲームの発射／敵味方判定をソフトウェアで検証済みです。この4台分の版の実機書き込みと、4台同時の試合動作は今回の作成作業では行っていません。player3の受信専用ブレッドボードには、別途保存済みの `receiver_only_game` を使用します。
