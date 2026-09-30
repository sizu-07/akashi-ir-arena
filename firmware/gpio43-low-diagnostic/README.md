# GPIO43 LOW-only diagnostic

For the existing XIAO ESP32-S3 Plus / legacy 4E PCB. After `setup()`,
XIAO D6 (GPIO43) is a push-pull output held LOW. Pull-up and interrupts
are disabled; pull-down is enabled. The GPIO matrix explicitly selects
the GPIO output latch, replacing any previous UART/RMT routing.
GPIO9 (motor) and GPIO6 (IR) are also held LOW.

No UART/USB serial logging, Wi-Fi, LED frames, PWM or switch handling
is started. Runtime ESP-IDF/ROM logging is suppressed. No credentials
or eFuses are modified. ROM activity during reset/download precedes
the program and cannot be eliminated by this sketch.

```powershell
pwsh -File tools/build-firmware.ps1 -Environment gpio43_low_diagnostics -Python C:\path\to\python.exe -Upload -Port COM3
```

Wait two seconds after reset. Measure XIAO D6 directly against XIAO GND;
the expected voltage is approximately 0 V. Separately measure J7-2
(DATA) against J7-3 (GND) to check the level shifter. Software cannot
guarantee the measured voltage if the board has an electrical fault.
Switch presses have no effect, and the serial monitor stays silent.
LOW alone does not transmit an LED-off frame to a previously lit strip.
Return to `wifi_game_diagnostics` to restore the game/motor/LED demo.
