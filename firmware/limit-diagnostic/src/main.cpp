#include <Arduino.h>

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Limit diagnostic requires XIAO ESP32-S3 Plus"
#endif

// Pin mapping is taken from hardware/circuit/4E赤外線.kicad_pcb (legacy board).
// Each switch connector has its signal on pin 1 and GND on pin 2.
// The v0.7 hardware profile is different; do not use it for this board test.
struct SwitchInput {
  const char* label;
  const char* net;
  uint8_t gpio;
  int lastLevel;
};
SwitchInput switches[] = {
  {"SW1/J8", "SW_TRIGGER", 2, HIGH},
  {"SW2/J9", "SW_MODE", 5, HIGH},
  {"SW3/J10", "SW_RELOAD", 4, HIGH},
};
constexpr uint32_t REPORT_INTERVAL_MS = 500;
uint32_t lastReportAt = 0;

const char* levelText(int level) { return level == LOW ? "LOW" : "HIGH"; }
const char* pressedText(int level) { return level == LOW ? "PRESSED" : "RELEASED"; }

void reportEdge(const SwitchInput& input, int level) {
  Serial.printf("EDGE time_ms=%lu switch=%s net=%s gpio=%u raw=%s state=%s\n",
                static_cast<unsigned long>(millis()), input.label, input.net, input.gpio,
                levelText(level), pressedText(level));
}

void reportState(const char* kind) {
  Serial.printf("%s time_ms=%lu", kind, static_cast<unsigned long>(millis()));
  for (const auto& input : switches) {
    const int level = digitalRead(input.gpio);
    Serial.printf(" %s/GPIO%u=%s(%s)", input.label, input.gpio,
                  levelText(level), pressedText(level));
  }
  Serial.println();
}

void setup() {
  for (auto& input : switches) pinMode(input.gpio, INPUT_PULLUP);
  Serial.begin(115200);
  for (auto& input : switches) input.lastLevel = digitalRead(input.gpio);
  Serial.println("THREE SWITCH DIAGNOSTIC READY: INPUT_PULLUP, LOW=PRESSED");
  Serial.println("SW1/J8=GPIO2 SW_TRIGGER; SW2/J9=GPIO5 SW_MODE; SW3/J10=GPIO4 SW_RELOAD");
  reportState("START");
  lastReportAt = millis();
}

void loop() {
  for (auto& input : switches) {
    const int level = digitalRead(input.gpio);
    if (level != input.lastLevel) {
      input.lastLevel = level;
      reportEdge(input, level);
    }
  }
  const uint32_t now = millis();
  if (now - lastReportAt >= REPORT_INTERVAL_MS) {
    lastReportAt = now;
    reportState("STATE");
  }
  delay(1);
}
