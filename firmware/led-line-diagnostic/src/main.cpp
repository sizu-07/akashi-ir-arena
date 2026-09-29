#include <Arduino.h>

#if !CONFIG_IDF_TARGET_ESP32S3
#error "LED line diagnostic requires XIAO ESP32-S3 Plus"
#endif

// Legacy 4E赤外線 PCB: XIAO D6/GPIO43 -> Q3 level shifter -> J7 DATA.
constexpr uint8_t LED_DATA_PIN = 43;
constexpr uint8_t MOTOR_PIN = 9;
constexpr uint8_t IR_PIN = 6;
constexpr uint32_t PHASE_MS = 15000;

bool highPhase = false;
uint32_t phaseStartedAt = 0;

void setDataLevel(bool high) {
  digitalWrite(LED_DATA_PIN, high ? HIGH : LOW);
  highPhase = high;
  phaseStartedAt = millis();
  Serial.printf("DATA %s: D6/GPIO43 expected %s, J7/2 expected %s (J7/3=GND); hold %lu s\n",
                high ? "HIGH" : "LOW", high ? "3.3 V" : "0 V",
                high ? "5 V" : "0 V", static_cast<unsigned long>(PHASE_MS / 1000));
}

void setup() {
  // Keep the other outputs inactive for this electrical line test.
  digitalWrite(MOTOR_PIN, LOW);
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(IR_PIN, LOW);
  pinMode(IR_PIN, OUTPUT);
  digitalWrite(LED_DATA_PIN, LOW);
  pinMode(LED_DATA_PIN, OUTPUT);

  Serial.begin(115200);
  delay(1000);
  Serial.println("LED DATA LINE DIAGNOSTIC: motor and IR held OFF");
  Serial.println("No WS2812 frames are sent; the LED strip is expected to remain OFF");
  setDataLevel(false);
}

void loop() {
  if (millis() - phaseStartedAt >= PHASE_MS) setDataLevel(!highPhase);
  delay(10);
}
