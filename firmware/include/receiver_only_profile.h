#pragma once
#include <stdint.h>
// USB-powered receiver-only build of the real game firmware.
constexpr char HARDWARE_PROFILE[] = "xiao-s3-plus-rx44-only";
constexpr char FIRMWARE_VERSION[] = "0.7.1-rx44";
constexpr int RX_COUNT = 1;
constexpr int RX_PINS[] = {44};
constexpr const char* RX_IDS[] = {"rx1"};
constexpr int RX_CHANNELS[] = {4};
// Unused by this build: no output, trigger or battery circuit is initialized.
constexpr int TX_PIN=6, LED_PIN=42, MOTOR=9, TRIGGER=2, BATTERY=1;
constexpr int LED_COUNT=1, TX_CHANNEL=0, LED_CHANNEL=1;
constexpr uint32_t SHOT_PULSE_MS=60,HIT_PULSE_MS=180,COUNTDOWN_PULSE_MS=80,MOTOR_MAX_MS=250;
constexpr uint32_t FEEDBACK_MAX_AGE_MS=500,MOTOR_MIN_INTERVAL_MS=300;
