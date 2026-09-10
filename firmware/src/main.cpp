#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mqtt_client.h>
#include <driver/rmt.h>
#include <esp_timer.h>
#include "ir_protocol.h"
#include "hardware_profile.h"
#include "feedback.h"
#if !CONFIG_IDF_TARGET_ESP32S3
#error "v0.6 requires XIAO ESP32-S3 Plus"
#endif

constexpr rmt_channel_t TX_CH=(rmt_channel_t)TX_CHANNEL,LED_CH=(rmt_channel_t)LED_CHANNEL;
Preferences prefs;esp_mqtt_client_handle_t mqtt=nullptr;RingbufHandle_t rxRings[RX_COUNT]{};QueueHandle_t incoming;
uint32_t rxFrames[RX_COUNT]{};DamageFeedback feedback;esp_timer_handle_t motorTimer=nullptr;
volatile bool motorActive=false;bool hardwareReady=false,profileMatched=false;
void stopMotor(void* =nullptr){digitalWrite(MOTOR,LOW);motorActive=false;}
void vibrate(uint32_t ms){if(!motorTimer)return;esp_timer_stop(motorTimer);stopMotor();
 if(ms==0)return;ms=min(ms,MOTOR_MAX_MS);digitalWrite(MOTOR,HIGH);motorActive=true;
 if(esp_timer_start_once(motorTimer,uint64_t(ms)*1000)!=ESP_OK)stopMotor();
}
struct NetMessage { char topic[100];char body[2048]; };
String id,key,ssid,password,host,boot,gameId,phase="OFFLINE",team="A",lastCommand;
uint32_t sequence=0,generation=0,lastDesired=0,lastTelemetry=0,lastWifi=0,lastShotLocal=0,lastRender=0,lastDebounce=0;
uint8_t shotSeq=0,shooter=0;int hp=0,ammo=0,maxHp=100,magazine=30,fireMs=200,reloadMs=2000;
int64_t clockOffset=0,startAt=0,reloadUntil=0;int syncRtt=-1,reloadResumeMs=0;bool synced=false,armed=false,bench=false,lowBattery=false,batteryLatched=false,startCommitted=false;
volatile bool mqttOnline=false,needHello=false;bool triggerRaw=false,triggerDown=false,reloadPrevious=false;float battery=0,adcScale=2.0f;
uint32_t lowSince=0,flashUntil=0,buzzUntil=0;String serialLine;
int64_t serverNow(){return esp_timer_get_time()/1000+clockOffset;}
void publish(const char* suffix,JsonDocument& doc,int qos=1){if(!mqttOnline)return;String out;serializeJson(doc,out);String topic="irgame/v1/device/"+id+"/"+suffix;esp_mqtt_client_publish(mqtt,topic.c_str(),out.c_str(),out.length(),qos,0);}
void event(const char* type,JsonDocument& payload){if(!mqttOnline)return;StaticJsonDocument<1024> doc;doc["schema_version"]=1;doc["device_id"]=id;doc["boot_id"]=boot;doc["seq"]=++sequence;doc["message_id"]=boot+"-"+String(sequence);doc["game_id"]=gameId;doc["game_generation"]=generation;doc["device_time_ms"]=millis();doc["server_time_ms"]=serverNow();doc["type"]=type;doc["payload"]=payload.as<JsonObject>();publish("event",doc);}
// PS1240P02BT is specified at 4 kHz. Patterns use duration, not off-resonance pitches.
void buzz(int hz,int ms){ledcWriteTone(0,hz?4000:0);buzzUntil=millis()+ms;}
void mqttEvent(void*,esp_event_base_t,int32_t eventId,void* eventData){auto e=(esp_mqtt_event_handle_t)eventData;
 if(eventId==MQTT_EVENT_CONNECTED){mqttOnline=true;needHello=true;String base="irgame/v1/device/"+id;esp_mqtt_client_subscribe(mqtt,(base+"/desired").c_str(),1);esp_mqtt_client_subscribe(mqtt,(base+"/command").c_str(),1);}
 if(eventId==MQTT_EVENT_DISCONNECTED){mqttOnline=false;stopMotor();}
 if(eventId==MQTT_EVENT_DATA&&e->current_data_offset==0&&e->data_len==e->total_data_len&&e->data_len<2048&&e->topic_len<100){NetMessage m{};memcpy(m.topic,e->topic,e->topic_len);memcpy(m.body,e->data,e->data_len);xQueueSend(incoming,&m,0);}
}
void initMqtt(){static esp_mqtt_client_config_t c{};c.host=host.c_str();c.port=prefs.getUInt("port",1883);c.client_id=id.c_str();c.username=id.c_str();c.password=key.c_str();c.keepalive=5;c.disable_clean_session=false;c.buffer_size=2048;
 mqtt=esp_mqtt_client_init(&c);esp_mqtt_client_register_event(mqtt,(esp_mqtt_event_id_t)ESP_EVENT_ANY_ID,mqttEvent,nullptr);esp_mqtt_client_start(mqtt);}
bool nearDuration(int got,int want){return got>want*0.65&&got<want*1.35;}
void initRmt(){rmt_config_t tx=RMT_DEFAULT_CONFIG_TX((gpio_num_t)TX_PIN,TX_CH);tx.clk_div=80;tx.tx_config.carrier_en=true;tx.tx_config.carrier_freq_hz=38000;tx.tx_config.carrier_duty_percent=33;tx.tx_config.carrier_level=RMT_CARRIER_LEVEL_HIGH;tx.tx_config.idle_output_en=true;tx.tx_config.idle_level=RMT_IDLE_LEVEL_LOW;ESP_ERROR_CHECK(rmt_config(&tx));ESP_ERROR_CHECK(rmt_driver_install(TX_CH,0,0));
 // S3: TX channels 0..3, RX channels 4..7. One 48-symbol block per receiver.
 for(int i=0;i<RX_COUNT;i++){auto ch=(rmt_channel_t)RX_CHANNELS[i];rmt_config_t rx=RMT_DEFAULT_CONFIG_RX((gpio_num_t)RX_PINS[i],ch);rx.clk_div=80;rx.rx_config.filter_en=true;rx.rx_config.filter_ticks_thresh=100;rx.rx_config.idle_threshold=12000;ESP_ERROR_CHECK(rmt_config(&rx));ESP_ERROR_CHECK(rmt_driver_install(ch,4096,0));ESP_ERROR_CHECK(rmt_get_ringbuf_handle(ch,&rxRings[i]));ESP_ERROR_CHECK(rmt_rx_start(ch,true));}
 rmt_config_t led=RMT_DEFAULT_CONFIG_TX((gpio_num_t)LED_PIN,LED_CH);led.clk_div=2;led.tx_config.idle_level=RMT_IDLE_LEVEL_LOW;ESP_ERROR_CHECK(rmt_config(&led));ESP_ERROR_CHECK(rmt_driver_install(LED_CH,0,0));
 hardwareReady=true;
}
void sendIr(uint32_t value){rmt_item32_t items[34]{};items[0].level0=1;items[0].duration0=9000;items[0].level1=0;items[0].duration1=4500;
 for(int i=0;i<32;i++){items[i+1].level0=1;items[i+1].duration0=560;items[i+1].level1=0;items[i+1].duration1=(value&(1u<<(31-i)))?1690:560;}
 items[33].level0=1;items[33].duration0=560;items[33].level1=0;items[33].duration1=1000;
 // RX remains enabled. Our own shooter ID is rejected after decoding.
 // Optical collisions can still corrupt frames; verify simultaneous fire on real guns.
 rmt_write_items(TX_CH,items,34,true);
}
void receiveIr(int receiver){size_t bytes=0;auto ring=rxRings[receiver];auto items=(rmt_item32_t*)xRingbufferReceive(ring,&bytes,0);if(!items)return;int count=bytes/sizeof(rmt_item32_t);uint32_t frame=0;bool valid=false;
 // Find the leader independent of the RMT item's initial idle-level alignment.
 uint16_t durations[256];uint8_t levels[256];int pulses=0;
 for(int i=0;i<count&&pulses<254;i++){if(items[i].duration0){durations[pulses]=items[i].duration0;levels[pulses++]=items[i].level0;}if(items[i].duration1){durations[pulses]=items[i].duration1;levels[pulses++]=items[i].level1;}}
 for(int begin=0;begin+65<pulses;begin++){if(levels[begin]!=0||levels[begin+1]!=1||!nearDuration(durations[begin],9000)||!nearDuration(durations[begin+1],4500))continue;
  frame=0;valid=true;for(int bit=0;bit<32;bit++){int i=begin+2+bit*2;if(levels[i]!=0||levels[i+1]!=1||!nearDuration(durations[i],560)){valid=false;break;}frame<<=1;if(nearDuration(durations[i+1],1690))frame|=1;else if(!nearDuration(durations[i+1],560)){valid=false;break;}}if(valid)break;
 }
 vRingbufferReturnItem(ring,items);
 if(!valid||!irValid(frame))return;rxFrames[receiver]++;
 if(phase!="ACTIVE"||!armed||!synced||!mqttOnline||!profileMatched||bench||lowBattery||batteryLatched||millis()-lastDesired>3000)return;
 uint8_t sender=(frame>>22)&255;if(sender==shooter)return;StaticJsonDocument<256> payload;payload["shooter_id"]=sender;payload["shot_seq"]=(frame>>14)&255;payload["weapon_id"]=1;payload["receiver_id"]=RX_IDS[receiver];event("hit_candidate",payload);
}
void leds(uint8_t r,uint8_t g,uint8_t b,int count){rmt_item32_t items[192]{};int index=0;
 // Each channel <= 28/255. Even full white on eight LEDs is below 53 mA at 60 mA/pixel.
 for(int pixel=0;pixel<8;pixel++){uint8_t rgb[3]={uint8_t(pixel<count?g:0),uint8_t(pixel<count?r:0),uint8_t(pixel<count?b:0)};for(uint8_t value:rgb)for(int bit=7;bit>=0;bit--){bool one=value&(1<<bit);auto &v=items[index++];v.level0=1;v.duration0=one?24:12;v.level1=0;v.duration1=one?24:36;}}
 rmt_write_items(LED_CH,items,192,true);delayMicroseconds(100);
}
void netMessages(){NetMessage m;while(xQueueReceive(incoming,&m,0)==pdTRUE){StaticJsonDocument<2048> doc;if(deserializeJson(doc,m.body))continue;
  if(String(m.topic).endsWith("/command")){String type=doc["type"]|"";if(type=="time_sync"){uint32_t echo=doc["echo"]|0;int rtt=millis()-echo;if(rtt>=0&&rtt<=400){clockOffset=doc["server_time_ms"].as<int64_t>()+rtt/2-esp_timer_get_time()/1000;syncRtt=rtt;synced=true;}}continue;}
  String newGame=doc["game_id"]|"";uint32_t newGen=doc["game_generation"]|0;
  if(newGame==gameId&&newGen<generation)continue;
  const bool sameRound=newGame==gameId&&newGen==generation;
  gameId=newGame;generation=newGen;lastDesired=millis();phase=doc["phase"]|"OFFLINE";hp=doc["hp"]|0;ammo=doc["ammo"]|0;team=doc["team"]|"A";shooter=doc["shooter_id"]|0;
  profileMatched=String(doc["hardware_profile"]|"")==HARDWARE_PROFILE;
  bool allowFeedback=phase=="ACTIVE"&&mqttOnline&&synced&&profileMatched&&hardwareReady&&!bench&&!lowBattery&&!batteryLatched;
  // PC-issued IDs prevent retained/repeated messages, rejected hits and HP corrections from vibrating.
  if(feedback.observe(sameRound,doc["damage_feedback"]["id"]|0u,doc["damage_feedback"]["at"]|int64_t(0),serverNow(),millis(),allowFeedback,FEEDBACK_MAX_AGE_MS,MOTOR_MIN_INTERVAL_MS)){
    flashUntil=millis()+250;buzz(4000,120);vibrate(min(doc["damage_feedback"]["duration_ms"]|MOTOR_PULSE_MS,MOTOR_MAX_MS));
  }
  if(!allowFeedback)stopMotor();
  armed=(doc["armed"]|false)&&synced&&profileMatched&&!bench;maxHp=doc["rules"]["hp"]|100;magazine=doc["rules"]["magazine"]|30;fireMs=max(200,doc["rules"]["fireMs"]|200);reloadMs=doc["rules"]["reloadMs"]|2000;reloadUntil=doc["reload_until"]|int64_t(0);startAt=doc["start_at"]|int64_t(0);startCommitted=doc["start_committed"]|false;
  reloadResumeMs=doc["reload_resume_ms"]|0;String command=doc["command_id"]|"";if(phase=="COUNTDOWN"&&synced&&profileMatched&&hardwareReady&&!bench&&!lowBattery&&command.length()&&command!=lastCommand&&!batteryLatched){StaticJsonDocument<256> p;p["command_id"]=command;p["result"]="ok";event("command_ack",p);lastCommand=command;}
 }}
void serialSetup(){while(Serial.available()){char c=Serial.read();if(c=='\n'){StaticJsonDocument<1024> d;auto err=deserializeJson(d,serialLine);serialLine="";
   if(err){Serial.println("ERROR: invalid JSON");continue;}
   if(d["ssid"].is<const char*>()&&d["password"].is<const char*>()&&d["host"].is<const char*>()&&d["id"].is<const char*>()&&d["key"].is<const char*>()){
     if(String(d["ssid"].as<const char*>()).length()>32||String(d["password"].as<const char*>()).length()<8){Serial.println("ERROR: credentials");continue;}
     if(String(d["hardwareProfile"]|"")!=HARDWARE_PROFILE){Serial.println("ERROR: hardwareProfile mismatch; regenerate PC settings");continue;}
     float scale=d["adcScale"]|2.0f;if(!isfinite(scale)||scale<1.0f||scale>4.0f){Serial.println("ERROR: adcScale");continue;}
     stopMotor();for(const char* k:{"ssid","password","host","id","key"})prefs.putString(k,d[k].as<const char*>());prefs.putUInt("port",d["port"]|1883);prefs.putBool("bench",d["bench"]|false);prefs.putFloat("adcScale",scale);Serial.println("SAVED: restarting");Serial.flush();delay(200);ESP.restart();
   }else Serial.println("ERROR: required fields");
  }else if(c!='\r'){if(serialLine.length()<1024)serialLine+=c;else serialLine="";}}}
void setup(){pinMode(MOTOR,OUTPUT);stopMotor();pinMode(TX_PIN,OUTPUT);digitalWrite(TX_PIN,LOW);pinMode(LED_PIN,OUTPUT);digitalWrite(LED_PIN,LOW);pinMode(TRIGGER,INPUT_PULLUP);pinMode(RELOAD,INPUT_PULLUP);pinMode(SERVICE,INPUT_PULLUP);for(int pin:RX_PINS)pinMode(pin,INPUT);Serial.begin(115200);
 esp_timer_create_args_t timerArgs{};timerArgs.callback=stopMotor;timerArgs.name="motor-off";ESP_ERROR_CHECK(esp_timer_create(&timerArgs,&motorTimer));
 prefs.begin("ir-arena",false);id=prefs.getString("id","");key=prefs.getString("key","");ssid=prefs.getString("ssid","");password=prefs.getString("password","");host=prefs.getString("host","");bench=prefs.getBool("bench",false);adcScale=prefs.getFloat("adcScale",2.0f);boot=String(esp_random(),HEX)+String(esp_random(),HEX);
 ledcSetup(0,4000,8);ledcAttachPin(BUZZER,0);analogReadResolution(12);analogSetPinAttenuation(BATTERY,ADC_11db);incoming=xQueueCreate(12,sizeof(NetMessage));initRmt();
 battery=analogReadMilliVolts(BATTERY)/1000.0f*adcScale;lowBattery=!bench&&battery<3.3f;
 if(!ssid.length()||!id.length()||digitalRead(SERVICE)==LOW){Serial.println("SETUP: send one JSON line over USB. No IR output.");while(true){serialSetup();delay(10);}}
 WiFi.mode(WIFI_STA);WiFi.setSleep(false);WiFi.begin(ssid.c_str(),password.c_str());initMqtt();Serial.println("READY");
}
void loop(){serialSetup();uint32_t now=millis();
 if(!mqttOnline){armed=false;synced=false;phase="OFFLINE";stopMotor();}
 if(needHello){needHello=false;StaticJsonDocument<256>d;d["boot_id"]=boot;d["hardware_profile"]=HARDWARE_PROFILE;d["firmware_version"]=FIRMWARE_VERSION;publish("hello",d);lastTelemetry=0;}
 netMessages();for(int i=0;i<RX_COUNT;i++)receiveIr(i);now=millis();
 if(WiFi.status()!=WL_CONNECTED&&now-lastWifi>5000){lastWifi=now;WiFi.reconnect();}
 if(now-lastTelemetry>=1000){lastTelemetry=now;float measured=analogReadMilliVolts(BATTERY)/1000.0f*adcScale;battery=battery==0?measured:battery*.75f+measured*.25f;
   lowBattery=!bench&&battery<3.3f;if(!bench&&battery<3.0f){if(!lowSince)lowSince=now;if(now-lowSince>3000)batteryLatched=true;}else lowSince=0;
   StaticJsonDocument<768>d;d["boot_id"]=boot;d["hardware_profile"]=HARDWARE_PROFILE;d["firmware_version"]=FIRMWARE_VERSION;d["hardware_ready"]=hardwareReady;d["bench"]=bench;d["motor_active"]=motorActive;auto counters=d.createNestedObject("rx_frames");for(int i=0;i<RX_COUNT;i++)counters[RX_IDS[i]]=rxFrames[i];d["device_time_ms"]=now;d["syncRtt"]=syncRtt;d["battery"]=battery;d["lowBattery"]=lowBattery||batteryLatched;d["rssi"]=WiFi.RSSI();d["hp"]=hp;d["ammo"]=ammo;publish("telemetry",d,0);
 }
 bool safe=mqttOnline&&synced&&profileMatched&&hardwareReady&&!bench&&now-lastDesired<3000&&!batteryLatched&&!lowBattery;
 if(!safe||phase!="ACTIVE")stopMotor();
 if(phase=="COUNTDOWN"&&safe&&startCommitted&&serverNow()>=startAt){phase="ACTIVE";armed=true;if(reloadResumeMs>0)reloadUntil=startAt+reloadResumeMs;buzz(1200,200);}
 bool raw=digitalRead(TRIGGER)==LOW;if(raw!=triggerRaw){triggerRaw=raw;lastDebounce=now;}if(now-lastDebounce>20)triggerDown=raw;
 bool reload=digitalRead(RELOAD)==LOW;if(reload&&!reloadPrevious&&safe&&armed&&phase=="ACTIVE"&&hp>0&&ammo<magazine&&!reloadUntil){StaticJsonDocument<64>p;event("reload_started",p);reloadUntil=serverNow()+reloadMs;}reloadPrevious=reload;
 if(triggerDown&&safe&&armed&&phase=="ACTIVE"&&hp>0&&ammo>0&&reloadUntil==0&&now-lastShotLocal>=uint32_t(fireMs)){
   lastShotLocal=now;const uint8_t shot=shotSeq++;StaticJsonDocument<128>p;p["shot_seq"]=shot;p["weapon_id"]=1;event("shot_fired",p);ammo--;sendIr(irFrame(shooter,shot));buzz(900,30);
 }
 if(buzzUntil&&now>=buzzUntil){ledcWriteTone(0,0);buzzUntil=0;}
 if(now-lastRender>80){lastRender=now;
  if(!safe)leds(now/500%2?20:0,now/500%2?10:0,now/500%2?0:20,8);
  else if(now<flashUntil)leds(28,0,0,8);
  else if(phase=="COUNTDOWN")leds(15,15,15,now/500%2?8:0);
  else if(phase=="PAUSED")leds(0,0,20,now/500%2?8:2);
  else if(hp<=0)leds(5,0,0,8);
  else if(reloadUntil||ammo==0)leds(20,12,0,now/250%2?8:2);
  else leds(team=="A"?0:24,team=="A"?16:8,team=="A"?24:0,constrain((hp*8+maxHp-1)/maxHp,1,8));
 }
 delay(1);
}
