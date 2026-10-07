#include <Arduino.h>
#include <initializer_list>
#include <driver/gpio.h>
#include <driver/rmt.h>
#include <esp_log.h>
#include <esp_timer.h>
#include "ir_protocol.h"
#include "pulse_decoder.h"

#if !CONFIG_IDF_TARGET_ESP32S3 || !ARDUINO_USB_CDC_ON_BOOT
#error "Receiver diagnostic requires ESP32-S3 USB CDC, not UART on GPIO43/44"
#endif

constexpr char VERSION[] = "receiver-only-44-1";
constexpr int RX_PIN = 44;
constexpr rmt_channel_t RX_CHANNEL = RMT_CHANNEL_4;
constexpr size_t EDGE_QUEUE_SIZE = 2048;
constexpr size_t MAX_DECODE_PULSES = 512;
struct Edge { int64_t timeUs; uint8_t level; };
QueueHandle_t edgeQueue = nullptr;
RingbufHandle_t rxRing = nullptr;
volatile uint32_t lostEdges = 0;
uint32_t reportedLost = 0, blockCount = 0;
int64_t previousEdgeUs = 0;
bool receiverReady = false;

void IRAM_ATTR onEdge() {
  const Edge edge = {esp_timer_get_time(), static_cast<uint8_t>(gpio_get_level(GPIO_NUM_44))};
  BaseType_t wake = pdFALSE;
  if (xQueueSendFromISR(edgeQueue, &edge, &wake) != pdTRUE) ++lostEdges;
  if (wake) portYIELD_FROM_ISR();
}

void reportEdges() {
  Edge edge;
  for (int i = 0; i < 64 && edgeQueue && xQueueReceive(edgeQueue, &edge, 0) == pdTRUE; ++i) {
    const unsigned long long interval = previousEdgeUs ? edge.timeUs - previousEdgeUs : 0;
    Serial.printf("RX_EDGE firmware=%s gpio=%d time_us=%llu level=%s previous_level_us=%llu\n",
                  VERSION, RX_PIN, static_cast<unsigned long long>(edge.timeUs),
                  edge.level ? "HIGH" : "LOW", interval);
    previousEdgeUs = edge.timeUs;
  }
  const uint32_t lost = lostEdges;
  if (lost != reportedLost) {
    Serial.printf("RX_OVERFLOW gpio=%d lost_edges=%lu\n", RX_PIN, static_cast<unsigned long>(lost));
    reportedLost = lost;
    previousEdgeUs = 0;
  }
}

void reportClassification(const Pulse* pulses, size_t count, bool truncated) {
  size_t from = 0;
  bool found = false;
  while (from < count) {
    const auto decoded = decodeEnvelope(pulses, count, from);
    if (!decoded.found) break;
    found = true;
    from = decoded.next;
    const uint32_t frame = decoded.value;
    const bool valid = irValid(frame);
    const bool crc = uint8_t(frame) == irCrc(frame >> 8);
    const unsigned flags = (frame >> 8) & 3;
    Serial.printf("RX_RESULT firmware=%s gpio=%d count=%lu type=%s frame=0x%08lX game_crc=%s version=%u shooter=%u seq=%u weapon=%u flags=%u kind=%s\n",
                  VERSION, RX_PIN, static_cast<unsigned long>(blockCount),
                  valid ? "GAME" : "GAME_LIKE_INVALID", static_cast<unsigned long>(frame),
                  crc ? "OK" : "INVALID", unsigned(frame >> 30), unsigned((frame >> 22) & 255),
                  unsigned((frame >> 14) & 255), unsigned((frame >> 10) & 15), flags,
                  valid ? (flags == 0 ? "SHOT" : "RESCUE") : "UNKNOWN");
  }
  if (!found)
    Serial.printf("RX_RESULT firmware=%s gpio=%d count=%lu type=OTHER_OR_UNDECODED reason=NO_COMPLETE_GAME_ENVELOPE\n",
                  VERSION, RX_PIN, static_cast<unsigned long>(blockCount));
  if (truncated)
    Serial.printf("RX_OVERFLOW gpio=%d count=%lu decode_truncated=YES raw_preserved=YES\n",
                  RX_PIN, static_cast<unsigned long>(blockCount));
}

void pollReceiver() {
  if (!rxRing) return;
  size_t bytes = 0;
  auto* items = static_cast<rmt_item32_t*>(xRingbufferReceive(rxRing, &bytes, 0));
  if (!items) return;
  ++blockCount;
  Pulse pulses[MAX_DECODE_PULSES]{};
  size_t stored = 0, total = 0;
  String raw;
  raw.reserve(4096);
  for (size_t i = 0; i < bytes / sizeof(rmt_item32_t); ++i) {
    const Pulse halves[] = {{uint16_t(items[i].duration0), uint8_t(items[i].level0)},
                            {uint16_t(items[i].duration1), uint8_t(items[i].level1)}};
    for (const auto& pulse : halves) {
      if (!pulse.duration) continue;
      char text[16];
      snprintf(text, sizeof(text), "%c%u,", pulse.level ? 'H' : 'L', pulse.duration);
      raw += text;
      ++total;
      if (stored < MAX_DECODE_PULSES) pulses[stored++] = pulse;
    }
  }
  vRingbufferReturnItem(rxRing, items);
  Serial.printf("RX_RAW firmware=%s time_ms=%lu gpio=%d count=%lu pulse_count=%u duration_unit=us pulses=%s\n",
                VERSION, static_cast<unsigned long>(millis()), RX_PIN,
                static_cast<unsigned long>(blockCount), unsigned(total), raw.c_str());
  reportClassification(pulses, stored, total > stored);
}

void setup() {
  esp_log_level_set("*", ESP_LOG_NONE);
  // Hold the assembled board's outputs off if it is still attached.
  for (const int pin : {6, 9, 42}) { digitalWrite(pin, LOW); pinMode(pin, OUTPUT); }
  Serial.begin(115200);
  pinMode(RX_PIN, INPUT_PULLUP);
  edgeQueue = xQueueCreate(EDGE_QUEUE_SIZE, sizeof(Edge));
  rmt_config_t rx = RMT_DEFAULT_CONFIG_RX(GPIO_NUM_44, RX_CHANNEL);
  rx.clk_div = 80; // 1 us at 80 MHz APB.
  rx.mem_block_num = 4; // RX channels 4..7 are exclusively allocated to this receiver.
  rx.rx_config.filter_en = false;
  rx.rx_config.idle_threshold = 12000;
  auto result = rmt_config(&rx);
  if (result == ESP_OK) result = rmt_driver_install(RX_CHANNEL, 32768, 0);
  if (result == ESP_OK) result = rmt_get_ringbuf_handle(RX_CHANNEL, &rxRing);
  if (result == ESP_OK) result = rmt_rx_start(RX_CHANNEL, true);
  if (result != ESP_OK) rxRing = nullptr;
  if (edgeQueue) attachInterrupt(RX_PIN, onEdge, CHANGE);
  receiverReady = result == ESP_OK && edgeQueue;
}

void loop() {
  if (!receiverReady) {
    Serial.println("RX_ERROR firmware=receiver-only-44-1 receiver_initialization=FAILED");
    delay(1000);
    return;
  }
  // Drain captured frames before verbose edge output to reduce RX ring pressure.
  pollReceiver();
  reportEdges();
  delay(1);
}
