#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mqtt_client.h>
#include <esp_timer.h>
#include <esp_system.h>
#include <driver/rmt.h>
#include "../include/motor_feedback.h"
#include "hardware_profile.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Wi-Fi game diagnostic requires XIAO ESP32-S3 Plus"
#endif

// 4E legacy PCB only. Never initialize the incompatible v0.7 output profile.
constexpr int LEGACY_MOTOR_GPIO = 9;
constexpr int LEGACY_IR_GPIO = 6;
constexpr int LEGACY_SW1_GPIO = 2;
constexpr int LEGACY_LED_GPIO = 43;
constexpr rmt_channel_t LED_RMT_CHANNEL = RMT_CHANNEL_1;
constexpr char DEMO_FIRMWARE_VERSION[] = "legacy-motor-demo-6";
constexpr uint32_t STATUS_INTERVAL_MS = 2000;
constexpr uint32_t WIFI_RETRY_MS = 30000;
constexpr uint32_t DEMO_SHOT_PULSE_MS = legacy_feedback::SHOT_MS;
constexpr uint32_t DEMO_HIT_PULSE_MS = legacy_feedback::HIT_MS;
constexpr uint32_t DEMO_COUNTDOWN_PULSE_MS = legacy_feedback::COUNTDOWN_MS;
constexpr uint32_t DEMO_DEFEAT_PULSE_MS = legacy_feedback::DEFEAT_MS;
constexpr uint32_t DEMO_REVIVE_PULSE_MS = legacy_feedback::REVIVE_MS;
constexpr uint32_t DEMO_MIN_OFF_MS = 100;
constexpr uint8_t MOTOR_CHANNEL = 2;
constexpr uint8_t SHOT_DUTY = legacy_feedback::SHOT_DUTY;
constexpr auto& COUNTDOWN_DUTIES = legacy_feedback::COUNTDOWN_DUTIES;

Preferences prefs;
esp_mqtt_client_handle_t mqtt = nullptr;
esp_timer_handle_t motorTimer = nullptr;
struct MotorCommand { char commandId[81]; char type[24]; };
struct DesiredState {
  char phase[16];
  char commandId[81];
  bool startCommitted;
  int hp;
  int64_t startDeltaMs;
};
QueueHandle_t motorCommands = nullptr;
QueueHandle_t desiredStates = nullptr;
String ssid, password, host, id, key, bootId, serialLine;
String staticIp, staticGateway, staticSubnet;
String lastMotorCommand, lastCountdownCommand;
uint16_t port = 1883;
volatile bool mqttConnected = false;
volatile bool sendHello = false;
volatile uint32_t desiredCount = 0;
volatile uint32_t syncCount = 0;
volatile int syncRtt = -1;
uint32_t lastStatus = 0, lastWifiAttempt = 0, lastTelemetry = 0;
bool mqttStarted = false;
bool scanRequested = false;
volatile bool motorActive = false;
volatile uint32_t lastMotorStop = 0;
uint32_t lastMotorStart = 0, activeMotorStart = 0;
uint32_t demoShots = 0, demoHits = 0, demoDefeats = 0, demoRevives = 0;
uint32_t demoCountdownBeats = 0, demoDefeatPulses = 0;
uint32_t ignoredShots = 0;
volatile uint32_t droppedMotorCommands = 0;
volatile uint8_t motorDuty = 0;
portMUX_TYPE motorMux = portMUX_INITIALIZER_UNLOCKED;
bool ledReady = false, ledsOn = false;
uint8_t defeatPulsesRemaining = 0, countdownIndex = 0;
uint32_t nextDefeatAt = 0, countdownStartAt = 0;
bool countdownPending = false, hpSeen = false;
int lastHp = 0;
enum class MotorPattern { None, Shot, Hit, Countdown, Defeat, Revive };
MotorPattern activePattern = MotorPattern::None;
MotorPattern pendingHpPattern = MotorPattern::None;
legacy_feedback::Trigger trigger;

const char* motorPatternName() {
  if (!motorActive) return "OFF";
  switch (activePattern) {
    case MotorPattern::Shot: return "SHOT";
    case MotorPattern::Hit: return "HIT";
    case MotorPattern::Countdown: return "COUNTDOWN";
    case MotorPattern::Defeat: return "DEFEAT";
    case MotorPattern::Revive: return "REVIVE";
    default: return "OFF";
  }
}

void publishDemoEvent(const char* type, uint32_t count);

void stopMotor(void* = nullptr) {
  portENTER_CRITICAL(&motorMux);
  ledcWrite(MOTOR_CHANNEL, 0);
  motorDuty = 0;
  motorActive = false;
  lastMotorStop = millis();
  portEXIT_CRITICAL(&motorMux);
}

bool pulseMotor(const char* kind, uint32_t durationMs, uint8_t duty,
                MotorPattern pattern, bool continuation = false) {
  const uint32_t now = millis();
  if (!motorTimer || motorActive || (defeatPulsesRemaining && !continuation) ||
      (lastMotorStop && now - lastMotorStop < DEMO_MIN_OFF_MS) ||
      (!continuation && lastMotorStart && now - lastMotorStart < MOTOR_MIN_INTERVAL_MS)) {
    Serial.printf("MOTOR %s SKIPPED cooldown\n", kind);
    ++droppedMotorCommands;
    return false;
  }
  lastMotorStart = now;
  activeMotorStart = now;
  activePattern = pattern;
  ledcWrite(MOTOR_CHANNEL, duty);
  motorDuty = duty;
  motorActive = true;
  if (esp_timer_start_once(motorTimer, uint64_t(durationMs) * 1000) != ESP_OK) {
    stopMotor();
    Serial.printf("MOTOR %s FAILED timer\n", kind);
    return false;
  }
  Serial.printf("MOTOR %s ON duration_ms=%lu duty=%u/255\n", kind,
                static_cast<unsigned long>(durationMs), duty);
  return true;
}

bool writeLeds(bool on) {
  if (!ledReady) return false;
  rmt_item32_t items[legacy_feedback::LED_COUNT * 24]{};
  const uint8_t value = on ? legacy_feedback::LED_WHITE : 0;
  for (size_t i = 0; i < legacy_feedback::LED_COUNT * 24; ++i) {
    const bool one = value & (1u << (7 - (i % 8)));
    items[i].level0 = 1; items[i].duration0 = one ? 26 : 13;
    items[i].level1 = 0; items[i].duration1 = one ? 24 : 37;
  }
  const auto result = rmt_write_items(LED_RMT_CHANNEL, items, legacy_feedback::LED_COUNT * 24, true);
  delayMicroseconds(300);
  if (result != ESP_OK) { Serial.printf("LED transfer failed code=%d\n", result); return false; }
  ledsOn = on;
  return true;
}

void initializeLeds() {
  digitalWrite(LEGACY_LED_GPIO, LOW); pinMode(LEGACY_LED_GPIO, OUTPUT);
  rmt_config_t config = RMT_DEFAULT_CONFIG_TX(static_cast<gpio_num_t>(LEGACY_LED_GPIO), LED_RMT_CHANNEL);
  config.clk_div = 2;
  config.tx_config.idle_output_en = true;
  config.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  auto result = rmt_config(&config);
  if (result == ESP_OK) result = rmt_driver_install(LED_RMT_CHANNEL, 0, 0);
  ledReady = result == ESP_OK;
  if (ledReady) writeLeds(false);
  else Serial.printf("LED init failed code=%d; motor test remains available\n", result);
}

void handleTrigger(uint32_t now) {
  const bool ready = motorTimer && !motorActive && !defeatPulsesRemaining &&
      pendingHpPattern == MotorPattern::None &&
      (!lastMotorStop || uint32_t(now - lastMotorStop) >= DEMO_MIN_OFF_MS) &&
      (!lastMotorStart || uint32_t(now - lastMotorStart) >= MOTOR_MIN_INTERVAL_MS);
  const auto event = trigger.update(digitalRead(LEGACY_SW1_GPIO) == LOW, now, ready);
  if (event == legacy_feedback::TriggerEvent::Released) Serial.println("SW1 RELEASED");
  else if (event == legacy_feedback::TriggerEvent::Ignored) {
    ++ignoredShots;
    Serial.println("SW1 PRESSED: ignored (1-second cooldown or motor busy); not queued");
  } else if (event == legacy_feedback::TriggerEvent::Shot) {
    if (pulseMotor("SHOT", DEMO_SHOT_PULSE_MS, SHOT_DUTY, MotorPattern::Shot)) {
      writeLeds(true);
      publishDemoEvent("motor_demo_shot", ++demoShots);
    } else ++ignoredShots;
  }
}

void startDefeat() {
  if (!pulseMotor("DEFEAT_1", DEMO_DEFEAT_PULSE_MS, legacy_feedback::DEFEAT_DUTY, MotorPattern::Defeat)) return;
  defeatPulsesRemaining = 2;
  nextDefeatAt = millis() + DEMO_DEFEAT_PULSE_MS + 300;
  ++demoDefeatPulses;
  publishDemoEvent("motor_demo_defeat", ++demoDefeats);
}

void startRevive() {
  if (pulseMotor("REVIVE", DEMO_REVIVE_PULSE_MS, 120, MotorPattern::Revive))
    publishDemoEvent("motor_demo_revive", ++demoRevives);
}

void handleMotorCommands() {
  if (!motorCommands) return;
  MotorCommand command{};
  while (xQueueReceive(motorCommands, &command, 0) == pdTRUE) {
    if (lastMotorCommand == command.commandId) continue;
    lastMotorCommand = command.commandId;
    if (strcmp(command.type, "motor_demo_hit") == 0) {
      if (pulseMotor("HIT", DEMO_HIT_PULSE_MS, legacy_feedback::HIT_DUTY, MotorPattern::Hit))
        publishDemoEvent("motor_demo_hit", ++demoHits);
    } else if (strcmp(command.type, "motor_demo_defeat") == 0) {
      startDefeat();
    } else if (strcmp(command.type, "motor_demo_revive") == 0) {
      startRevive();
    }
  }
}

void handleDesired() {
  if (!desiredStates) return;
  DesiredState desired{};
  while (xQueueReceive(desiredStates, &desired, 0) == pdTRUE) {
    if (hpSeen) {
      if (lastHp > 0 && desired.hp <= 0) pendingHpPattern = MotorPattern::Defeat;
      else if (lastHp <= 0 && desired.hp > 0) {
        defeatPulsesRemaining = 0;
        pendingHpPattern = MotorPattern::Revive;
      }
    }
    lastHp = desired.hp;
    hpSeen = true;
    const bool counting = strcmp(desired.phase, "COUNTDOWN") == 0 && desired.startCommitted &&
                          desired.commandId[0] && desired.startDeltaMs > 0 && desired.startDeltaMs <= 10000;
    if (!counting) {
      countdownPending = false;
      if (activePattern == MotorPattern::Countdown && motorActive) {
        esp_timer_stop(motorTimer);
        stopMotor();
      }
    } else if (lastCountdownCommand != desired.commandId) {
      lastCountdownCommand = desired.commandId;
      countdownStartAt = millis() + static_cast<uint32_t>(desired.startDeltaMs);
      countdownIndex = 0;
      countdownPending = true;
      Serial.printf("COUNTDOWN vibration scheduled start_in_ms=%lld\n",
                    static_cast<long long>(desired.startDeltaMs));
    }
  }
}

void handleMotorSequence(uint32_t now) {
  if (pendingHpPattern != MotorPattern::None && !motorActive && !defeatPulsesRemaining &&
      (!lastMotorStop || now - lastMotorStop >= DEMO_MIN_OFF_MS) &&
      (!lastMotorStart || now - lastMotorStart >= MOTOR_MIN_INTERVAL_MS)) {
    MotorPattern pending = pendingHpPattern;
    pendingHpPattern = MotorPattern::None;
    if (pending == MotorPattern::Defeat) startDefeat();
    else startRevive();
  }
  if (motorActive && activePattern == MotorPattern::Revive) {
    portENTER_CRITICAL(&motorMux);
    const uint32_t elapsed = now - activeMotorStart;
    if (motorActive && elapsed < DEMO_REVIVE_PULSE_MS) {
      motorDuty = legacy_feedback::reviveDuty(elapsed);
      ledcWrite(MOTOR_CHANNEL, motorDuty);
    }
    portEXIT_CRITICAL(&motorMux);
  }
  if (defeatPulsesRemaining && static_cast<int32_t>(now - nextDefeatAt) >= 0) {
    if (pulseMotor("DEFEAT", DEMO_DEFEAT_PULSE_MS, legacy_feedback::DEFEAT_DUTY, MotorPattern::Defeat, true)) {
      --defeatPulsesRemaining;
      nextDefeatAt = now + DEMO_DEFEAT_PULSE_MS + 300;
      ++demoDefeatPulses;
    }
  }
  if (countdownPending && countdownIndex < 5) {
    const uint32_t mark = countdownStartAt - (5 - countdownIndex) * 1000;
    if (static_cast<int32_t>(now - mark) >= 0) {
      if (static_cast<int32_t>(now - mark) <= 150 &&
          pulseMotor("COUNTDOWN", DEMO_COUNTDOWN_PULSE_MS,
                     COUNTDOWN_DUTIES[countdownIndex], MotorPattern::Countdown)) {
        ++demoCountdownBeats;
        Serial.printf("COUNTDOWN beat=%u/5\n", countdownIndex + 1);
      }
      ++countdownIndex;
      if (countdownIndex == 5) countdownPending = false;
    }
  }
}

void wifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_CONNECTED)
    Serial.println("WIFI ASSOCIATED: waiting for DHCP address");
  else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED)
    Serial.printf("WIFI DISCONNECTED reason=%d\n", info.wifi_sta_disconnected.reason);
  else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP)
    Serial.printf("WIFI GOT_IP ip=%s gateway=%s\n",
                  WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str());
}

void publish(const char* suffix, JsonDocument& payload, int qos = 1) {
  if (!mqttConnected) return;
  String topic = "irgame/v1/device/" + id + "/" + suffix;
  String body;
  serializeJson(payload, body);
  esp_mqtt_client_publish(mqtt, topic.c_str(), body.c_str(), body.length(), qos, 0);
}

void publishDemoEvent(const char* type, uint32_t count) {
  StaticJsonDocument<192> doc;
  doc["type"] = type;
  doc["boot_id"] = bootId;
  doc["count"] = count;
  doc["device_time_ms"] = millis();
  publish("event", doc, 1);
}

void mqttEvent(void*, esp_event_base_t, int32_t eventId, void* eventData) {
  auto* event = static_cast<esp_mqtt_event_handle_t>(eventData);
  if (eventId == MQTT_EVENT_CONNECTED) {
    mqttConnected = true;
    sendHello = true;
    String prefix = "irgame/v1/device/" + id;
    esp_mqtt_client_subscribe(mqtt, (prefix + "/desired").c_str(), 1);
    esp_mqtt_client_subscribe(mqtt, (prefix + "/command").c_str(), 1);
    Serial.println("MQTT CONNECTED: game broker accepted device credentials");
  } else if (eventId == MQTT_EVENT_DISCONNECTED) {
    mqttConnected = false;
    Serial.println("MQTT DISCONNECTED");
  } else if (eventId == MQTT_EVENT_ERROR && event->error_handle) {
    Serial.printf("MQTT ERROR type=%d return_code=%d\n",
                  event->error_handle->error_type,
                  event->error_handle->connect_return_code);
  } else if (eventId == MQTT_EVENT_DATA && event->current_data_offset == 0 &&
             event->data_len == event->total_data_len && event->data_len < 1024 &&
             event->topic_len < 100) {
    String topic(event->topic, event->topic_len);
    if (topic.endsWith("/desired")) {
      ++desiredCount;
      StaticJsonDocument<1024> doc;
      if (!deserializeJson(doc, event->data, event->data_len)) {
        const char* phase = doc["phase"] | "?";
        const char* profile = doc["hardware_profile"] | "";
        Serial.printf("GAME DESIRED phase=%s profile_match=%s count=%lu\n",
                      phase, strcmp(profile, HARDWARE_PROFILE) == 0 ? "YES" : "NO",
                      static_cast<unsigned long>(desiredCount));
        if (strcmp(profile, HARDWARE_PROFILE) == 0 && desiredStates) {
          DesiredState state{};
          strlcpy(state.phase, phase, sizeof(state.phase));
          strlcpy(state.commandId, doc["command_id"] | "", sizeof(state.commandId));
          state.startCommitted = doc["start_committed"] | false;
          state.hp = doc["hp"] | 0;
          state.startDeltaMs = doc["start_at"].as<int64_t>() - doc["server_time_ms"].as<int64_t>();
          xQueueOverwrite(desiredStates, &state);
        }
      }
    } else if (topic.endsWith("/command")) {
      StaticJsonDocument<256> doc;
      if (!deserializeJson(doc, event->data, event->data_len)) {
        const char* type = doc["type"] | "";
        if (strcmp(type, "time_sync") == 0) {
          uint32_t echo = doc["echo"] | 0;
          syncRtt = static_cast<int>(millis() - echo);
          ++syncCount;
          Serial.printf("GAME TIME_SYNC rtt_ms=%d count=%lu\n", syncRtt,
                        static_cast<unsigned long>(syncCount));
        } else if (strcmp(type, "motor_demo_hit") == 0 ||
                   strcmp(type, "motor_demo_defeat") == 0 ||
                   strcmp(type, "motor_demo_revive") == 0) {
          const char* commandId = doc["command_id"] | "";
          size_t length = strlen(commandId);
          if (length > 0 && length <= 80 && motorCommands) {
            MotorCommand command{};
            memcpy(command.commandId, commandId, length);
            strlcpy(command.type, type, sizeof(command.type));
            if (xQueueSend(motorCommands, &command, 0) != pdTRUE) ++droppedMotorCommands;
          }
        }
      }
    }
  }
}

void loadConfig() {
  ssid = prefs.getString("ssid", "");
  password = prefs.getString("password", "");
  host = prefs.getString("host", "");
  id = prefs.getString("id", "");
  key = prefs.getString("key", "");
  port = static_cast<uint16_t>(prefs.getUInt("port", 1883));
  staticIp = prefs.getString("staticIp", "");
  staticGateway = prefs.getString("staticGateway", "");
  staticSubnet = prefs.getString("staticSubnet", "");
}

void acceptProvisioning() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') {
      if (serialLine.length() < 1024) serialLine += c;
      else serialLine = "";
      continue;
    }
    if (serialLine == "SCAN") {
      serialLine = "";
      scanRequested = true;
      continue;
    }
    StaticJsonDocument<1024> doc;
    DeserializationError error = deserializeJson(doc, serialLine);
    serialLine = "";
    if (error) {
      Serial.println("PROVISION ERROR invalid JSON");
      continue;
    }
    String nextSsid = doc["ssid"] | "";
    String nextPassword = doc["password"] | "";
    String nextHost = doc["host"] | "";
    String nextId = doc["id"] | "";
    String nextKey = doc["key"] | "";
    String nextStaticIp = doc["staticIp"] | "";
    String nextGateway = doc["gateway"] | "";
    String nextSubnet = doc["subnet"] | "";
    int nextPort = doc["port"] | 1883;
    if (nextSsid.isEmpty() || nextSsid.length() > 32 || nextPassword.length() < 8 ||
        nextPassword.length() > 63 || nextHost.isEmpty() || nextHost.length() > 100 ||
        nextId.isEmpty() || nextId.length() > 80 || nextKey.isEmpty() ||
        nextPort < 1 || nextPort > 65535) {
      Serial.println("PROVISION ERROR required fields or length");
      continue;
    }
    if (!nextStaticIp.isEmpty()) {
      IPAddress ipAddress, gatewayAddress, subnetAddress;
      if (!ipAddress.fromString(nextStaticIp) || !gatewayAddress.fromString(nextGateway) ||
          !subnetAddress.fromString(nextSubnet)) {
        Serial.println("PROVISION ERROR static IP fields");
        continue;
      }
    }
    for (const char* field : {"ssid", "password", "host", "id", "key"})
      prefs.putString(field, doc[field].as<const char*>());
    prefs.putUInt("port", nextPort);
    prefs.putString("staticIp", nextStaticIp);
    prefs.putString("staticGateway", nextGateway);
    prefs.putString("staticSubnet", nextSubnet);
    Serial.println("PROVISION SAVED: restarting; credentials are not printed");
    Serial.flush();
    delay(200);
    ESP.restart();
  }
}

void startMqtt() {
  static esp_mqtt_client_config_t config{};
  config.host = host.c_str();
  config.port = port;
  config.client_id = id.c_str();
  config.username = id.c_str();
  config.password = key.c_str();
  config.keepalive = 5;
  config.disable_clean_session = false;
  config.buffer_size = 2048;
  mqtt = esp_mqtt_client_init(&config);
  if (!mqtt) {
    Serial.println("MQTT INIT FAILED");
    return;
  }
  esp_mqtt_client_register_event(mqtt, static_cast<esp_mqtt_event_id_t>(ESP_EVENT_ANY_ID), mqttEvent, nullptr);
  mqttStarted = esp_mqtt_client_start(mqtt) == ESP_OK;
  Serial.printf("MQTT START %s host=%s port=%u id=%s\n",
                mqttStarted ? "OK" : "FAILED", host.c_str(), port, id.c_str());
}

void setup() {
  digitalWrite(LEGACY_MOTOR_GPIO, LOW);
  pinMode(LEGACY_MOTOR_GPIO, OUTPUT);
  ledcSetup(MOTOR_CHANNEL, 5000, 8);
  ledcAttachPin(LEGACY_MOTOR_GPIO, MOTOR_CHANNEL);
  ledcWrite(MOTOR_CHANNEL, 0);
  digitalWrite(LEGACY_IR_GPIO, LOW);
  pinMode(LEGACY_IR_GPIO, OUTPUT);
  pinMode(LEGACY_SW1_GPIO, INPUT_PULLUP);
  Serial.begin(115200);
  delay(800);
  esp_timer_create_args_t timerArgs{};
  timerArgs.callback = stopMotor;
  timerArgs.name = "motor-off";
  ESP_ERROR_CHECK(esp_timer_create(&timerArgs, &motorTimer));
  motorCommands = xQueueCreate(4, sizeof(MotorCommand));
  desiredStates = xQueueCreate(1, sizeof(DesiredState));
  configASSERT(motorCommands && desiredStates);
  trigger.initialize(digitalRead(LEGACY_SW1_GPIO) == LOW, millis());
  initializeLeds();
  prefs.begin("ir-arena", false);
  loadConfig();
  bootId = String(esp_random(), HEX) + String(esp_random(), HEX);
  Serial.println("LEGACY MOTOR DEMO 6: restored v3 motor drive; shot=310ms PWM220; hit=420ms PWM255; SW1 cooldown=1000ms, ignored presses never queued; LED8 white20 on GPIO43; IR OFF");
  if (ssid.isEmpty() || host.isEmpty() || id.isEmpty() || key.isEmpty()) {
    Serial.println("CONFIG REQUIRED: send one game provisioning JSON line over USB");
    return;
  }
  WiFi.onEvent(wifiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  if (!staticIp.isEmpty()) {
    IPAddress ipAddress, gatewayAddress, subnetAddress;
    ipAddress.fromString(staticIp);
    gatewayAddress.fromString(staticGateway);
    subnetAddress.fromString(staticSubnet);
    if (!WiFi.config(ipAddress, gatewayAddress, subnetAddress))
      Serial.println("WIFI STATIC IP CONFIG FAILED");
    else
      Serial.printf("WIFI STATIC IP %s gateway=%s\n", staticIp.c_str(), staticGateway.c_str());
  }
  WiFi.begin(ssid.c_str(), password.c_str());
  lastWifiAttempt = millis();
  Serial.printf("WIFI CONNECTING ssid=%s\n", ssid.c_str());
}

void loop() {
  acceptProvisioning();
  handleTrigger(millis());
  handleDesired();
  handleMotorCommands();
  handleMotorSequence(millis());
  if (ledsOn && (!motorActive || activePattern != MotorPattern::Shot)) writeLeds(false);
  if (scanRequested) {
    scanRequested = false;
    WiFi.mode(WIFI_STA);
    Serial.println("WIFI SCAN START");
    int count = WiFi.scanNetworks();
    for (int i = 0; i < count; ++i)
      Serial.printf("WIFI NETWORK ssid=%s channel=%d rssi=%d encryption=%d\n",
                    WiFi.SSID(i).c_str(), WiFi.channel(i), WiFi.RSSI(i),
                    WiFi.encryptionType(i));
    WiFi.scanDelete();
    Serial.printf("WIFI SCAN END count=%d\n", count);
  }
  uint32_t now = millis();
  if (!ssid.isEmpty() && !host.isEmpty() && !id.isEmpty() && !key.isEmpty()) {
    if (WiFi.status() == WL_CONNECTED) {
      if (!mqttStarted) {
        Serial.printf("WIFI CONNECTED ip=%s gateway=%s rssi=%d\n",
                      WiFi.localIP().toString().c_str(),
                      WiFi.gatewayIP().toString().c_str(), WiFi.RSSI());
        startMqtt();
      }
    } else if (now - lastWifiAttempt >= WIFI_RETRY_MS) {
      lastWifiAttempt = now;
      Serial.printf("WIFI RETRY status=%d\n", WiFi.status());
      WiFi.reconnect();
    }
    if (sendHello && mqttConnected) {
      sendHello = false;
      StaticJsonDocument<256> doc;
      doc["boot_id"] = bootId;
      doc["hardware_profile"] = HARDWARE_PROFILE;
      doc["firmware_version"] = DEMO_FIRMWARE_VERSION;
      publish("hello", doc);
      Serial.println("GAME HELLO SENT");
      lastTelemetry = 0;
    }
    if (mqttConnected && now - lastTelemetry >= 250) {
      lastTelemetry = now;
      StaticJsonDocument<1536> doc;
      doc["boot_id"] = bootId;
      doc["hardware_profile"] = HARDWARE_PROFILE;
      doc["firmware_version"] = DEMO_FIRMWARE_VERSION;
      doc["hardware_ready"] = false;
      doc["bench"] = true;
      doc["motor_active"] = motorActive;
      doc["motor_duty"] = motorDuty;
      doc["motor_pattern"] = motorPatternName();
      doc["motor_pwm_limit"] = 255;
      doc["motor_hw_duty"] = ledcRead(MOTOR_CHANNEL);
      doc["motor_queue_depth"] = uxQueueMessagesWaiting(motorCommands);
      doc["motor_dropped_commands"] = droppedMotorCommands;
      doc["reset_reason"] = static_cast<int>(esp_reset_reason());
      doc["shot_cooldown_ms"] = legacy_feedback::SHOT_COOLDOWN_MS;
      doc["ignored_shots"] = ignoredShots;
      doc["led_ready"] = ledReady;
      doc["led_white20"] = ledsOn;
      doc["demo_shots"] = demoShots;
      doc["demo_hits"] = demoHits;
      doc["demo_defeats"] = demoDefeats;
      doc["demo_revives"] = demoRevives;
      doc["demo_countdown_beats"] = demoCountdownBeats;
      doc["demo_defeat_pulses"] = demoDefeatPulses;
      doc.createNestedObject("rx_frames");
      doc["device_time_ms"] = now;
      doc["syncRtt"] = syncRtt;
      doc["rssi"] = WiFi.RSSI();
      doc["lowBattery"] = false;
      publish("telemetry", doc, 0);
    }
  }
  if (now - lastStatus >= STATUS_INTERVAL_MS) {
    lastStatus = now;
    Serial.printf("STATUS configured=%s wifi=%s status_code=%d ip=%s rssi=%d mqtt=%s desired=%lu time_sync=%lu rtt_ms=%d motor=%s shots=%lu hits=%lu defeat_pulses=%lu revives=%lu countdown_beats=%lu\n",
                  ssid.isEmpty() || host.isEmpty() || id.isEmpty() || key.isEmpty() ? "NO" : "YES",
                  WiFi.status() == WL_CONNECTED ? "CONNECTED" : "OFFLINE",
                  WiFi.status(),
                  WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "-",
                  WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
                  mqttConnected ? "CONNECTED" : "OFFLINE",
                  static_cast<unsigned long>(desiredCount),
                  static_cast<unsigned long>(syncCount), syncRtt,
                  motorActive ? "ON" : "OFF",
                  static_cast<unsigned long>(demoShots),
                  static_cast<unsigned long>(demoHits),
                  static_cast<unsigned long>(demoDefeats),
                  static_cast<unsigned long>(demoDefeatPulses),
                  static_cast<unsigned long>(demoRevives),
                  static_cast<unsigned long>(demoCountdownBeats));
  }
  delay(10);
}
