# Red LED diagnostic (assembled 4E board)

This firmware drives all 8 LEDs connected to GPIO42 continuously red. The red
channel is set to 51/255 (20% of the 8-bit range); green and blue are zero.
It retransmits the LED frame once per second. The motor and IR transmitter stay
low. Serial output at 115200 baud reports software status. This firmware
replaces the game or receiver diagnostic until another firmware is uploaded.

Build and upload from the repository root:

```powershell
pwsh -File tools/build-firmware.ps1 -Environment red_led_diagnostics
pwsh -File tools/build-firmware.ps1 -Environment red_led_diagnostics -Upload -Port COM6
```

The port shown above is only an example; identify the connected board before
uploading. Reported `red=51` is the programmed channel value, not a measured
LED brightness.
