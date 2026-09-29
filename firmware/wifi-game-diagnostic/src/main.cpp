#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mqtt_client.h>
#include "hardware_profile.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Wi-Fi game diagnostic requires XIAO ESP32-S3 Plus"
#endif

// 4E legacy PCB only. Never initialize the incompatible v0.7 output profile.
constexpr int LEGACY_MOTOR_GPIO = 9;
constexpr int LEGACY_IR_GPIO = 6;
constexpr uint32_t STATUS_INTERVAL_MS = 2000;
constexpr uint32_t WIFI_RETRY_MS = 30000;

Preferences prefs;
esp_mqtt_client_handle_t mqtt = nullptr;
String ssid, password, host, id, key, bootId, serialLine;
String staticIp, staticGateway, staticSubnet;
uint16_t port = 1883;
volatile bool mqttConnected = false;
volatile bool sendHello = false;
volatile uint32_t desiredCount = 0;
volatile uint32_t syncCount = 0;
volatile int syncRtt = -1;
uint32_t lastStatus = 0, lastWifiAttempt = 0, lastTelemetry = 0;
bool mqttStarted = false;
bool scanRequested = false;

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
        Serial.printf("GAME DESIRED phase=%s profile_match=%s count=%lu (outputs remain OFF)\n",
                      phase, strcmp(profile, HARDWARE_PROFILE) == 0 ? "YES" : "NO",
                      static_cast<unsigned long>(desiredCount));
      }
    } else if (topic.endsWith("/command")) {
      StaticJsonDocument<256> doc;
      if (!deserializeJson(doc, event->data, event->data_len) &&
          strcmp(doc["type"] | "", "time_sync") == 0) {
        uint32_t echo = doc["echo"] | 0;
        syncRtt = static_cast<int>(millis() - echo);
        ++syncCount;
        Serial.printf("GAME TIME_SYNC rtt_ms=%d count=%lu\n", syncRtt,
                      static_cast<unsigned long>(syncCount));
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
  digitalWrite(LEGACY_IR_GPIO, LOW);
  pinMode(LEGACY_IR_GPIO, OUTPUT);
  Serial.begin(115200);
  delay(800);
  prefs.begin("ir-arena", false);
  loadConfig();
  bootId = String(esp_random(), HEX) + String(esp_random(), HEX);
  Serial.println("WIFI GAME DIAGNOSTIC: legacy motor and IR held OFF; no LED/IR frames");
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
      doc["firmware_version"] = "wifi-game-diag-1";
      publish("hello", doc);
      Serial.println("GAME HELLO SENT");
      lastTelemetry = 0;
    }
    if (mqttConnected && now - lastTelemetry >= 1000) {
      lastTelemetry = now;
      StaticJsonDocument<512> doc;
      doc["boot_id"] = bootId;
      doc["hardware_profile"] = HARDWARE_PROFILE;
      doc["firmware_version"] = "wifi-game-diag-1";
      doc["hardware_ready"] = false;
      doc["bench"] = true;
      doc["motor_active"] = false;
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
    Serial.printf("STATUS configured=%s wifi=%s status_code=%d ip=%s rssi=%d mqtt=%s desired=%lu time_sync=%lu rtt_ms=%d\n",
                  ssid.isEmpty() || host.isEmpty() || id.isEmpty() || key.isEmpty() ? "NO" : "YES",
                  WiFi.status() == WL_CONNECTED ? "CONNECTED" : "OFFLINE",
                  WiFi.status(),
                  WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "-",
                  WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
                  mqttConnected ? "CONNECTED" : "OFFLINE",
                  static_cast<unsigned long>(desiredCount),
                  static_cast<unsigned long>(syncCount), syncRtt);
  }
  delay(10);
}
