# Wi-Fi / game broker diagnostic for the legacy 4E board

This sketch verifies the same communication path as the v0.7 game firmware:
2.4 GHz Wi-Fi, authenticated MQTT to the actual PC game server, `hello`,
`telemetry`, `desired`, and `time_sync` on `irgame/v1/device/<id>/...`.

The v0.7 hardware profile does **not** match the existing 4E circuit board.
This sketch does not initialize the v0.7 RMT/LED/trigger/receiver pins. It holds
the legacy motor (GPIO9) and IR output (GPIO6) LOW, sends no LED or IR frames,
and reports `hardware_ready=false` and `bench=true`. The game therefore shows
the device as connected without making it eligible to start a match.

Build and upload with the existing tool:

```powershell
pwsh -File tools/build-firmware.ps1 -Environment wifi_game_diagnostics -Python C:\path\to\python.exe -Upload -Port COM3
```

Open COM3 at 115200 baud. Send `SCAN` followed by a newline to list visible
2.4 GHz Wi-Fi networks. For provisioning, send **one JSON line** with the same
fields as the game's generated `config/provision/<id>.json`:

```json
{"ssid":"YOUR_2_4_GHZ_SSID","password":"YOUR_WIFI_PASSWORD","host":"PC_LAN_IPV4","port":1883,"id":"gun-001","key":"DEVICE_KEY_FROM_LOCAL_CONFIG","hardwareProfile":"xiao-s3-plus-3rx-6led-motor-trigger"}
```

Keep that JSON local and out of version control. Provisioning is stored in the
XIAO's `ir-arena` Preferences namespace, so a later production image can read
the same settings. Provisioning restarts the board. The sketch prints no
password or device key. The existing `tools/provision.py --port COM3 --file
config/provision/gun-001.json` can send the file.

Success is visible both in the serial output and at `http://localhost:8080/api/state`
on the PC: `WIFI CONNECTED`, `MQTT CONNECTED`, `GAME HELLO SENT`, increasing
`desired` and `time_sync` counts, and a `connected=true` player with
`bench=true` and `hardwareReady=false`. The game server must be running in
real-device mode (`npm start`, not `npm run demo`). This test does not establish
motor, LED, IR, trigger, or complete-match behavior.
