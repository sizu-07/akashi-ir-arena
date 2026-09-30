# Wi-Fi and motor demo for the legacy 4E board

This sketch verifies the same communication path as the v0.7 game firmware:
2.4 GHz Wi-Fi, authenticated MQTT to the actual PC game server, `hello`,
`telemetry`, `desired`, and `time_sync` on `irgame/v1/device/<id>/...`.

The v0.7 hardware profile does **not** match the existing 4E circuit board.
This sketch uses the legacy SW1 (GPIO2) and motor output (GPIO9).
The current `legacy-motor-demo-6` restores the motor implementation from v3:
GPIO9, LEDC channel 2, 5 kHz / 8 bit, immediate PWM write in the main loop and a
one-shot timer that writes zero at the end. The v4/v5 periodic envelope driver
and reduced output limits have been removed at the user's request after both
versions failed to rotate the motor. This rollback does not prove the physical
cause or establish a safe voltage/current limit.

- Shot: PWM 220/255 for 310 ms.
- Hit: PWM 255/255 for 420 ms, one pulse.
- Countdown: five 300 ms pulses at duties 150, 170, 190, 210, 230.
- Defeat: three 180 ms pulses at 255, separated by 300 ms OFF.
- Revive: a 500 ms increase from duty 120 towards 255; the timer stops output.

SW1 is debounced for 25 ms. A shot is accepted only on a fresh press after
release. For 1000 ms after an accepted press, further presses are discarded,
not queued. Busy presses are also discarded and never replayed when the motor
becomes available. A held or boot-held switch cannot produce repeated shots.
Operator commands are consumed immediately; busy ones are skipped. The screen
reports ignored presses and the PWM register readback. Register readback does
not measure the motor rail or confirm physical rotation.

An accepted shot also sends white at RGB=(51,51,51), 20 percent, to eight
WS2812B ECO LEDs at GPIO43 (XIAO D6, through Q3 to J7 DATA). The RMT frame uses
25 ns ticks, 0-bit high/low 13/37 ticks and 1-bit 26/24 ticks, with a 300 us low
latch interval. All eight pixels are cleared after the shot, normally about
310 ms later. LED transfers occur in the main loop, so a blocked loop can delay
LED clearing; the independent motor-off timer still cuts motor output. The
status confirms initialization and frame transmission, not physical lighting.
A previously suspected GPIO43/level-shifter fault may still prevent lighting.
LED initialization failure does not disable the independent motor test.

The IR output (GPIO6) remains LOW. This sketch reports `hardware_ready=false`
and `bench=true`, so only a partial-device test match can start. Shot, hit,
defeat and revive events play sounds on the prepared PC projection screen.
These diagnostic pulses exceed the production profile's 250 ms limit and must
not be copied into production firmware. PWM is not voltage protection. Motor
supply voltage/current and the separate J6 rail must be measured to distinguish
power faults from control faults.

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
separate shot, hit, defeat and revive pulse counts and the PWM diagnostics.
This diagnostic does not verify physical motor rotation, LED lighting, IR transmission,
the full game trigger path, or complete-match behavior.
