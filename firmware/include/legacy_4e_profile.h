#pragma once
#include <stdint.h>

// Physical pin map for the assembled 4E board. GPIO42 is based on the
// confirmed working LED connection; the archived PCB file still shows GPIO43.
// The protocol profile string remains shared with the PC game server.
constexpr char HARDWARE_PROFILE[] = "xiao-s3-plus-3rx-6led-motor-trigger";
constexpr char FIRMWARE_VERSION[] = "0.7.2-4e42";
constexpr int RX_COUNT = 3;
constexpr int RX_PINS[] = {44, 7, 8};
constexpr const char* RX_IDS[] = {"rx1", "rx2", "rx3"};
constexpr int RX_CHANNELS[] = {4, 5, 6};
constexpr int TX_PIN = 6, LED_PIN = 42, MOTOR = 9, TRIGGER = 2, BATTERY = 1;
constexpr int SW_MODE = 5, SW_RELOAD = 4;
constexpr int LED_COUNT = 8;
constexpr int TX_CHANNEL = 0, LED_CHANNEL = 1;
constexpr uint32_t SHOT_PULSE_MS = 60, HIT_PULSE_MS = 180;
constexpr uint32_t COUNTDOWN_PULSE_MS = 80, MOTOR_MAX_MS = 250;
constexpr uint32_t FEEDBACK_MAX_AGE_MS = 500, MOTOR_MIN_INTERVAL_MS = 300;
// PCB R15 = 1 MOhm and R16 = 100 kOhm: ADC sees battery / 11.
constexpr float BATTERY_ADC_SCALE = 11.0f;
constexpr uint8_t SHOT_MOTOR_DUTY = 220, HIT_MOTOR_DUTY = 255;
constexpr uint8_t COUNTDOWN_MOTOR_DUTIES[5] = {150, 170, 190, 210, 230};
