// Generated from specs/hardware-profile.json; node tools/generate-firmware-profile.mjs
#pragma once
#include <stdint.h>
constexpr char HARDWARE_PROFILE[]="xiao-s3-plus-3rx-6led-motor-trigger";
constexpr char FIRMWARE_VERSION[]="0.7.0";
constexpr int RX_COUNT=3;
constexpr int RX_PINS[]={2,4,5};
constexpr const char* RX_IDS[]={"rx1","rx2","rx3"};
constexpr int RX_CHANNELS[]={4,5,6};
constexpr int TX_PIN=6,LED_PIN=7,MOTOR=40,TRIGGER=9,BATTERY=1;
constexpr int LED_COUNT=6;
constexpr int TX_CHANNEL=0,LED_CHANNEL=1;
constexpr uint32_t SHOT_PULSE_MS=60,HIT_PULSE_MS=180,COUNTDOWN_PULSE_MS=80,MOTOR_MAX_MS=250,FEEDBACK_MAX_AGE_MS=500,MOTOR_MIN_INTERVAL_MS=300;
