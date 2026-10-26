#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_log.h>
#include <esp_rom_sys.h>
#include <esp32s3/rom/gpio.h>
#include <soc/gpio_sig_map.h>

#if !CONFIG_IDF_TARGET_ESP32S3
#error "GPIO43 LOW diagnostic requires XIAO ESP32-S3 Plus"
#endif
#if !ARDUINO_USB_MODE || !ARDUINO_USB_CDC_ON_BOOT
#error "Keep the board's native USB configuration; do not use Serial on UART0"
#endif

constexpr gpio_num_t DATA_PIN = GPIO_NUM_43; // XIAO D6, legacy PCB J7 DATA
constexpr gpio_num_t MOTOR_PIN = GPIO_NUM_9;
constexpr gpio_num_t IR_PIN = GPIO_NUM_6;

int discardLog(const char*, va_list) { return 0; }

void configureLow(gpio_num_t pin) {
  // Clear the output latch before enabling the output driver.
  gpio_set_level(pin, 0);
  gpio_config_t config{};
  config.pin_bit_mask = 1ULL << pin;
  config.mode = GPIO_MODE_OUTPUT; // Push-pull, not open drain.
  config.pull_up_en = GPIO_PULLUP_DISABLE;
  config.pull_down_en = GPIO_PULLDOWN_ENABLE;
  config.intr_type = GPIO_INTR_DISABLE;
  gpio_config(&config);
  // Explicitly replace UART/RMT routing with the ordinary GPIO output latch.
  gpio_matrix_out(pin, SIG_GPIO_OUT_IDX, false, false);
  gpio_set_level(pin, 0);
}

void setup() {
  esp_log_level_set("*", ESP_LOG_NONE);
  esp_log_set_vprintf(discardLog);
  esp_rom_install_channel_putc(1, nullptr);
  esp_rom_install_channel_putc(2, nullptr);
  configureLow(MOTOR_PIN);
  configureLow(IR_PIN);
  configureLow(DATA_PIN);
  // No Serial.begin(), UART, Wi-Fi, RMT, PWM or switch handling.
  // ROM output during reset/download occurs before this firmware can act.
}

void loop() {
  gpio_set_level(DATA_PIN, 0);
  gpio_set_level(MOTOR_PIN, 0);
  gpio_set_level(IR_PIN, 0);
  delay(10);
}
