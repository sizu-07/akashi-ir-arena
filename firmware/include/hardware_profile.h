// Generated from specs/hardware-profile.json; node tools/generate-firmware-profile.mjs
#pragma once
#include <stdint.h>
constexpr char HARDWARE_PROFILE[]="xiao-s3-plus-3rx-motor";
constexpr char FIRMWARE_VERSION[]="0.6.0";
constexpr int RX_COUNT=3;
constexpr int RX_PINS[]={2,4,5};
constexpr const char* RX_IDS[]={"rx1","rx2","rx3"};
constexpr int RX_CHANNELS[]={4,5,6};
constexpr int TX_PIN=6,LED_PIN=7,BUZZER=8,MOTOR=40,TRIGGER=9,RELOAD=38,SERVICE=39,BATTERY=1;
constexpr int TX_CHANNEL=0,LED_CHANNEL=1;
constexpr uint32_t MOTOR_PULSE_MS=180,MOTOR_MAX_MS=250,FEEDBACK_MAX_AGE_MS=500,MOTOR_MIN_INTERVAL_MS=300;
