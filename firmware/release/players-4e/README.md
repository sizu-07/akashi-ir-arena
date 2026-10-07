# 4E基板用・player1～4 完全ゲーム版

各フォルダの番号と実機の番号を合わせて使用してください。全てGPIO42の8個テープLED、GPIO9のPWMモーター、GPIO6の赤外線送信、GPIO44・7・8の受信、GPIO2の射撃SWを使用します。

詳細な仕様・シリアル表示・書き込み方法は [PLAYERS_GAME.md](../../PLAYERS_GAME.md) を参照してください。各フォルダの `manifest.json` にGPIO、端末ID、ソースハッシュ、書き込み位置を記録しています。

Wi-Fi設定はBINに含まれません。`tools/flash-player-game.ps1` で対応する設定を保存してください。書き込み後は「起動_本番.cmd」を使用します。
