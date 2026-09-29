#include <Arduino.h>
#include <driver/rmt.h>

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Trigger output diagnostic requires XIAO ESP32-S3 Plus"
#endif

// Legacy 4E赤外線 PCB. These pins differ from the current v0.7 profile.
constexpr uint8_t SW1_PIN = 2;       // J8 / SW_TRIGGER, closed to GND
constexpr uint8_t SW2_PIN = 5;       // J9 / SW_MODE
constexpr uint8_t SW3_PIN = 4;       // J10 / SW_RELOAD
constexpr uint8_t MOTOR_PIN = 9;     // MOTOR_PWM -> Q2 gate
constexpr uint8_t IR_PIN = 6;        // IR_TX -> Q1 gate
constexpr uint8_t LED_PIN = 43;      // LED_DATA_3V3 -> level shifter -> J7
constexpr uint8_t LED_COUNT = 8;
constexpr uint8_t WHITE_20_PERCENT = 51;  // 20% of 255 per RGB channel
constexpr uint32_t DEBOUNCE_MS = 20;
constexpr uint32_t REPORT_INTERVAL_MS = 500;
constexpr uint8_t IR_PWM_CHANNEL = 0;
constexpr uint32_t IR_CARRIER_HZ = 38000;
constexpr uint8_t IR_DUTY_33_PERCENT = 85;  // 85 / 255
constexpr rmt_channel_t LED_RMT_CHANNEL = RMT_CHANNEL_1;

int rawSw1 = HIGH;
int stableSw1 = HIGH;
uint32_t rawChangedAt = 0;
uint32_t lastReportAt = 0;
bool armed = false;
bool outputsOn = false;
bool ledReady = false;

const char* levelName(int level) { return level == LOW ? "LOW" : "HIGH"; }
const char* stateName(int level) { return level == LOW ? "PRESSED" : "RELEASED"; }

bool writeLeds(bool on) {
  if (!ledReady) return false;
  rmt_item32_t items[LED_COUNT * 24]{};
  size_t count = 0;
  const uint8_t value = on ? WHITE_20_PERCENT : 0;
  // WS2812 uses GRB order. White has the same value on all channels.
  for (uint8_t pixel = 0; pixel < LED_COUNT; ++pixel) {
    for (uint8_t channel = 0; channel < 3; ++channel) {
      for (int bit = 7; bit >= 0; --bit) {
        const bool one = value & (1u << bit);
        auto& item = items[count++];
        item.level0 = 1;
        item.duration0 = one ? 24 : 12;
        item.level1 = 0;
        item.duration1 = one ? 24 : 36;
      }
    }
  }
  const esp_err_t result = rmt_write_items(LED_RMT_CHANNEL, items, count, true);
  delayMicroseconds(100);  // WS2812 reset/latch interval
  if (result != ESP_OK) Serial.printf("ERROR LED RMT code=%d\n", result);
  return result == ESP_OK;
}

void stopOutputs() {
  digitalWrite(MOTOR_PIN, LOW);
  ledcWrite(IR_PWM_CHANNEL, 0);
  writeLeds(false);
  outputsOn = false;
}

void startOutputs() {
  if (!writeLeds(true)) {
    stopOutputs();
    Serial.println("ERROR OUTPUT START: LED transfer failed");
    return;
  }
  ledcWrite(IR_PWM_CHANNEL, IR_DUTY_33_PERCENT);
  digitalWrite(MOTOR_PIN, HIGH);
  outputsOn = true;
}

void reportState(const char* kind) {
  Serial.printf("%s time_ms=%lu SW1/J8/GPIO2=%s(%s) SW2/J9/GPIO5=%s(%s) SW3/J10/GPIO4=%s(%s) motor=%s led8_white20=%s ir38k=%s armed=%s\n",
                kind, static_cast<unsigned long>(millis()),
                levelName(digitalRead(SW1_PIN)), stateName(digitalRead(SW1_PIN)),
                levelName(digitalRead(SW2_PIN)), stateName(digitalRead(SW2_PIN)),
                levelName(digitalRead(SW3_PIN)), stateName(digitalRead(SW3_PIN)),
                outputsOn ? "ON" : "OFF", outputsOn ? "ON" : "OFF",
                outputsOn ? "ON" : "OFF", armed ? "YES" : "NO");
}

void setup() {
  // Keep the MOSFET gates inactive before configuring any peripherals.
  digitalWrite(MOTOR_PIN, LOW);
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(IR_PIN, LOW);
  pinMode(IR_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(LED_PIN, OUTPUT);
  pinMode(SW1_PIN, INPUT_PULLUP);
  pinMode(SW2_PIN, INPUT_PULLUP);
  pinMode(SW3_PIN, INPUT_PULLUP);
  Serial.begin(115200);

  ledcSetup(IR_PWM_CHANNEL, IR_CARRIER_HZ, 8);
  ledcAttachPin(IR_PIN, IR_PWM_CHANNEL);
  ledcWrite(IR_PWM_CHANNEL, 0);

  rmt_config_t led = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(LED_PIN), LED_RMT_CHANNEL);
  led.clk_div = 2;  // 25 ns RMT tick; WS2812 uses 1.2 us per bit here.
  led.tx_config.idle_output_en = true;
  led.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  const esp_err_t configResult = rmt_config(&led);
  const esp_err_t installResult = configResult == ESP_OK
                                      ? rmt_driver_install(LED_RMT_CHANNEL, 0, 0)
                                      : configResult;
  ledReady = installResult == ESP_OK;
  if (!ledReady) Serial.printf("ERROR LED INIT code=%d; outputs disabled\n", installResult);
  else writeLeds(false);

  rawSw1 = stableSw1 = digitalRead(SW1_PIN);
  rawChangedAt = millis();
  // Require a new HIGH -> LOW transition, including after a reboot with SW1 held.
  armed = stableSw1 == HIGH;
  Serial.println("TRIGGER OUTPUT DIAGNOSTIC READY; SW1 LOW=pressed, debounce=20ms");
  Serial.println("SW1 held: motor ON, 8 LEDs white 20%, IR carrier 38kHz ON; released: all OFF");
  reportState("START");
  lastReportAt = millis();
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
    Serial.printf("EDGE time_ms=%lu SW1/J8/GPIO2=%s(%s)\n",
                  static_cast<unsigned long>(now), levelName(current), stateName(current));
    if (current == HIGH) {
      stopOutputs();
      armed = true;
      Serial.println("EVENT OUTPUTS OFF");
    } else if (armed && ledReady) {
      armed = false;
      startOutputs();
      if (outputsOn) Serial.println("EVENT OUTPUTS ON motor=ON led8_white20=ON ir38k=ON");
    }
  }
  if (now - lastReportAt >= REPORT_INTERVAL_MS) {
    lastReportAt = now;
    reportState("STATE");
  }
  delay(1);
}
