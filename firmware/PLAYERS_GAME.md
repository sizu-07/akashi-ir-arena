# player1～4の完全ゲーム版（組み立て済み4E基板）

4台とも通常ゲームの共通ソース `src/main.cpp` を使用し、プレイヤー番号をビルド時に固定します。受信専用・送信診断版ではありません。ファームウェアの識別子は `0.8.2-4e42` です。現行ルールは [ゲーム仕様 v0.8](../docs/ゲーム仕様_v0.8.md) を参照してください。

v0.8.2は本番サーバーの一時診断に対応します。運営画面で開始すると、試合中は残り時間を保って一時停止し、中間発表中は次ゲームへの自動進行を保留します。診断射撃には試合用と異なる赤外線フラグを使い、命中確定時に振動し、7秒で復活します。診断中の撃破は試合の得点には加算しません。実機検証と4台への書き込みは別途必要です。

| プレイヤー | ビルド環境 | 端末ID / 銃ID | 今回の固定IP | 保存済みBIN |
|---|---|---|---|---|
| player1 | `player1_game` | `gun-001` / 1 | 192.168.137.2 | [player1/firmware.bin](release/players-4e/player1/firmware.bin) |
| player2 | `player2_game` | `gun-002` / 2 | 192.168.137.3 | [player2/firmware.bin](release/players-4e/player2/firmware.bin) |
| player3 | `player3_game` | `gun-003` / 3 | 192.168.137.4 | [player3/firmware.bin](release/players-4e/player3/firmware.bin) |
| player4 | `player4_game` | `gun-004` / 4 | 192.168.137.5 | [player4/firmware.bin](release/players-4e/player4/firmware.bin) |

名前、生存状態、復活時刻、試合状態は本番サーバーが通知します。各BINは異なる端末IDを要求し、USBから別プレイヤーの設定を送ると拒否します。サーバーから届く銃IDがビルド時の番号と一致しない場合も射撃を許可しません。

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

- `起動_本番.cmd` の本番MQTTサーバーへ各端末のキーで接続し、時刻同期、試合開始ACK、生存状態、復活時刻を共有します。1台からの実機確認は `起動_デモ.cmd` で「デモの確認対象」を「接続した実機」に切り替えて行います。Wi-Fi設定・端末キーは共通です。本番版は4台での通常試合を実行します。
- 有効な押下で攻撃フレームを1回送信し、同じ連番の `shot_fired` をPCへ報告します。0.7秒間の再射撃禁止中に押した分は破棄し、後から射撃しません。長押しで攻撃弾を追加しません。
- 長押ししても追加の赤外線は送りません。救助用照射はありません。
- 受信フレームは形式とCRCを検証します。PCが発射報告との照合と重複を判定します。受信だけでマイコンが撃破を確定することはありません。
- 標準ルールは4人個人戦、実時間85秒×4ゲーム（投影時計は各1分30秒）、1発撃破、7秒自動復活です。
- 振動は射撃160 ms・PWM220、撃破時180 msを2回、撃破中は約700 ms間隔で180 ms、復活時80 msを3回です。カウントダウンは80 ms・PWM150→170→190→210→230、開始時180 ms・PWM255。モーター制御は既存の電圧・PWM制限を維持します。
- 通常はLEDの先頭を白色の射撃可能表示、残り7個をプレイヤーごとの色で表示します。撃破中は赤点滅と周期的な振動、復活時は緑の表示と振動で通知します。通信断時は黄色を2回点滅させます。
- 通信・時刻同期・設定の異常では射撃と振動を停止します。電池低下は試合開始・射撃を止めず、LED色も変更しません。電池の測定値と警告は運営画面に表示します。9 V電池の交換判定は、平滑化した測定電圧が7.0 V以下です。運営画面の各プレイヤー欄に電池電圧を表示し、7.0 V以下は「要交換」、切断中の値は「最終受信」、受信専用端末等は「未測定」と表示します。PWMや電池閾値は回路の電圧を直接測定・制限するものではありません。
- 効果音は、PCが確定したゲームイベントを投影画面で再生します。運営画面からのデモ振動指示はこの完全版の射撃・被弾判定には使いません。

## シリアル（115200 bps）

起動、接続・同期・試合状態・生存状態・異常の変化、有効な射撃、ゲーム信号の受信だけを出力します。毎秒の状態表示、HIGH/LOWエッジ、生波形は表示しません。同じ射撃を3受信部で受けた場合のシリアル表示は抑制しますが、PCへの報告と受信カウンターは省略しません。

```text
BOOT firmware=0.8.2-4e42 player=1 id=gun-001
STATE id=gun-001 wifi=ON mqtt=ON sync=OK phase=ACTIVE hp=1 armed=YES battery=3.80V gate=OK
SHOT shooter=1 seq=0
RX_GAME firmware=0.8.2-4e42 shooter=3 seq=0 receiver=rx1
STATE id=gun-001 wifi=ON mqtt=ON sync=OK phase=ACTIVE hp=0 armed=YES battery=3.80V gate=OK
```

`RX_GAME` は有効フレームの受信で、命中確定を意味しません。`STATE hp=1` は生存、`hp=0` は撃破中を示します。`gate` は通信・時刻同期・設定などによる停止原因を示します。v0.8.2では電池低下は射撃を停止しません。パスワード・端末キーは表示しません。

## 設定・ビルド・書き込み

保存済みplayer1のWi-Fi設定と本番サーバーの各端末キーから、4台の完全版設定を生成できます。設定ファイルはGit管理外の `config/provision/players-4e/gun-001.json`～`gun-004.json` に保存します。既存の受信診断用設定は残します。

### 通常の書き込み（コマンド1つ）

1. 書き込むplayer番号の基板だけをUSBでPCへ接続し、電池を外します。シリアルモニターは閉じます。
2. このリポジトリのフォルダーで、該当するコマンドを実行します。

```powershell
.\flash-player.cmd 1
.\flash-player.cmd 2
.\flash-player.cmd 3
.\flash-player.cmd 4
```

4台を同時につながず、1台の書き込み完了後にUSBを付け替えて次の番号を実行します。COMポートが1つなら自動検出します。複数ある場合は、Windowsで確認した番号を第2引数へ指定します。

```powershell
.\flash-player.cmd 2 COM5
```

保存済み `0.8.2-4e42` のplayer別BINを使用し、SHA-256、ESP32-S3、16 MB Flashを確認してから書き込みます。Wi-Fi設定も続けて保存します。設定ファイルが未生成の場合は、保存済みplayer1設定と本番サーバー設定から自動生成します。**コマンドに指定した番号と実際にUSBでつないだ基板の番号は、自動では照合できません。** ラベルを確認してください。

COMポートが表示されない場合は、BOOTボタンを押しながらUSBを接続し、接続後にBOOTを離してから再実行します。シリアルモニターがCOMポートを使用中なら閉じます。書き込み後に本番画面で端末名、接続、`0.8.2-4e42` の表示を確認してください。

### ファームウェアを開発・再ビルドする場合

```powershell
node tools/prepare-player-settings.mjs
pwsh -File tools/build-firmware.ps1 -Environment player1_game
pwsh -File tools/build-firmware.ps1 -Environment player2_game
pwsh -File tools/build-firmware.ps1 -Environment player3_game
pwsh -File tools/build-firmware.ps1 -Environment player4_game
node tools/export-player-firmware.mjs
```

PowerShellから直接実行する場合は、次の形式も使用できます。保存済みBINを使うため、毎回のビルドは不要です。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/flash-player-game.ps1 -Player 1 -Port COM3
```

各保存フォルダには `bootloader.bin`、`partitions.bin`、`boot_app0.bin`、`firmware.bin` とSHA-256・manifestがあります。これらにはWi-Fiパスワード・端末キーを含めていません。`firmware.bin` 単体の書き込み先は `0x10000` で、初回は他の領域も必要です。スクリプトで書き込む場合は自動で設定されます。

4台分のビルド、BINの個別識別子・SHA-256、赤外線ID、通常ゲームの発射／全員相互の命中判定をソフトウェアで検証済みです。4台同時の実機試合と一時診断の実機動作は未検証です。player3の受信専用ブレッドボードには、別途保存済みの `receiver_only_game` を使用します。
