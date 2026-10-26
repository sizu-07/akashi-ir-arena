#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/rmt.h>
#include <esp_log.h>
#include "legacy_4e_profile.h"

#if !CONFIG_IDF_TARGET_ESP32S3 || !ARDUINO_USB_CDC_ON_BOOT
#error "This diagnostic requires ESP32-S3 USB CDC"
#endif

// Receiver-only test for the assembled 4E board. Preferences/NVS are untouched.
constexpr char VERSION[] = "receiver-raw-4e42-2";
RingbufHandle_t rxRings[RX_COUNT]{};
volatile uint32_t edgeCounts[RX_COUNT]{};
uint32_t blockCounts[RX_COUNT]{};
int receiverIndices[RX_COUNT] = {0, 1, 2};
bool ready[RX_COUNT]{};

void IRAM_ATTR countEdge(void* arg) {
  ++edgeCounts[*static_cast<int*>(arg)];
}

void pollReceiver(int receiver) {
  if (!rxRings[receiver]) return;
  size_t bytes = 0;
  auto* items = static_cast<rmt_item32_t*>(xRingbufferReceive(rxRings[receiver], &bytes, 0));
  if (!items) return;
  const uint32_t block = ++blockCounts[receiver];
  Serial.printf("IR_RAW firmware=%s receiver=%s gpio=%d block=%lu duration_unit=us pulses=",
                VERSION, RX_IDS[receiver], RX_PINS[receiver], static_cast<unsigned long>(block));
  for (size_t i = 0; i < bytes / sizeof(rmt_item32_t); ++i) {
    if (items[i].duration0)
      Serial.printf("%c%u,", items[i].level0 ? 'H' : 'L', items[i].duration0);
    if (items[i].duration1)
      Serial.printf("%c%u,", items[i].level1 ? 'H' : 'L', items[i].duration1);
  }
  Serial.println();
  vRingbufferReturnItem(rxRings[receiver], items);
}

void setup() {
  esp_log_level_set("*", ESP_LOG_NONE);
  // No IR transmission, vibration, or LED activity during this test.
  for (const int pin : {TX_PIN, MOTOR, LED_PIN}) {
    digitalWrite(pin, LOW);
    pinMode(pin, OUTPUT);
  }
  Serial.begin(115200);
  for (int i = 0; i < RX_COUNT; ++i) {
    pinMode(RX_PINS[i], INPUT_PULLUP);
    auto channel = static_cast<rmt_channel_t>(RX_CHANNELS[i]);
    rmt_config_t rx = RMT_DEFAULT_CONFIG_RX(static_cast<gpio_num_t>(RX_PINS[i]), channel);
    rx.clk_div = 80; // 1 microsecond per tick.
    rx.mem_block_num = 1; // Channels 4, 5, and 6 operate independently.
    rx.rx_config.filter_en = false;
    rx.rx_config.idle_threshold = 12000;
    auto result = rmt_config(&rx);
    if (result == ESP_OK) result = rmt_driver_install(channel, 8192, 0);
    if (result == ESP_OK) result = rmt_get_ringbuf_handle(channel, &rxRings[i]);
    if (result == ESP_OK) result = rmt_rx_start(channel, true);
    ready[i] = result == ESP_OK && rxRings[i];
    if (ready[i]) attachInterruptArg(RX_PINS[i], countEdge, &receiverIndices[i], CHANGE);
  }
  Serial.printf("BOOT firmware=%s baud=115200 rx1=GPIO%d rx2=GPIO%d rx3=GPIO%d ready=%d%d%d\n",
                VERSION, RX_PINS[0], RX_PINS[1], RX_PINS[2], ready[0], ready[1], ready[2]);
}

void loop() {
  for (int i = 0; i < RX_COUNT; ++i) pollReceiver(i);
  static uint32_t lastActivity = 0, lastStatus = 0, lastEdges[RX_COUNT]{};
  if (millis() - lastStatus >= 5000) {
    lastStatus = millis();
    Serial.printf("IR_STATUS firmware=%s ready=%d%d%d rx1_gpio=%d rx1_level=%d rx1_blocks=%lu rx2_gpio=%d rx2_level=%d rx2_blocks=%lu rx3_gpio=%d rx3_level=%d rx3_blocks=%lu\n",
                  VERSION, ready[0], ready[1], ready[2],
                  RX_PINS[0], digitalRead(RX_PINS[0]),
                  static_cast<unsigned long>(blockCounts[0]),
                  RX_PINS[1], digitalRead(RX_PINS[1]),
                  static_cast<unsigned long>(blockCounts[1]),
                  RX_PINS[2], digitalRead(RX_PINS[2]),
                  static_cast<unsigned long>(blockCounts[2]));
  }
  if (millis() - lastActivity >= 1000) {
    lastActivity = millis();
    for (int i = 0; i < RX_COUNT; ++i) {
      if (!ready[i]) {
        Serial.printf("IR_ERROR receiver=%s gpio=%d initialization=FAILED\n", RX_IDS[i], RX_PINS[i]);
      } else {
        const uint32_t edges = edgeCounts[i];
        if (edges != lastEdges[i])
          Serial.printf("IR_ACTIVITY receiver=%s gpio=%d edges=%lu blocks=%lu\n",
                        RX_IDS[i], RX_PINS[i], static_cast<unsigned long>(edges - lastEdges[i]),
                        static_cast<unsigned long>(blockCounts[i]));
        lastEdges[i] = edges;
      }
    }
  }
  delay(1);
}
