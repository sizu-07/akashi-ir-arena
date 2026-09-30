# Wi-Fi and motor demo for the legacy 4E board

This sketch verifies the same communication path as the v0.7 game firmware:
2.4 GHz Wi-Fi, authenticated MQTT to the actual PC game server, `hello`,
`telemetry`, `desired`, and `time_sync` on `irgame/v1/device/<id>/...`.

The v0.7 hardware profile does **not** match the existing 4E circuit board.
This sketch uses the legacy SW1 (GPIO2) and motor output (GPIO9). Each debounced
The current `legacy-motor-demo-4` applies a common **180/255 PWM ceiling**
(about 71%) at 5 kHz / 8 bit. This is a provisional reduction of load, not a
verified voltage or current protection setting: the motor rail is not measured
by this firmware. With a measured 3 V rail, `3 * 180 / 255 = 2.12 V` is only a
rough average drive estimate; each ON pulse still applies the motor rail voltage.
The motor part number, startup current, fitted regulator and voltage under load
must be checked before a reliable hardware operating limit can be established.

SW1 produces one 310 ms shot at 110/255, with a short, bounded 140/255 startup
assist and a soft ending. A hit is one 420 ms pulse at 170/255 with soft start/end.
The committed countdown produces five 300 ms pulses, once per second,
with steady duties 65, 85, 110, 140 and 170 (a brief bounded startup assist is
included). HP 0 produces three 180 ms pulses at 170/255, with **300 ms OFF**
between pulses. Revive swells over 500 ms: a quiet opening, an accelerating rise
to 180/255, a short peak and a fade out. The operator screen also
has separate buttons for the defeat and revive patterns without changing HP.
A 5 ms timer updates the complete envelope and cuts output after its duration,
independently of networking or the main loop. All runtime PWM writes are made by
that task. Effects are followed by 250 ms OFF. Busy/cooldown commands wait in an
eight-entry queue instead of being silently skipped; stale commands expire after
five seconds. Queue overflow/expiry and missed countdown marks are counted.
The screen shows the applied duty, ceiling, queue and previous brownout reset
reason, which helps distinguish a control rejection from a possible power fault.
An absent brownout flag does not rule out a dip on the separate motor rail.
PWM changes the motor's average drive; it does not raise its supply voltage.
These diagnostic effects exceed the v0.7 game profile's
250 ms pulse limit and must not be copied into the game firmware. The IR output (GPIO6)
remains LOW and no LED or IR frames are sent. It reports `hardware_ready=false`
and `bench=true`, so only a partial-device test match can start. Successful
shot, hit, defeat and revive pulses publish events for sound playback on the prepared PC
projection screen. The motor must
be connected to J6 with its intended 3 V supply; a 6 V supply must not be used
for this test.

PWM/current and motor startup considerations are described in the
[Pololu motor and supply guide](https://www.pololu.com/docs/0J73/4.1).
The provisional ceiling does not replace measurement of J6-1 versus GND during
an actual motor pulse. Until that measurement and motor ratings are available,
neither the occasional non-start nor a guaranteed usable voltage limit is known.

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
Weak PWM settings may not start an uncharacterized motor. This test does not establish LED, IR, the
full game trigger path, or complete-match behavior.
