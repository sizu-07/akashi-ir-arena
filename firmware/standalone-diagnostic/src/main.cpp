#include <Arduino.h>
#include <driver/rmt.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <esp_log.h>
#include "legacy_4e_profile.h"
#include "ir_protocol.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Standalone diagnostic requires XIAO ESP32-S3 Plus"
#endif

// No Wi-Fi, MQTT, battery interlock, or changes to saved network settings.
constexpr char DIAGNOSTIC_VERSION[] = "standalone-4e42-3";
constexpr uint8_t MOTOR_CHANNEL = 2;
constexpr uint32_t IR_INTERVAL_MS = 250;
constexpr rmt_channel_t IR_CHANNEL = static_cast<rmt_channel_t>(TX_CHANNEL);
constexpr rmt_channel_t LED_RMT_CHANNEL = static_cast<rmt_channel_t>(LED_CHANNEL);
RingbufHandle_t rxRings[RX_COUNT]{};
struct RxEdge { int64_t timeUs; uint8_t receiver, level; };
QueueHandle_t edgeQueue = nullptr;
int receiverIndices[RX_COUNT] = {0, 1, 2};
volatile uint32_t edgeLost[RX_COUNT]{};
uint32_t reportedEdgeLost[RX_COUNT]{};
bool ledReady = false, irReady = false, txBusy = false, outputsOn = false;
bool rawPressed = false, pressed = false, armed = false;
uint32_t changedAt = 0, nextIrAt = 0;
uint32_t rxCount[RX_COUNT]{};
uint8_t txSequence = 0;
rmt_item32_t txItems[34]{}; // Must live until asynchronous transmission completes.

void IRAM_ATTR onRxEdge(void* arg) {
  const int receiver = *static_cast<int*>(arg);
  const RxEdge edge = {esp_timer_get_time(), static_cast<uint8_t>(receiver),
                       static_cast<uint8_t>(gpio_get_level(static_cast<gpio_num_t>(RX_PINS[receiver])))};
  BaseType_t wake = pdFALSE;
  if (xQueueSendFromISR(edgeQueue, &edge, &wake) != pdTRUE) ++edgeLost[receiver];
  if (wake) portYIELD_FROM_ISR();
}

void reportReceiverEdges() {
  RxEdge edge;
  for (int drained = 0; drained < 64 && edgeQueue && xQueueReceive(edgeQueue, &edge, 0) == pdTRUE; ++drained) {
    // This logs GPIO changes even if RMT never forms a received block.
    Serial.printf("RX_EDGE firmware=%s receiver=%s gpio=%d time_us=%llu level=%s\n",
                  DIAGNOSTIC_VERSION, RX_IDS[edge.receiver], RX_PINS[edge.receiver],
                  static_cast<unsigned long long>(edge.timeUs), edge.level ? "HIGH" : "LOW");
  }
  for (int i = 0; i < RX_COUNT; ++i) {
    const uint32_t lost = edgeLost[i];
    if (lost != reportedEdgeLost[i]) {
      Serial.printf("RX_OVERFLOW receiver=%s lost_edges=%lu\n", RX_IDS[i], static_cast<unsigned long>(lost));
      reportedEdgeLost[i] = lost;
    }
  }
}

bool writeLeds(bool on) {
  if (!ledReady) return false;
  rmt_item32_t items[LED_COUNT * 24]{};
  const uint8_t value = on ? 51 : 0;
  for (size_t i = 0; i < LED_COUNT * 24; ++i) {
    const bool one = value & (1u << (7 - i % 8));
    items[i].level0 = 1; items[i].duration0 = one ? 26 : 13;
    items[i].level1 = 0; items[i].duration1 = one ? 24 : 37;
  }
  const auto result = rmt_write_items(LED_RMT_CHANNEL, items, LED_COUNT * 24, true);
  delayMicroseconds(300);
  return result == ESP_OK;
}

void setOutputs(bool on) {
  // A missing LED does not prevent the other modules from being tested.
  ledcWrite(MOTOR_CHANNEL, on ? SHOT_MOTOR_DUTY : 0);
  outputsOn = on;
  writeLeds(on);
  if (on) nextIrAt = millis();
  // A frame already in flight finishes within 90 ms, then IR stays LOW.
}

void sendTestFrame() {
  const uint32_t frame = irFrame(1, txSequence++);
  txItems[0].level0 = 1; txItems[0].duration0 = 9000;
  txItems[0].level1 = 0; txItems[0].duration1 = 4500;
  for (int i = 0; i < 32; ++i) {
    txItems[i + 1].level0 = 1; txItems[i + 1].duration0 = 560;
    txItems[i + 1].level1 = 0;
    txItems[i + 1].duration1 = frame & (1u << (31 - i)) ? 1690 : 560;
  }
  txItems[33].level0 = 1; txItems[33].duration0 = 560;
  txItems[33].level1 = 0; txItems[33].duration1 = 1000;
  const auto result = rmt_write_items(IR_CHANNEL, txItems, 34, false);
  if (result == ESP_OK) txBusy = true;
}

bool nearDuration(uint16_t got, uint16_t expected) {
  return got > expected * 0.65f && got < expected * 1.35f;
}

void pollReceiver(int receiver) {
  if (!rxRings[receiver]) return;
  size_t bytes = 0;
  auto* items = static_cast<rmt_item32_t*>(xRingbufferReceive(rxRings[receiver], &bytes, 0));
  if (!items) return;
  ++rxCount[receiver];
  // Keep every captured pulse in the raw log, including CRC failures and noise.
  uint16_t durations[128]{}; uint8_t levels[128]{}; int stored = 0;
  String raw; raw.reserve(1200);
  for (size_t i = 0; i < bytes / sizeof(rmt_item32_t); ++i) {
    const uint16_t duration[] = {static_cast<uint16_t>(items[i].duration0), static_cast<uint16_t>(items[i].duration1)};
    const uint8_t level[] = {static_cast<uint8_t>(items[i].level0), static_cast<uint8_t>(items[i].level1)};
    for (int half = 0; half < 2; ++half) if (duration[half]) {
      char pulse[16]; snprintf(pulse, sizeof(pulse), "%c%u,", level[half] ? 'H' : 'L', duration[half]);
      raw += pulse;
      if (stored < 128) { durations[stored] = duration[half]; levels[stored++] = level[half]; }
    }
  }
  vRingbufferReturnItem(rxRings[receiver], items);
  Serial.printf("RX_RAW firmware=%s time_ms=%lu receiver=%s gpio=%d count=%lu duration_unit=us pulses=%s\n",
                DIAGNOSTIC_VERSION, static_cast<unsigned long>(millis()), RX_IDS[receiver], RX_PINS[receiver],
                static_cast<unsigned long>(rxCount[receiver]), raw.c_str());
  bool decoded = false;
  for (int begin = 0; begin + 65 < stored; ++begin) {
    if (levels[begin] != 0 || levels[begin + 1] != 1 ||
        !nearDuration(durations[begin], 9000) || !nearDuration(durations[begin + 1], 4500)) continue;
    uint32_t frame = 0; bool bitsValid = true;
    for (int bit = 0; bit < 32; ++bit) {
      const int at = begin + 2 + bit * 2;
      if (levels[at] != 0 || levels[at + 1] != 1 || !nearDuration(durations[at], 560)) { bitsValid = false; break; }
      frame <<= 1;
      if (nearDuration(durations[at + 1], 1690)) frame |= 1;
      else if (!nearDuration(durations[at + 1], 560)) { bitsValid = false; break; }
    }
    if (!bitsValid) continue;
    decoded = true;
    Serial.printf("RX_FRAME receiver=%s frame=0x%08lX game_crc=%s shooter=%u seq=%u weapon=%u flags=%u\n",
                  RX_IDS[receiver], static_cast<unsigned long>(frame), irValid(frame) ? "OK" : "INVALID",
                  unsigned((frame >> 22) & 255), unsigned((frame >> 14) & 255),
                  unsigned((frame >> 10) & 15), unsigned((frame >> 8) & 3));
  }
  if (!decoded) Serial.printf("RX_FRAME receiver=%s decode=UNKNOWN see_RX_RAW\n", RX_IDS[receiver]);
}

void setup() {
  esp_log_level_set("*", ESP_LOG_NONE);
  digitalWrite(MOTOR, LOW); pinMode(MOTOR, OUTPUT);
  digitalWrite(TX_PIN, LOW); pinMode(TX_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW); pinMode(LED_PIN, OUTPUT);
  pinMode(TRIGGER, INPUT_PULLUP); pinMode(SW_MODE, INPUT_PULLUP); pinMode(SW_RELOAD, INPUT_PULLUP);
  Serial.begin(115200);
  edgeQueue = xQueueCreate(256, sizeof(RxEdge));
  ledcSetup(MOTOR_CHANNEL, 5000, 8); ledcAttachPin(MOTOR, MOTOR_CHANNEL); ledcWrite(MOTOR_CHANNEL, 0);

  rmt_config_t led = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(LED_PIN), LED_RMT_CHANNEL);
  led.clk_div = 2; led.tx_config.idle_output_en = true; led.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  auto result = rmt_config(&led);
  if (result == ESP_OK) result = rmt_driver_install(LED_RMT_CHANNEL, 0, 0);
  ledReady = result == ESP_OK;
  if (ledReady) writeLeds(false);

  rmt_config_t tx = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(TX_PIN), IR_CHANNEL);
  tx.clk_div = 80; tx.tx_config.carrier_en = true; tx.tx_config.carrier_freq_hz = 38000;
  tx.tx_config.carrier_duty_percent = 33; tx.tx_config.carrier_level = RMT_CARRIER_LEVEL_HIGH;
  tx.tx_config.idle_output_en = true; tx.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  result = rmt_config(&tx);
  if (result == ESP_OK) result = rmt_driver_install(IR_CHANNEL, 0, 0);
  irReady = result == ESP_OK;

  for (int i = 0; i < RX_COUNT; ++i) {
    pinMode(RX_PINS[i], INPUT_PULLUP);
    const auto channel = static_cast<rmt_channel_t>(RX_CHANNELS[i]);
    rmt_config_t rx = RMT_DEFAULT_CONFIG_RX(static_cast<gpio_num_t>(RX_PINS[i]), channel);
    rx.clk_div = 80; rx.rx_config.filter_en = false; rx.rx_config.idle_threshold = 12000;
    result = rmt_config(&rx);
    if (result == ESP_OK) result = rmt_driver_install(channel, 8192, 0);
    if (result == ESP_OK) result = rmt_get_ringbuf_handle(channel, &rxRings[i]);
    if (result == ESP_OK) result = rmt_rx_start(channel, true);
    if (result != ESP_OK) rxRings[i] = nullptr;
    if (edgeQueue) attachInterruptArg(RX_PINS[i], onRxEdge, &receiverIndices[i], CHANGE);
  }
  rawPressed = pressed = digitalRead(TRIGGER) == LOW;
  armed = !pressed; changedAt = millis();
}

void loop() {
  const uint32_t now = millis();
  const bool raw = digitalRead(TRIGGER) == LOW;
  if (raw != rawPressed) { rawPressed = raw; changedAt = now; }
  if (raw != pressed && now - changedAt >= 20) {
    pressed = raw;
    if (!pressed) { setOutputs(false); armed = true; }
    else if (armed) { armed = false; setOutputs(true); }
  }
  if (txBusy && rmt_wait_tx_done(IR_CHANNEL, 0) == ESP_OK) txBusy = false;
  if (outputsOn && irReady && !txBusy && int32_t(now - nextIrAt) >= 0) {
    sendTestFrame(); nextIrAt = millis() + IR_INTERVAL_MS;
  }
  reportReceiverEdges();
  for (int i = 0; i < RX_COUNT; ++i) pollReceiver(i);
  delay(1);
}
