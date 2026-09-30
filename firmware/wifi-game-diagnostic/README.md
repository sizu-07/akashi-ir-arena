# Wi-Fi and motor demo for the legacy 4E board

This sketch verifies the same communication path as the v0.7 game firmware:
2.4 GHz Wi-Fi, authenticated MQTT to the actual PC game server, `hello`,
`telemetry`, `desired`, and `time_sync` on `irgame/v1/device/<id>/...`.

The v0.7 hardware profile does **not** match the existing 4E circuit board.
This sketch uses the legacy SW1 (GPIO2) and motor output (GPIO9). Each debounced
SW1 press produces one 310 ms shot pulse at 220/255 PWM duty. The real-device
operator screen sends an authenticated MQTT command for one strong 420 ms hit
pulse. A committed test-match countdown produces five 300 ms pulses at one-second
intervals, with duty rising from 150/255 to 230/255. A transition to HP 0
produces three strong 180 ms pulses; a transition from HP 0 to positive HP
produces a 500 ms PWM ramp from 120/255 to 255/255. The operator screen also
has separate buttons for the defeat and revive patterns without changing HP.
A hardware timer ends each pulse, and starts are separated by at least 300 ms.
PWM changes the motor's average drive; it does not raise its supply voltage.
The diagnostic shot exceeds the v0.7 game profile's
250 ms pulse limit and must not be copied into the game firmware. The IR output (GPIO6)
remains LOW and no LED or IR frames are sent. It reports `hardware_ready=false`
and `bench=true`, so only a partial-device test match can start. Successful
shot, hit, defeat and revive pulses publish events for sound playback on the prepared PC
projection screen. The motor must
be connected to J6 with its intended 3 V supply; a 6 V supply must not be used
for this test.

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

If the access point accepts Wi-Fi association but does not provide DHCP, the
diagnostic alone can use a fixed address. Add `staticIp`, `gateway`, and
`subnet` to the JSON. For example, with a PC wired address of `192.168.137.1/24`,
use `"staticIp":"192.168.137.2","gateway":"192.168.137.1",` and
`"subnet":"255.255.255.0"`, after verifying that `.2` is free. These extra
Preferences keys are read by this diagnostic; the v0.7 production firmware
currently still requires DHCP.

Success is visible both in the serial output and at `http://localhost:8080/api/state`
on the PC: `WIFI CONNECTED`, `MQTT CONNECTED`, `GAME HELLO SENT`, increasing
`desired` and `time_sync` counts, and a `connected=true` player with
`bench=true` and `hardwareReady=false`. The game server must be running in
real-device mode (`npm start`, not `npm run demo`). The operator screen shows
separate shot, hit, defeat and revive pulse counts. This test does not establish LED, IR, the
full game trigger path, or complete-match behavior.
