#include <Arduino.h>
#include "hardware_profile.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Limit diagnostic requires XIAO ESP32-S3 Plus"
#endif

// The only external signal read by this firmware is D10 / GPIO9.
// Connect a dry-contact switch between D10 and GND; LOW means closed.
constexpr uint32_t REPORT_INTERVAL_MS = 500;
int lastLevel = HIGH;
uint32_t lastReportAt = 0;

void report(const char* kind, int level) {
  Serial.printf("%s time_ms=%lu pin=D10/GPIO%d raw=%s limit=%s\n", kind,
                static_cast<unsigned long>(millis()), TRIGGER,
                level == LOW ? "LOW" : "HIGH",
                level == LOW ? "PRESSED" : "RELEASED");
}

void setup() {
  pinMode(TRIGGER, INPUT_PULLUP);
  Serial.begin(115200);
  lastLevel = digitalRead(TRIGGER);
  Serial.println("LIMIT ONLY READY: D10/GPIO9, INPUT_PULLUP, LOW=PRESSED");
  report("START", lastLevel);
  lastReportAt = millis();
}

void loop() {
  const int level = digitalRead(TRIGGER);
  if (level != lastLevel) {
    lastLevel = level;
    report("EDGE", level);
  }
  const uint32_t now = millis();
  if (now - lastReportAt >= REPORT_INTERVAL_MS) {
    lastReportAt = now;
    report("STATE", level);
  }
  delay(1);
}
