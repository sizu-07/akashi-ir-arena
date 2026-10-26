#include <Arduino.h>
#include <driver/rmt.h>
#include <esp_log.h>
#include "legacy_4e_profile.h"
#include "ir_protocol.h"

#if !CONFIG_IDF_TARGET_ESP32S3 || !ARDUINO_USB_CDC_ON_BOOT
#error "Transmitter diagnostic requires XIAO ESP32-S3 USB CDC"
#endif

constexpr char VERSION[] = "transmitter-only-6-1";
constexpr rmt_channel_t CHANNEL = RMT_CHANNEL_0;
constexpr rmt_channel_t LED_OFF_CHANNEL = RMT_CHANNEL_1;
constexpr uint32_t REPEAT_MS = 1000;
bool ready = false, releasedSinceBoot = false;
bool rawPressed = false, pressed = false;
uint32_t changedAt = 0, nextSendAt = 0, transmitted = 0;

bool extinguishLeds() {
  // WS2812s retain the previous colour until they receive an explicit black frame.
  rmt_config_t config = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(LED_PIN), LED_OFF_CHANNEL);
  config.clk_div = 2;
  config.tx_config.idle_output_en = true;
  config.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  auto result = rmt_config(&config);
  if (result == ESP_OK) result = rmt_driver_install(LED_OFF_CHANNEL, 0, 0);
  if (result != ESP_OK) return false;
  rmt_item32_t items[LED_COUNT * 24]{};
  for (auto& item : items) {
    item.level0 = 1; item.duration0 = 13;
    item.level1 = 0; item.duration1 = 37;
  }
  result = rmt_write_items(LED_OFF_CHANNEL, items, LED_COUNT * 24, true);
  delayMicroseconds(300);
  rmt_driver_uninstall(LED_OFF_CHANNEL);
  pinMode(LED_PIN, OUTPUT); digitalWrite(LED_PIN, LOW);
  return result == ESP_OK;
}

void transmit() {
  // Match the actual previously successful reception: shooter 1, sequence 21.
  const uint32_t frame = irFrame(1, 21, 0); // 0x40454447
  rmt_item32_t items[34]{};
  items[0].level0 = 1; items[0].duration0 = 9000;
  items[0].level1 = 0; items[0].duration1 = 4500;
  for (int bit = 0; bit < 32; ++bit) {
    items[bit + 1].level0 = 1; items[bit + 1].duration0 = 560;
    items[bit + 1].level1 = 0;
    items[bit + 1].duration1 = frame & (1u << (31 - bit)) ? 1690 : 560;
  }
  items[33].level0 = 1; items[33].duration0 = 560;
  items[33].level1 = 0; items[33].duration1 = 1000;
  const auto result = rmt_write_items(CHANNEL, items, 34, true);
  if (result == ESP_OK) ++transmitted;
  Serial.printf("TX_TEST firmware=%s gpio=%d count=%lu frame=0x%08lX carrier_hz=38000 duty_percent=33 motor=OFF leds=OFF result=%s\n",
                VERSION, TX_PIN, static_cast<unsigned long>(transmitted),
                static_cast<unsigned long>(frame), result == ESP_OK ? "OK" : "FAILED");
}

void setup() {
  esp_log_level_set("*", ESP_LOG_NONE);
  digitalWrite(MOTOR, LOW); pinMode(MOTOR, OUTPUT);
  digitalWrite(TX_PIN, LOW); pinMode(TX_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW); pinMode(LED_PIN, OUTPUT);
  pinMode(TRIGGER, INPUT_PULLUP);
  Serial.begin(115200);
  const bool ledOff = extinguishLeds();
  rmt_config_t config = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(TX_PIN), CHANNEL);
  config.clk_div = 80;
  config.tx_config.carrier_en = true;
  config.tx_config.carrier_freq_hz = 38000;
  config.tx_config.carrier_duty_percent = 33;
  config.tx_config.carrier_level = RMT_CARRIER_LEVEL_HIGH;
  config.tx_config.idle_output_en = true;
  config.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  auto result = rmt_config(&config);
  if (result == ESP_OK) result = rmt_driver_install(CHANNEL, 0, 0);
  ready = result == ESP_OK && ledOff;
  rawPressed = pressed = digitalRead(TRIGGER) == LOW;
  releasedSinceBoot = !pressed;
  changedAt = millis();
}

void loop() {
  if (!ready) {
    Serial.println("TX_ERROR firmware=transmitter-only-6-1 initialization=FAILED");
    delay(1000);
    return;
  }
  const uint32_t now = millis();
  const bool raw = digitalRead(TRIGGER) == LOW;
  if (raw != rawPressed) { rawPressed = raw; changedAt = now; }
  if (raw != pressed && now - changedAt >= 20) {
    pressed = raw;
    if (!pressed) releasedSinceBoot = true;
    else if (releasedSinceBoot) nextSendAt = now;
  }
  if (pressed && releasedSinceBoot && int32_t(now - nextSendAt) >= 0) {
    transmit();
    nextSendAt = millis() + REPEAT_MS;
  }
  delay(1);
}
