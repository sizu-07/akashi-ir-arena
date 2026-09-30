#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mqtt_client.h>
#include <esp_timer.h>
#include <esp_system.h>
#include "hardware_profile.h"
#include "../include/motor_feedback.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Wi-Fi game diagnostic requires XIAO ESP32-S3 Plus"
#endif

// 4E legacy PCB only. Never initialize the incompatible v0.7 output profile.
constexpr int LEGACY_MOTOR_GPIO = 9;
constexpr int LEGACY_IR_GPIO = 6;
constexpr int LEGACY_SW1_GPIO = 2;
constexpr uint32_t SWITCH_DEBOUNCE_MS = 25;
constexpr uint32_t STATUS_INTERVAL_MS = 2000;
constexpr uint32_t WIFI_RETRY_MS = 30000;
constexpr uint8_t MOTOR_CHANNEL = 2;
constexpr char DEMO_FIRMWARE_VERSION[] = "legacy-motor-demo-5";
using MotorPattern = legacy_feedback::Pattern;

Preferences prefs;
esp_mqtt_client_handle_t mqtt = nullptr;
esp_timer_handle_t motorTimer = nullptr;
portMUX_TYPE motorMux = portMUX_INITIALIZER_UNLOCKED;
legacy_feedback::Controller motorController;
struct MotorCommand {
  char commandId[81];
  MotorPattern pattern;
  uint32_t queuedAt;
};
struct DesiredState {
  char phase[16];
  char commandId[81];
  bool startCommitted;
  int hp;
  int64_t startDeltaMs;
  uint32_t receivedAt;
};
QueueHandle_t motorCommands = nullptr;
QueueHandle_t desiredStates = nullptr;
String ssid, password, host, id, key, bootId, serialLine;
String staticIp, staticGateway, staticSubnet;
String recentMotorCommands[8], lastCountdownCommand;
uint8_t recentCommandIndex = 0;
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
volatile uint8_t motorDuty = 0;
volatile MotorPattern currentMotorPattern = MotorPattern::None;
uint32_t demoShots = 0, demoHits = 0, demoDefeats = 0, demoRevives = 0;
volatile uint32_t demoCountdownBeats = 0, demoDefeatPulses = 0;
volatile uint32_t droppedMotorCommands = 0;
uint32_t missedCountdownBeats = 0, triggerPresses = 0;
uint8_t countdownIndex = 0;
uint32_t countdownStartAt = 0;
bool countdownPending = false, hpSeen = false;
int lastHp = 0;
MotorPattern pendingHpPattern = MotorPattern::None;
int triggerRaw = HIGH, triggerStable = HIGH;
uint32_t triggerChangedAt = 0;
bool triggerArmed = false;

void publishDemoEvent(const char* type, uint32_t count);

const char* patternName(MotorPattern pattern) {
  switch (pattern) {
    case MotorPattern::Shot: return "SHOT";
    case MotorPattern::Hit: return "HIT";
    case MotorPattern::Countdown: return "COUNTDOWN";
    case MotorPattern::Defeat: return "DEFEAT";
    case MotorPattern::Revive: return "REVIVE";
    default: return "OFF";
  }
}

// All runtime PWM writes and multi-pulse timing run on this timer task.
// Network operations or serial scans cannot freeze an effect at its last duty.
void motorTick(void*) {
  portENTER_CRITICAL(&motorMux);
  const auto frame = motorController.update(millis());
  const bool changed = motorDuty != frame.duty;
  motorDuty = frame.duty;
  motorActive = frame.duty > 0;
  currentMotorPattern = motorController.pattern();
  if (frame.pulseStarted && frame.pattern == MotorPattern::Defeat) ++demoDefeatPulses;
  if (frame.pulseStarted && frame.pattern == MotorPattern::Countdown) ++demoCountdownBeats;
  portEXIT_CRITICAL(&motorMux);
  if (changed) ledcWrite(MOTOR_CHANNEL, legacy_feedback::clampDuty(frame.duty));
}

bool motorReady() {
  portENTER_CRITICAL(&motorMux);
  const bool ready = motorTimer && motorController.ready(millis());
  portEXIT_CRITICAL(&motorMux);
  return ready;
}

bool startMotor(MotorPattern pattern, uint8_t beat = 0) {
  portENTER_CRITICAL(&motorMux);
  const bool started = motorTimer && motorController.start(pattern, millis(), beat);
  portEXIT_CRITICAL(&motorMux);
  if (!started) return false;
  Serial.printf("MOTOR %s START duration_ms=%lu ceiling=%u/255\n", patternName(pattern),
                static_cast<unsigned long>(legacy_feedback::duration(pattern)),
                legacy_feedback::MAX_DUTY);
  if (pattern == MotorPattern::Shot) publishDemoEvent("motor_demo_shot", ++demoShots);
  else if (pattern == MotorPattern::Hit) publishDemoEvent("motor_demo_hit", ++demoHits);
  else if (pattern == MotorPattern::Defeat) publishDemoEvent("motor_demo_defeat", ++demoDefeats);
  else if (pattern == MotorPattern::Revive) publishDemoEvent("motor_demo_revive", ++demoRevives);
  return true;
}

void cancelMotor(MotorPattern pattern) {
  portENTER_CRITICAL(&motorMux);
  if (motorController.pattern() == pattern) motorController.cancel(millis());
  portEXIT_CRITICAL(&motorMux);
}

void dropMotorCommand() {
  portENTER_CRITICAL(&motorMux);
  ++droppedMotorCommands;
  portEXIT_CRITICAL(&motorMux);
}

void enqueueMotor(const MotorCommand& command) {
  if (!motorCommands || xQueueSend(motorCommands, &command, 0) != pdTRUE) {
    dropMotorCommand();
    Serial.println("MOTOR COMMAND REJECTED queue full");
  }
}

void handleTrigger(uint32_t now) {
  const int level = digitalRead(LEGACY_SW1_GPIO);
  if (level != triggerRaw) { triggerRaw = level; triggerChangedAt = now; }
  if (level == triggerStable || now - triggerChangedAt < SWITCH_DEBOUNCE_MS) return;
  triggerStable = level;
  if (level == HIGH) { triggerArmed = true; Serial.println("SW1 RELEASED"); }
  else if (triggerArmed) {
    triggerArmed = false;
    MotorCommand command{};
    snprintf(command.commandId, sizeof(command.commandId), "SW1-%lu",
             static_cast<unsigned long>(++triggerPresses));
    command.pattern = MotorPattern::Shot;
    command.queuedAt = now;
    enqueueMotor(command);
    Serial.println("SW1 PRESSED: shot queued");
  }
}

void handleMotorCommands() {
  if (!motorCommands || pendingHpPattern != MotorPattern::None) return;
  MotorCommand command{};
  while (xQueuePeek(motorCommands, &command, 0) == pdTRUE) {
    bool duplicate = false;
    for (const auto& seen : recentMotorCommands) if (seen == command.commandId) duplicate = true;
    const bool expired = uint32_t(millis() - command.queuedAt) > 5000;
    if (duplicate || expired) {
      xQueueReceive(motorCommands, &command, 0);
      if (expired && !duplicate) { dropMotorCommand(); Serial.println("MOTOR COMMAND EXPIRED"); }
      continue;
    }
    if (!motorReady()) return;  // Keep the instruction until the recovery gap ends.
    if (!startMotor(command.pattern)) return;
    xQueueReceive(motorCommands, &command, 0);
    recentMotorCommands[recentCommandIndex++ % 8] = command.commandId;
    return;
  }
}

void handleDesired() {
  if (!desiredStates) return;
  DesiredState desired{};
  while (xQueueReceive(desiredStates, &desired, 0) == pdTRUE) {
    if (hpSeen) {
      if (lastHp > 0 && desired.hp <= 0) pendingHpPattern = MotorPattern::Defeat;
      else if (lastHp <= 0 && desired.hp > 0) {
        cancelMotor(MotorPattern::Defeat);
        pendingHpPattern = MotorPattern::Revive;
      }
    }
    lastHp = desired.hp; hpSeen = true;
    const bool counting = strcmp(desired.phase, "COUNTDOWN") == 0 && desired.startCommitted &&
                          desired.commandId[0] && desired.startDeltaMs > 0 && desired.startDeltaMs <= 10000;
    if (!counting) { countdownPending = false; cancelMotor(MotorPattern::Countdown); }
    else if (lastCountdownCommand != desired.commandId) {
      lastCountdownCommand = desired.commandId;
      countdownStartAt = desired.receivedAt + static_cast<uint32_t>(desired.startDeltaMs);
      countdownIndex = 0; countdownPending = true;
      Serial.printf("COUNTDOWN vibration scheduled start_in_ms=%lld\n",
                    static_cast<long long>(desired.startDeltaMs));
    }
  }
}

void handleMotorSequence(uint32_t now) {
  if (pendingHpPattern != MotorPattern::None && motorReady()) {
    if (startMotor(pendingHpPattern)) pendingHpPattern = MotorPattern::None;
  }
  if (countdownPending && countdownIndex < 5) {
    const uint32_t mark = countdownStartAt - (5 - countdownIndex) * 1000;
    if (static_cast<int32_t>(now - mark) >= 0) {
      if (static_cast<int32_t>(now - mark) <= 150 && motorReady() &&
          startMotor(MotorPattern::Countdown, countdownIndex))
        Serial.printf("COUNTDOWN beat=%u/5\n", countdownIndex + 1);
      else ++missedCountdownBeats;
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
          state.receivedAt = millis();
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
            command.pattern = strcmp(type, "motor_demo_hit") == 0 ? MotorPattern::Hit :
                              strcmp(type, "motor_demo_defeat") == 0 ? MotorPattern::Defeat : MotorPattern::Revive;
            command.queuedAt = millis();
            enqueueMotor(command);
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
  timerArgs.callback = motorTick;
  timerArgs.name = "motor-envelope";
  timerArgs.skip_unhandled_events = true;
  ESP_ERROR_CHECK(esp_timer_create(&timerArgs, &motorTimer));
  motorCommands = xQueueCreate(8, sizeof(MotorCommand));
  desiredStates = xQueueCreate(1, sizeof(DesiredState));
  configASSERT(motorCommands && desiredStates);
  ESP_ERROR_CHECK(esp_timer_start_periodic(motorTimer, legacy_feedback::TICK_US));
  triggerRaw = triggerStable = digitalRead(LEGACY_SW1_GPIO);
  triggerChangedAt = millis();
  triggerArmed = triggerStable == HIGH;
  prefs.begin("ir-arena", false);
  loadConfig();
  bootId = String(esp_random(), HEX) + String(esp_random(), HEX);
  Serial.printf("LEGACY MOTOR DEMO 5: startup=%u/255 for %lu ms; run_ceiling=%u/255; shot=310ms PWM150; reset_reason=%d; IR/LED OFF\n",
                legacy_feedback::STARTUP_DUTY, static_cast<unsigned long>(legacy_feedback::STARTUP_MS),
                legacy_feedback::RUN_MAX_DUTY, esp_reset_reason());
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
      StaticJsonDocument<1024> doc;
      doc["boot_id"] = bootId;
      doc["hardware_profile"] = HARDWARE_PROFILE;
      doc["firmware_version"] = DEMO_FIRMWARE_VERSION;
      doc["hardware_ready"] = false;
      doc["bench"] = true;
      doc["motor_active"] = motorActive;
      doc["motor_duty"] = motorDuty;
      doc["motor_pwm_limit"] = legacy_feedback::MAX_DUTY;
      doc["motor_run_limit"] = legacy_feedback::RUN_MAX_DUTY;
      doc["motor_startup_ms"] = legacy_feedback::STARTUP_MS;
      doc["motor_hw_duty"] = ledcRead(MOTOR_CHANNEL);
      doc["motor_pattern"] = patternName(currentMotorPattern);
      doc["motor_queue_depth"] = motorCommands ? uxQueueMessagesWaiting(motorCommands) : 0;
      doc["motor_dropped_commands"] = droppedMotorCommands;
      doc["reset_reason"] = static_cast<int>(esp_reset_reason());
      doc["demo_shots"] = demoShots;
      doc["demo_hits"] = demoHits;
      doc["demo_defeats"] = demoDefeats;
      doc["demo_revives"] = demoRevives;
      doc["demo_countdown_beats"] = demoCountdownBeats;
      doc["demo_countdown_missed"] = missedCountdownBeats;
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
    Serial.printf("STATUS configured=%s wifi=%s status_code=%d ip=%s rssi=%d mqtt=%s desired=%lu time_sync=%lu rtt_ms=%d motor=%s duty=%u/%u shots=%lu hits=%lu defeats=%lu defeat_pulses=%lu revives=%lu countdown_beats=%lu queued=%u dropped=%lu\n",
                  ssid.isEmpty() || host.isEmpty() || id.isEmpty() || key.isEmpty() ? "NO" : "YES",
                  WiFi.status() == WL_CONNECTED ? "CONNECTED" : "OFFLINE",
                  WiFi.status(),
                  WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "-",
                  WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
                  mqttConnected ? "CONNECTED" : "OFFLINE",
                  static_cast<unsigned long>(desiredCount),
                  static_cast<unsigned long>(syncCount), syncRtt,
                  motorActive ? "ON" : "OFF",
                  motorDuty, legacy_feedback::MAX_DUTY,
                  static_cast<unsigned long>(demoShots),
                  static_cast<unsigned long>(demoHits),
                  static_cast<unsigned long>(demoDefeats),
                  static_cast<unsigned long>(demoDefeatPulses),
                  static_cast<unsigned long>(demoRevives),
                  static_cast<unsigned long>(demoCountdownBeats),
                  motorCommands ? static_cast<unsigned>(uxQueueMessagesWaiting(motorCommands)) : 0,
                  static_cast<unsigned long>(droppedMotorCommands));
  }
  delay(10);
}
