#include <Arduino.h>
#include <driver/rmt.h>
#include "legacy_4e_profile.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Red LED diagnostic requires XIAO ESP32-S3 Plus"
#endif

namespace {
constexpr char VERSION[] = "red-led-4e42-1";
constexpr uint8_t RED_VALUE = 51;  // 51 / 255 = 20% of the 8-bit channel range.
constexpr rmt_channel_t LED_RMT_CHANNEL = static_cast<rmt_channel_t>(LED_CHANNEL);
rmt_item32_t ledItems[LED_COUNT * 24]{};
bool ledReady = false;
uint32_t lastRefreshMs = 0;
uint32_t lastStatusMs = 0;

void prepareRedFrame() {
  int index = 0;
  for (int pixel = 0; pixel < LED_COUNT; ++pixel) {
    // The installed LEDs expect GRB byte order.
    const uint8_t grb[3] = {0, RED_VALUE, 0};
    for (uint8_t value : grb) {
      for (int bit = 7; bit >= 0; --bit) {
        const bool one = value & (1u << bit);
        auto& item = ledItems[index++];
        item.level0 = 1;
        item.duration0 = one ? 26 : 13;
        item.level1 = 0;
        item.duration1 = one ? 24 : 37;
      }
    }
  }
}

bool showRed() {
  if (!ledReady) return false;
  const esp_err_t result = rmt_write_items(LED_RMT_CHANNEL, ledItems, LED_COUNT * 24, true);
  delayMicroseconds(300);  // LED frame latch/reset time.
  return result == ESP_OK;
}
}  // namespace

void setup() {
  // Keep the motor and IR transmitter inactive during this LED-only test.
  digitalWrite(MOTOR, LOW);
  pinMode(MOTOR, OUTPUT);
  digitalWrite(TX_PIN, LOW);
  pinMode(TX_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(LED_PIN, OUTPUT);

  Serial.begin(115200);
  prepareRedFrame();
  rmt_config_t config = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(LED_PIN), LED_RMT_CHANNEL);
  config.clk_div = 2;
  config.tx_config.idle_output_en = true;
  config.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  esp_err_t result = rmt_config(&config);
  if (result == ESP_OK) result = rmt_driver_install(LED_RMT_CHANNEL, 0, 0);
  ledReady = result == ESP_OK;

  const bool shown = showRed();
  lastRefreshMs = millis();
  Serial.printf("RED_LED_STATUS firmware=%s gpio=%d pixels=%d red=%u green=0 blue=0 ready=%d write_ok=%d\n",
                VERSION, LED_PIN, LED_COUNT, RED_VALUE, ledReady, shown);
}

void loop() {
  const uint32_t now = millis();
  if (now - lastRefreshMs >= 1000) {
    const bool shown = showRed();
    lastRefreshMs = now;
    if (!shown) Serial.println("RED_LED_ERROR write_failed");
  }
  if (now - lastStatusMs >= 5000) {
    Serial.printf("RED_LED_STATUS firmware=%s gpio=%d pixels=%d red=%u green=0 blue=0 ready=%d\n",
                  VERSION, LED_PIN, LED_COUNT, RED_VALUE, ledReady);
    lastStatusMs = now;
  }
  delay(10);
}
