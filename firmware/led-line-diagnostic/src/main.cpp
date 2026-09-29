#include <Arduino.h>
#include <driver/gpio.h>

#if !CONFIG_IDF_TARGET_ESP32S3
#error "LED line diagnostic requires XIAO ESP32-S3 Plus"
#endif

// Legacy 4E赤外線 PCB: XIAO D6/GPIO43 -> Q3 level shifter -> J7 DATA.
constexpr uint8_t LED_DATA_PIN = 43;
constexpr uint8_t MOTOR_PIN = 9;
constexpr uint8_t IR_PIN = 6;
constexpr uint8_t SW1_PIN = 2;
constexpr uint32_t DEBOUNCE_MS = 20;

bool highPhase = false;
bool dataReady = false;
int rawSw1 = HIGH;
int stableSw1 = HIGH;
uint32_t rawChangedAt = 0;
bool armed = false;

void setDataLevel(bool high) {
  if (!dataReady) return;
  const esp_err_t result = gpio_set_level(static_cast<gpio_num_t>(LED_DATA_PIN), high ? 1 : 0);
  if (result != ESP_OK) {
    Serial.printf("ERROR GPIO43 set_level=%d\n", result);
    return;
  }
  highPhase = high;
  Serial.printf("DATA %s: D6/GPIO43 expected %s, J7/2 expected %s (J7/3=GND); held until next SW1 press\n",
                high ? "HIGH" : "LOW", high ? "3.3 V" : "0 V",
                high ? "5 V" : "0 V");
}

void setup() {
  // Keep the other outputs inactive for this electrical line test.
  digitalWrite(MOTOR_PIN, LOW);
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(IR_PIN, LOW);
  pinMode(IR_PIN, OUTPUT);
  pinMode(SW1_PIN, INPUT_PULLUP);

  Serial.begin(115200);
  delay(1000);
  // Configure GPIO43 after USB CDC initialization to rule out pin ownership.
  const gpio_num_t dataPin = static_cast<gpio_num_t>(LED_DATA_PIN);
  gpio_set_level(dataPin, 0);
  gpio_config_t config{};
  config.pin_bit_mask = 1ULL << LED_DATA_PIN;
  config.mode = GPIO_MODE_OUTPUT;
  config.pull_up_en = GPIO_PULLUP_DISABLE;
  config.pull_down_en = GPIO_PULLDOWN_DISABLE;
  config.intr_type = GPIO_INTR_DISABLE;
  const esp_err_t configResult = gpio_config(&config);
  const esp_err_t driveResult = configResult == ESP_OK
                                    ? gpio_set_drive_capability(dataPin, GPIO_DRIVE_CAP_3)
                                    : configResult;
  const esp_err_t lowResult = driveResult == ESP_OK ? gpio_set_level(dataPin, 0) : driveResult;
  dataReady = lowResult == ESP_OK;
  Serial.printf("GPIO43 config=%d drive=%d initial_low=%d\n", configResult, driveResult, lowResult);
  Serial.println("LED DATA LINE DIAGNOSTIC: motor and IR held OFF");
  Serial.println("No WS2812 frames are sent; the LED strip is expected to remain OFF");
  Serial.println("Press and release SW1 once to toggle DATA, then measure at leisure");
  setDataLevel(false);
  rawSw1 = stableSw1 = digitalRead(SW1_PIN);
  rawChangedAt = millis();
  armed = stableSw1 == HIGH;
}

void loop() {
  const uint32_t now = millis();
  const int current = digitalRead(SW1_PIN);
  if (current != rawSw1) {
    rawSw1 = current;
    rawChangedAt = now;
  }
  if (current != stableSw1 && now - rawChangedAt >= DEBOUNCE_MS) {
    stableSw1 = current;
    if (current == HIGH) armed = true;
    else if (armed) {
      armed = false;
      setDataLevel(!highPhase);
    }
  }
  delay(1);
}
