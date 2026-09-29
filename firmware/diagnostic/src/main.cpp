#include <Arduino.h>
#include <driver/rmt.h>
#include <esp_timer.h>
#include "hardware_profile.h"
#include "ir_protocol.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Board diagnostics require XIAO ESP32-S3 Plus"
#endif

// Bench firmware: no Wi-Fi, stored settings, or automatic output tests.
// Attach only hardware wired for the v0.7 profile before enabling an output.
constexpr rmt_channel_t TX_CH = static_cast<rmt_channel_t>(TX_CHANNEL);
constexpr rmt_channel_t LED_CH = static_cast<rmt_channel_t>(LED_CHANNEL);
RingbufHandle_t rxRings[RX_COUNT]{};
uint32_t rxValid[RX_COUNT]{}, rxInvalid[RX_COUNT]{};
esp_timer_handle_t motorTimer = nullptr;
uint32_t motorLastStart = 0;
bool motorRunning = false, triggerDown = false;
String commandLine;

void stopMotor(void* = nullptr) {
  digitalWrite(MOTOR, LOW);
  motorRunning = false;
}

void showLeds(uint8_t index, uint8_t red, uint8_t green, uint8_t blue) {
  uint8_t colors[LED_COUNT][3]{};
  if (index == 0) {
    for (int i = 0; i < LED_COUNT; ++i) {
      colors[i][0] = red; colors[i][1] = green; colors[i][2] = blue;
    }
  } else if (index <= LED_COUNT) {
    colors[index - 1][0] = red;
    colors[index - 1][1] = green;
    colors[index - 1][2] = blue;
  }
  rmt_item32_t items[LED_COUNT * 24]{};
  int n = 0;
  for (const auto& color : colors) {
    const uint8_t grb[] = {color[1], color[0], color[2]};
    for (uint8_t value : grb) for (int bit = 7; bit >= 0; --bit) {
      auto& item = items[n++];
      const bool one = value & (1 << bit);
      item.level0 = 1; item.duration0 = one ? 24 : 12;
      item.level1 = 0; item.duration1 = one ? 24 : 36;
    }
  }
  rmt_write_items(LED_CH, items, n, true);
  delayMicroseconds(100);
}

void sendIr() {
  const uint32_t frame = irFrame(1, 1);
  rmt_item32_t items[34]{};
  items[0].level0 = 1; items[0].duration0 = 9000;
  items[0].level1 = 0; items[0].duration1 = 4500;
  for (int i = 0; i < 32; ++i) {
    items[i + 1].level0 = 1; items[i + 1].duration0 = 560;
    items[i + 1].level1 = 0;
    items[i + 1].duration1 = (frame & (1u << (31 - i))) ? 1690 : 560;
  }
  items[33].level0 = 1; items[33].duration0 = 560;
  items[33].level1 = 0; items[33].duration1 = 1000;
  rmt_write_items(TX_CH, items, 34, true);
}

bool nearDuration(uint16_t got, uint16_t expected) {
  return got > expected * 0.65f && got < expected * 1.35f;
}

void pollReceiver(int receiver) {
  size_t bytes = 0;
  auto* items = static_cast<rmt_item32_t*>(xRingbufferReceive(rxRings[receiver], &bytes, 0));
  if (!items) return;
  uint16_t durations[256]{};
  uint8_t levels[256]{};
  int pulses = 0;
  for (size_t i = 0; i < bytes / sizeof(rmt_item32_t) && pulses < 254; ++i) {
    if (items[i].duration0) {
      durations[pulses] = items[i].duration0;
      levels[pulses++] = items[i].level0;
    }
    if (items[i].duration1) {
      durations[pulses] = items[i].duration1;
      levels[pulses++] = items[i].level1;
    }
  }
  vRingbufferReturnItem(rxRings[receiver], items);
  bool valid = false;
  for (int begin = 0; begin + 65 < pulses && !valid; ++begin) {
    if (levels[begin] != 0 || levels[begin + 1] != 1 ||
        !nearDuration(durations[begin], 9000) || !nearDuration(durations[begin + 1], 4500)) continue;
    uint32_t frame = 0;
    valid = true;
    for (int bit = 0; bit < 32; ++bit) {
      const int at = begin + 2 + bit * 2;
      if (levels[at] != 0 || levels[at + 1] != 1 || !nearDuration(durations[at], 560)) {
        valid = false; break;
      }
      frame <<= 1;
      if (nearDuration(durations[at + 1], 1690)) frame |= 1;
      else if (!nearDuration(durations[at + 1], 560)) { valid = false; break; }
    }
    if (valid) valid = irValid(frame);
  }
  if (valid) {
    ++rxValid[receiver];
    Serial.printf("RX %s valid=%lu\n", RX_IDS[receiver], static_cast<unsigned long>(rxValid[receiver]));
  } else ++rxInvalid[receiver];
}

void status() {
  Serial.printf("PROFILE %s\n", HARDWARE_PROFILE);
  Serial.printf("CHIP %s FLASH_MB %u\n", ESP.getChipModel(), ESP.getFlashChipSize() / 1048576);
  Serial.printf("TRIGGER %s BATTERY_ADC_MV %lu\n", triggerDown ? "PRESSED" : "RELEASED",
                static_cast<unsigned long>(analogReadMilliVolts(BATTERY)));
  for (int i = 0; i < RX_COUNT; ++i)
    Serial.printf("RX %s valid=%lu invalid=%lu\n", RX_IDS[i],
                  static_cast<unsigned long>(rxValid[i]), static_cast<unsigned long>(rxInvalid[i]));
  Serial.printf("MOTOR %s\n", motorRunning ? "ON" : "OFF");
}

void command(String line) {
  line.trim(); line.toLowerCase();
  if (line == "help") {
    Serial.println("COMMANDS: help, status, led off, led red|green|blue [1-6], motor, ir");
  } else if (line == "status") status();
  else if (line == "led off") { showLeds(0, 0, 0, 0); Serial.println("OK LED OFF"); }
  else if (line.startsWith("led ")) {
    String rest = line.substring(4);
    int space = rest.indexOf(' ');
    String color = space < 0 ? rest : rest.substring(0, space);
    String number = space < 0 ? "" : rest.substring(space + 1);
    uint8_t index = 0;
    if (number.length() == 1 && number[0] >= '1' && number[0] <= '0' + LED_COUNT)
      index = number[0] - '0';
    else if (number.length()) { Serial.println("ERROR LED INDEX"); return; }
    if (color == "red") showLeds(index, 28, 0, 0);
    else if (color == "green") showLeds(index, 0, 28, 0);
    else if (color == "blue") showLeds(index, 0, 0, 28);
    else { Serial.println("ERROR LED COLOR"); return; }
    Serial.println("OK LED");
  } else if (line == "motor") {
    const uint32_t now = millis();
    if (motorRunning || (motorLastStart && now - motorLastStart < MOTOR_MIN_INTERVAL_MS)) {
      Serial.println("ERROR MOTOR COOLDOWN"); return;
    }
    motorLastStart = now;
    digitalWrite(MOTOR, HIGH); motorRunning = true;
    if (esp_timer_start_once(motorTimer, SHOT_PULSE_MS * 1000) != ESP_OK) {
      stopMotor(); Serial.println("ERROR MOTOR TIMER"); return;
    }
    Serial.printf("OK MOTOR %lu ms\n", static_cast<unsigned long>(SHOT_PULSE_MS));
  } else if (line == "ir") { sendIr(); Serial.println("OK IR SENT"); }
  else if (line.length()) Serial.println("ERROR UNKNOWN COMMAND");
}

void setup() {
  pinMode(MOTOR, OUTPUT); stopMotor();
  pinMode(TX_PIN, OUTPUT); digitalWrite(TX_PIN, LOW);
  pinMode(LED_PIN, OUTPUT); digitalWrite(LED_PIN, LOW);
  pinMode(TRIGGER, INPUT_PULLUP);
  for (int pin : RX_PINS) pinMode(pin, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(BATTERY, ADC_11db);
  Serial.begin(115200);
  esp_timer_create_args_t timerArgs{};
  timerArgs.callback = stopMotor; timerArgs.name = "diag-motor-off";
  ESP_ERROR_CHECK(esp_timer_create(&timerArgs, &motorTimer));

  rmt_config_t tx = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(TX_PIN), TX_CH);
  tx.clk_div = 80; tx.tx_config.carrier_en = true;
  tx.tx_config.carrier_freq_hz = 38000; tx.tx_config.carrier_duty_percent = 33;
  tx.tx_config.carrier_level = RMT_CARRIER_LEVEL_HIGH;
  tx.tx_config.idle_output_en = true; tx.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  ESP_ERROR_CHECK(rmt_config(&tx)); ESP_ERROR_CHECK(rmt_driver_install(TX_CH, 0, 0));
  for (int i = 0; i < RX_COUNT; ++i) {
    auto ch = static_cast<rmt_channel_t>(RX_CHANNELS[i]);
    rmt_config_t rx = RMT_DEFAULT_CONFIG_RX(static_cast<gpio_num_t>(RX_PINS[i]), ch);
    rx.clk_div = 80; rx.rx_config.filter_en = true;
    rx.rx_config.filter_ticks_thresh = 100; rx.rx_config.idle_threshold = 12000;
    ESP_ERROR_CHECK(rmt_config(&rx)); ESP_ERROR_CHECK(rmt_driver_install(ch, 4096, 0));
    ESP_ERROR_CHECK(rmt_get_ringbuf_handle(ch, &rxRings[i]));
    ESP_ERROR_CHECK(rmt_rx_start(ch, true));
  }
  rmt_config_t led = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(LED_PIN), LED_CH);
  led.clk_div = 2; led.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  ESP_ERROR_CHECK(rmt_config(&led)); ESP_ERROR_CHECK(rmt_driver_install(LED_CH, 0, 0));
  showLeds(0, 0, 0, 0);
  triggerDown = digitalRead(TRIGGER) == LOW;
  Serial.println("BOARD DIAGNOSTICS READY; outputs remain off until commanded");
  command("help"); status();
}

void loop() {
  for (int i = 0; i < RX_COUNT; ++i) pollReceiver(i);
  const bool current = digitalRead(TRIGGER) == LOW;
  if (current != triggerDown) {
    triggerDown = current;
    Serial.printf("TRIGGER %s\n", current ? "PRESSED" : "RELEASED");
  }
  while (Serial.available()) {
    const char c = Serial.read();
    if (c == '\n') { command(commandLine); commandLine = ""; }
    else if (c != '\r') {
      if (commandLine.length() < 64) commandLine += c;
      else commandLine = "";
    }
  }
  delay(1);
}
