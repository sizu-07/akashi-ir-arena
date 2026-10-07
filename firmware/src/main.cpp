#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <mqtt_client.h>
#include <driver/rmt.h>
#include <esp_timer.h>
#include <esp_log.h>
#include "ir_protocol.h"
#include "player_identity.h"
#include "serial_rx_gate.h"
#if GAME_RECEIVER_ONLY
#include "receiver_only_profile.h"
#elif LEGACY_4E_GAME
#include "legacy_4e_profile.h"
#else
#include "hardware_profile.h"
#endif
#include "feedback.h"
#if !CONFIG_IDF_TARGET_ESP32S3
#error "v0.7 requires XIAO ESP32-S3 Plus"
#endif

constexpr rmt_channel_t TX_CH=(rmt_channel_t)TX_CHANNEL,LED_CH=(rmt_channel_t)LED_CHANNEL;
#if LEGACY_4E_GAME
constexpr uint8_t MOTOR_PWM_CHANNEL=2;
constexpr uint8_t SHOT_FEEDBACK_DUTY=SHOT_MOTOR_DUTY;
constexpr uint8_t HIT_FEEDBACK_DUTY=HIT_MOTOR_DUTY;
constexpr uint8_t REVIVE_FEEDBACK_DUTY=220;
#else
constexpr uint8_t SHOT_FEEDBACK_DUTY=255;
constexpr uint8_t HIT_FEEDBACK_DUTY=255;
constexpr uint8_t REVIVE_FEEDBACK_DUTY=255;
#endif
Preferences prefs;esp_mqtt_client_handle_t mqtt=nullptr;RingbufHandle_t rxRings[RX_COUNT]{};QueueHandle_t incoming;
uint32_t rxFrames[RX_COUNT]{};DamageFeedback feedback;esp_timer_handle_t motorTimer=nullptr;
volatile bool motorActive=false;bool hardwareReady=false,profileMatched=false;
struct NetMessage { char topic[100];char body[2048]; };
String staticIp,staticGateway,staticSubnet;
uint32_t lastIrFrame=0,lastIrAt=0;int lastIrReceiver=-1;
SerialRxGate serialRxGate;
volatile uint32_t netDropped=0,mqttError=0;
String id,key,ssid,password,host,boot,gameId,phase="OFFLINE",team="A",lastCommand;
uint32_t sequence=0,generation=0,lastDesired=0,lastTelemetry=0,lastWifi=0,lastShotLocal=0,lastRender=0,lastDebounce=0;
uint32_t cooldownUntil=0,nextRescuePulse=0,lastHoldEvent=0,countdownPulseMask=0;
uint8_t shotSeq=0,activeShotSeq=0,shooter=0;int hp=0,maxHp=100,fireMs=1000,reviveProgressMs=0;
int64_t clockOffset=0,startAt=0;int syncRtt=-1;bool synced=false,armed=false,bench=false,lowBattery=false,batteryLatched=false,startCommitted=false;
volatile bool mqttOnline=false,needHello=false;bool triggerRaw=false,triggerDown=false,triggerConsumed=false,shotHeld=false;float battery=0,adcScale=2.0f;
uint32_t lowSince=0,flashUntil=0,reviveFlashUntil=0,lastMotorStart=0,cueNextAt=0,shotLedUntil=0;uint16_t cuePulseMs=0,cueGapMs=0;uint8_t cueRemaining=0,cuePriority=0,cueDuty=255;String serialLine;
volatile uint8_t motorDuty=0;
void logStatus(bool force=false){
 static uint32_t previousFlags=UINT32_MAX,lastErrorAt=0;static String previousPhase;static int previousHp=-1;
 const uint32_t flags=(WiFi.status()==WL_CONNECTED?1:0)|(mqttOnline?2:0)|(synced?4:0)|(armed?8:0)|
   (hardwareReady?16:0)|(profileMatched?32:0)|(bench?64:0)|(lowBattery?128:0)|(batteryLatched?256:0)|(millis()-lastDesired<3000?512:0);
 if(force||flags!=previousFlags||phase!=previousPhase||hp!=previousHp){
   Serial.printf("STATE id=%s wifi=%s mqtt=%s sync=%s phase=%s hp=%d armed=%s battery=",
     id.c_str(),flags&1?"ON":"OFF",mqttOnline?"ON":"OFF",synced?"OK":"WAIT",phase.c_str(),hp,armed?"YES":"NO");
#if GAME_RECEIVER_ONLY
   Serial.print("NA");
#else
   Serial.printf("%.2fV",battery);
#endif
   const char* reason=!hardwareReady?"HARDWARE":bench?"BENCH":batteryLatched?"BATTERY_LATCH":lowBattery?"LOW_BATTERY":
     !mqttOnline?"NETWORK":!synced?"SYNC":!profileMatched?"PROFILE":millis()-lastDesired>=3000?"LEASE":"OK";
   Serial.printf(" gate=%s\n",reason);
   previousFlags=flags;previousPhase=phase;previousHp=hp;
 }
 static uint32_t previousDropped=0;
 if(netDropped!=previousDropped){previousDropped=netDropped;Serial.printf("ERROR mqtt_queue_dropped=%lu\n",(unsigned long)previousDropped);}
 if(mqttError&&(lastErrorAt==0||uint32_t(millis()-lastErrorAt)>=5000)){
   const uint32_t value=mqttError;mqttError=0;lastErrorAt=millis();
   Serial.printf("ERROR mqtt type=%u code=%u\n",unsigned(value>>16),unsigned(value&65535));
 }
}
void stopMotor(void* =nullptr){
#if GAME_RECEIVER_ONLY
 return;
#endif
#if LEGACY_4E_GAME
 ledcWrite(MOTOR_PWM_CHANNEL,0);
#else
 digitalWrite(MOTOR,LOW);
#endif
 motorDuty=0;motorActive=false;
}
void vibrate(uint32_t ms,uint8_t duty=255){if(!motorTimer)return;esp_timer_stop(motorTimer);stopMotor();
 if(ms==0)return;ms=min(ms,MOTOR_MAX_MS);lastMotorStart=millis();
#if LEGACY_4E_GAME
 ledcWrite(MOTOR_PWM_CHANNEL,duty);motorDuty=duty;
#else
 digitalWrite(MOTOR,HIGH);motorDuty=255;
#endif
 motorActive=true;
 if(esp_timer_start_once(motorTimer,uint64_t(ms)*1000)!=ESP_OK)stopMotor();
}
void cue(uint16_t pulseMs,uint8_t count,uint16_t gapMs,uint8_t priority,uint8_t duty=255){
#if GAME_RECEIVER_ONLY
 return;
#endif
 if(cueRemaining&&priority<cuePriority)return;
 cuePulseMs=pulseMs;cueRemaining=count;cueGapMs=gapMs;cuePriority=priority;cueDuty=duty;cueNextAt=millis();
}
void tickCue(uint32_t now){
 if(!cueRemaining||int32_t(now-cueNextAt)<0||motorActive)return;
 if(lastMotorStart&&now-lastMotorStart<MOTOR_MIN_INTERVAL_MS)return;
 vibrate(cuePulseMs,cueDuty);cueRemaining--;cueNextAt=now+cueGapMs;
 if(!cueRemaining)cuePriority=0;
}
void cancelCue(){cueRemaining=0;cuePriority=0;stopMotor();}
int64_t serverNow(){return esp_timer_get_time()/1000+clockOffset;}
void publish(const char* suffix,JsonDocument& doc,int qos=1){if(!mqttOnline)return;String out;serializeJson(doc,out);String topic="irgame/v1/device/"+id+"/"+suffix;esp_mqtt_client_publish(mqtt,topic.c_str(),out.c_str(),out.length(),qos,0);}
void event(const char* type,JsonDocument& payload){if(!mqttOnline)return;StaticJsonDocument<1024> doc;doc["schema_version"]=1;doc["device_id"]=id;doc["boot_id"]=boot;doc["seq"]=++sequence;doc["message_id"]=boot+"-"+String(sequence);doc["game_id"]=gameId;doc["game_generation"]=generation;doc["device_time_ms"]=millis();doc["server_time_ms"]=serverNow();doc["type"]=type;doc["payload"]=payload.as<JsonObject>();publish("event",doc);}
void mqttEvent(void*,esp_event_base_t,int32_t eventId,void* eventData){auto e=(esp_mqtt_event_handle_t)eventData;
 if(eventId==MQTT_EVENT_CONNECTED){mqttOnline=true;needHello=true;String base="irgame/v1/device/"+id;esp_mqtt_client_subscribe(mqtt,(base+"/desired").c_str(),1);esp_mqtt_client_subscribe(mqtt,(base+"/command").c_str(),1);}
 if(eventId==MQTT_EVENT_DISCONNECTED){mqttOnline=false;stopMotor();}
 if(eventId==MQTT_EVENT_ERROR&&e->error_handle)mqttError=(uint32_t(e->error_handle->error_type)<<16)|uint16_t(e->error_handle->connect_return_code);
 if(eventId==MQTT_EVENT_DATA&&e->current_data_offset==0&&e->data_len==e->total_data_len&&e->data_len<2048&&e->topic_len<100){NetMessage m{};memcpy(m.topic,e->topic,e->topic_len);memcpy(m.body,e->data,e->data_len);if(xQueueSend(incoming,&m,0)!=pdTRUE)++netDropped;}
}
void initMqtt(){static esp_mqtt_client_config_t c{};c.host=host.c_str();c.port=prefs.getUInt("port",1883);c.client_id=id.c_str();c.username=id.c_str();c.password=key.c_str();c.keepalive=5;c.disable_clean_session=false;c.buffer_size=2048;
 mqtt=esp_mqtt_client_init(&c);if(!mqtt){Serial.println("ERROR mqtt_init");return;}if(esp_mqtt_client_register_event(mqtt,(esp_mqtt_event_id_t)ESP_EVENT_ANY_ID,mqttEvent,nullptr)!=ESP_OK||esp_mqtt_client_start(mqtt)!=ESP_OK)Serial.println("ERROR mqtt_start");}
bool nearDuration(int got,int want){return got>want*0.65&&got<want*1.35;}
void initRmt(){
#if !GAME_RECEIVER_ONLY
 rmt_config_t tx=RMT_DEFAULT_CONFIG_TX((gpio_num_t)TX_PIN,TX_CH);tx.clk_div=80;tx.tx_config.carrier_en=true;tx.tx_config.carrier_freq_hz=38000;tx.tx_config.carrier_duty_percent=33;tx.tx_config.carrier_level=RMT_CARRIER_LEVEL_HIGH;tx.tx_config.idle_output_en=true;tx.tx_config.idle_level=RMT_IDLE_LEVEL_LOW;ESP_ERROR_CHECK(rmt_config(&tx));ESP_ERROR_CHECK(rmt_driver_install(TX_CH,0,0));
#endif
 // S3: TX channels 0..3, RX channels 4..7. One 48-symbol block per receiver.
 for(int i=0;i<RX_COUNT;i++){auto ch=(rmt_channel_t)RX_CHANNELS[i];rmt_config_t rx=RMT_DEFAULT_CONFIG_RX((gpio_num_t)RX_PINS[i],ch);rx.clk_div=80;
#if GAME_RECEIVER_ONLY
 rx.mem_block_num=4;
#endif
 rx.rx_config.filter_en=true;rx.rx_config.filter_ticks_thresh=100;rx.rx_config.idle_threshold=12000;ESP_ERROR_CHECK(rmt_config(&rx));ESP_ERROR_CHECK(rmt_driver_install(ch,4096,0));ESP_ERROR_CHECK(rmt_get_ringbuf_handle(ch,&rxRings[i]));ESP_ERROR_CHECK(rmt_rx_start(ch,true));}
#if !GAME_RECEIVER_ONLY
 rmt_config_t led=RMT_DEFAULT_CONFIG_TX((gpio_num_t)LED_PIN,LED_CH);led.clk_div=2;led.tx_config.idle_output_en=true;led.tx_config.idle_level=RMT_IDLE_LEVEL_LOW;ESP_ERROR_CHECK(rmt_config(&led));ESP_ERROR_CHECK(rmt_driver_install(LED_CH,0,0));
#endif
 hardwareReady=true;
}
void sendIr(uint32_t value){
#if GAME_RECEIVER_ONLY
 return;
#endif
 rmt_item32_t items[34]{};items[0].level0=1;items[0].duration0=9000;items[0].level1=0;items[0].duration1=4500;
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
 if(!valid||!irValid(frame))return;rxFrames[receiver]++;lastIrFrame=frame;lastIrAt=millis();lastIrReceiver=receiver;
 if(((frame>>22)&255)!=shooter&&serialRxGate.allow(frame,millis()))Serial.printf("RX_GAME firmware=%s shooter=%u seq=%u receiver=%s\n",FIRMWARE_VERSION,unsigned((frame>>22)&255),unsigned((frame>>14)&255),RX_IDS[receiver]);
 if(phase!="ACTIVE"||!armed||!synced||!mqttOnline||!profileMatched||bench||lowBattery||batteryLatched||millis()-lastDesired>3000)return;
 uint8_t sender=(frame>>22)&255;if(sender==shooter)return;StaticJsonDocument<256> payload;payload["shooter_id"]=sender;payload["shot_seq"]=(frame>>14)&255;payload["weapon_id"]=1;payload["flags"]=(frame>>8)&3;payload["receiver_id"]=RX_IDS[receiver];event("hit_candidate",payload);
}
void leds(const uint8_t colors[LED_COUNT][3]){
#if GAME_RECEIVER_ONLY
 return;
#endif
 rmt_item32_t items[LED_COUNT*24]{};int index=0;
 for(int pixel=0;pixel<LED_COUNT;pixel++){uint8_t rgb[3]={colors[pixel][1],colors[pixel][0],colors[pixel][2]};for(uint8_t value:rgb)for(int bit=7;bit>=0;bit--){bool one=value&(1<<bit);auto &v=items[index++];v.level0=1;v.duration0=one?26:13;v.level1=0;v.duration1=one?24:37;}}
 rmt_write_items(LED_CH,items,LED_COUNT*24,true);delayMicroseconds(300);
}
void renderLeds(uint32_t now,bool safe){uint8_t colors[LED_COUNT][3]{};constexpr int hpLeds=LED_COUNT-1;auto fill=[&](int count,uint8_t r,uint8_t g,uint8_t b){for(int i=1;i<LED_COUNT&&i<=count;i++){colors[i][0]=r;colors[i][1]=g;colors[i][2]=b;}};
 if(!safe){if(now/500%2)fill(hpLeds,20,10,0);else fill(hpLeds,0,0,20);}
 else if(phase=="COUNTDOWN"){
   int64_t remaining=startAt-serverNow();int bars=remaining>5550?5:remaining>3930?5:remaining>2930?4:remaining>1910?3:remaining>870?2:1;
   if(remaining<=5550||now/500%2)fill(1+(bars-1)*(hpLeds-1)/4,15,15,15);
 }
 else if(phase=="PAUSED")fill(now/500%2?hpLeds:1,0,0,20);
 else if(hp<=0){
   if(reviveProgressMs>0)fill(constrain((reviveProgressMs*hpLeds+2999)/3000,1,hpLeds),0,24,8);
   else if(now/400%2)fill(hpLeds,12,0,0);
 }
 else if(int32_t(now-reviveFlashUntil)<0)fill(hpLeds,0,28,8);
 else if(int32_t(now-flashUntil)<0)fill(hpLeds,28,0,0);
#if LEGACY_4E_GAME
 else if(phase=="ACTIVE"&&hp>0&&int32_t(now-shotLedUntil)<0){for(auto &color:colors){color[0]=51;color[1]=51;color[2]=51;}}
#endif
 else fill(constrain((hp*hpLeds+maxHp-1)/maxHp,1,hpLeds),team=="A"?0:24,team=="A"?16:8,team=="A"?24:0);
 if(safe&&phase=="ACTIVE"&&hp>0&&!triggerDown&&int32_t(now-cooldownUntil)>=0&&int32_t(now-shotLedUntil)>=0)colors[0][0]=28;
 leds(colors);
}
void netMessages(){static NetMessage m;while(xQueueReceive(incoming,&m,0)==pdTRUE){DynamicJsonDocument doc(2048);if(deserializeJson(doc,m.body))continue;
  if(String(m.topic).endsWith("/command")){String type=doc["type"]|"";if(type=="time_sync"){uint32_t echo=doc["echo"]|0;int rtt=millis()-echo;if(rtt>=0&&rtt<=400){clockOffset=doc["server_time_ms"].as<int64_t>()+rtt/2-esp_timer_get_time()/1000;syncRtt=rtt;synced=true;}}continue;}
  String newGame=doc["game_id"]|"";uint32_t newGen=doc["game_generation"]|0;
  if(newGame==gameId&&newGen<generation)continue;
  const bool sameRound=newGame==gameId&&newGen==generation;const int previousHp=hp;
  gameId=newGame;generation=newGen;lastDesired=millis();phase=doc["phase"]|"OFFLINE";hp=doc["hp"]|0;team=doc["team"]|"A";shooter=doc["shooter_id"]|0;reviveProgressMs=doc["revive_progress_ms"]|0;
  profileMatched=String(doc["hardware_profile"]|"")==HARDWARE_PROFILE&&playerShooterMatches(shooter);
  bool allowFeedback=phase=="ACTIVE"&&mqttOnline&&synced&&profileMatched&&hardwareReady&&!bench&&!lowBattery&&!batteryLatched;
  // PC-issued IDs prevent retained/repeated messages and rejected hits from vibrating.
  const bool confirmedHit=feedback.observe(sameRound,doc["damage_feedback"]["id"]|0u,doc["damage_feedback"]["at"]|int64_t(0),serverNow(),millis(),allowFeedback,FEEDBACK_MAX_AGE_MS,MOTOR_MIN_INTERVAL_MS);
  if(allowFeedback&&sameRound&&previousHp>0&&hp==0)cue(180,2,370,3,HIT_FEEDBACK_DUTY);
  else if(allowFeedback&&sameRound&&previousHp==0&&hp>0){reviveFlashUntil=millis()+1200;cue(80,3,330,3,REVIVE_FEEDBACK_DUTY);}
  else if(confirmedHit){flashUntil=millis()+250;cue(HIT_PULSE_MS,1,0,2,HIT_FEEDBACK_DUTY);}
  if(!allowFeedback&&phase!="COUNTDOWN")cancelCue();
  armed=(doc["armed"]|false)&&synced&&profileMatched&&!bench;maxHp=doc["rules"]["hp"]|100;fireMs=max(1000,doc["rules"]["fireMs"]|1000);startAt=doc["start_at"]|int64_t(0);startCommitted=doc["start_committed"]|false;
  String command=doc["command_id"]|"";if(phase=="COUNTDOWN"&&command!=lastCommand)countdownPulseMask=0;
  if(phase=="COUNTDOWN"&&synced&&profileMatched&&hardwareReady&&!bench&&!lowBattery&&command.length()&&command!=lastCommand&&!batteryLatched){StaticJsonDocument<256> p;p["command_id"]=command;p["result"]="ok";event("command_ack",p);lastCommand=command;}
 }}
void serialSetup(){while(Serial.available()){char c=Serial.read();if(c=='\n'){DynamicJsonDocument d(1536);auto err=deserializeJson(d,serialLine);serialLine="";
   if(err){Serial.println("ERROR: invalid JSON");continue;}
   if(d["ssid"].is<const char*>()&&d["password"].is<const char*>()&&d["host"].is<const char*>()&&d["id"].is<const char*>()&&d["key"].is<const char*>()){
     if(String(d["ssid"].as<const char*>()).length()>32||String(d["password"].as<const char*>()).length()<8){Serial.println("ERROR: credentials");continue;}
     if(String(d["hardwareProfile"]|"")!=HARDWARE_PROFILE){Serial.println("ERROR: hardwareProfile mismatch; regenerate PC settings");continue;}
     if(!playerIdentityMatches(d["id"].as<const char*>())){Serial.println("ERROR: wrong player settings");continue;}
#if GAME_PLAYER
     if(d["bench"]|false){Serial.println("ERROR: game player requires bench=false");continue;}
#endif
     float scale=d["adcScale"]|2.0f;
#if LEGACY_4E_GAME
     // The assembled PCB has a fixed 1 MOhm / 100 kOhm divider.
     scale=BATTERY_ADC_SCALE;
#else
     if(!isfinite(scale)||scale<1.0f||scale>4.0f){Serial.println("ERROR: adcScale");continue;}
#endif
     String nextIp=d["staticIp"]|"",nextGateway=d["gateway"]|"",nextSubnet=d["subnet"]|"";IPAddress ip,gateway,subnet;
     if(nextIp.length()&&(!ip.fromString(nextIp)||!gateway.fromString(nextGateway)||!subnet.fromString(nextSubnet))){Serial.println("ERROR: static address");continue;}
#if GAME_RECEIVER_ONLY
     if(String(d["id"]|"")!="gun-003"){Serial.println("ERROR: receiver must be player3");continue;}
#endif
     prefs.putString("staticIp",nextIp);prefs.putString("staticGateway",nextGateway);prefs.putString("staticSubnet",nextSubnet);
     stopMotor();for(const char* k:{"ssid","password","host","id","key"})prefs.putString(k,d[k].as<const char*>());prefs.putUInt("port",d["port"]|1883);prefs.putBool("bench",d["bench"]|false);prefs.putFloat("adcScale",scale);Serial.println("SAVED: restarting");Serial.flush();delay(200);ESP.restart();
   }else Serial.println("ERROR: required fields");
  }else if(c!='\r'){if(serialLine.length()<1024)serialLine+=c;else serialLine="";}}}
void setup(){esp_log_level_set("*",ESP_LOG_NONE);Serial.begin(115200);
#if !GAME_RECEIVER_ONLY
 pinMode(MOTOR,OUTPUT);digitalWrite(MOTOR,LOW);
#if LEGACY_4E_GAME
 ledcSetup(MOTOR_PWM_CHANNEL,5000,8);ledcAttachPin(MOTOR,MOTOR_PWM_CHANNEL);ledcWrite(MOTOR_PWM_CHANNEL,0);
 pinMode(SW_MODE,INPUT_PULLUP);pinMode(SW_RELOAD,INPUT_PULLUP);
#endif
 pinMode(TX_PIN,OUTPUT);digitalWrite(TX_PIN,LOW);pinMode(LED_PIN,OUTPUT);digitalWrite(LED_PIN,LOW);pinMode(TRIGGER,INPUT_PULLUP);for(int pin:RX_PINS)pinMode(pin,INPUT);Serial.begin(115200);
 esp_timer_create_args_t timerArgs{};timerArgs.callback=stopMotor;timerArgs.name="motor-off";ESP_ERROR_CHECK(esp_timer_create(&timerArgs,&motorTimer));
#endif
#if GAME_RECEIVER_ONLY
 for(int pin:RX_PINS)pinMode(pin,INPUT_PULLUP);
#endif
 prefs.begin("ir-arena",false);id=prefs.getString("id","");key=prefs.getString("key","");ssid=prefs.getString("ssid","");password=prefs.getString("password","");host=prefs.getString("host","");bench=prefs.getBool("bench",false);
#if GAME_RECEIVER_ONLY
 bench=false;
#endif
 staticIp=prefs.getString("staticIp","");staticGateway=prefs.getString("staticGateway","");staticSubnet=prefs.getString("staticSubnet","");
#if LEGACY_4E_GAME
 adcScale=BATTERY_ADC_SCALE;
#else
 adcScale=prefs.getFloat("adcScale",2.0f);
#endif
 boot=String(esp_random(),HEX)+String(esp_random(),HEX);
 Serial.printf("BOOT firmware=%s player=%d id=%s\n",FIRMWARE_VERSION,GAME_PLAYER_NUMBER,id.c_str());
#if !GAME_RECEIVER_ONLY
 analogReadResolution(12);analogSetPinAttenuation(BATTERY,ADC_11db);
#endif
 incoming=xQueueCreate(12,sizeof(NetMessage));if(!incoming){Serial.println("ERROR mqtt_queue_init");while(true)delay(1000);}initRmt();
#if !GAME_RECEIVER_ONLY
 battery=analogReadMilliVolts(BATTERY)/1000.0f*adcScale;lowBattery=!bench&&battery<3.3f;
 triggerRaw=triggerDown=digitalRead(TRIGGER)==LOW;triggerConsumed=triggerDown;lastDebounce=millis();
#endif
#if GAME_RECEIVER_ONLY
 if(id!="gun-003"){Serial.println("SETUP: player3 configuration required");while(true){serialSetup();delay(10);}}
#endif
 if(!playerIdentityMatches(id.c_str())||(GAME_PLAYER_NUMBER>0&&bench)){
   Serial.printf("SETUP expected_id=%s bench=false; send matching settings\n",GAME_DEVICE_ID);while(true){serialSetup();delay(10);}
 }
 if(!ssid.length()||!id.length()){Serial.println("SETUP: send one JSON line over USB. No IR output.");while(true){serialSetup();delay(10);}}
 WiFi.mode(WIFI_STA);WiFi.setSleep(false);
 if(staticIp.length()){IPAddress ip,gateway,subnet;if(!ip.fromString(staticIp)||!gateway.fromString(staticGateway)||!subnet.fromString(staticSubnet)||!WiFi.config(ip,gateway,subnet)){Serial.println("ERROR: static address");return;}}
 WiFi.begin(ssid.c_str(),password.c_str());initMqtt();logStatus(true);
}
void loop(){serialSetup();uint32_t now=millis();
 if(!mqttOnline){armed=false;synced=false;phase="OFFLINE";cancelCue();shotHeld=false;}
 if(needHello){needHello=false;StaticJsonDocument<256>d;d["boot_id"]=boot;d["hardware_profile"]=HARDWARE_PROFILE;d["firmware_version"]=FIRMWARE_VERSION;publish("hello",d);lastTelemetry=0;}
 netMessages();for(int i=0;i<RX_COUNT;i++)receiveIr(i);now=millis();
 if(WiFi.status()!=WL_CONNECTED&&now-lastWifi>5000){lastWifi=now;WiFi.reconnect();}
 if(now-lastTelemetry>=1000){lastTelemetry=now;
#if !GAME_RECEIVER_ONLY
 float measured=analogReadMilliVolts(BATTERY)/1000.0f*adcScale;battery=battery==0?measured:battery*.75f+measured*.25f;
   lowBattery=!bench&&battery<3.3f;if(!bench&&battery<3.0f){if(!lowSince)lowSince=now;if(now-lowSince>3000)batteryLatched=true;}else lowSince=0;
#endif
   DynamicJsonDocument d(1536);d["boot_id"]=boot;d["hardware_profile"]=HARDWARE_PROFILE;d["firmware_version"]=FIRMWARE_VERSION;d["hardware_ready"]=hardwareReady;d["bench"]=bench;d["motor_active"]=motorActive;d["motor_duty"]=motorDuty;auto counters=d.createNestedObject("rx_frames");for(int i=0;i<RX_COUNT;i++)counters[RX_IDS[i]]=rxFrames[i];d["device_time_ms"]=now;d["syncRtt"]=syncRtt;
#if !GAME_RECEIVER_ONLY
 d["battery"]=battery;
#endif
d["lowBattery"]=lowBattery||batteryLatched;d["rssi"]=WiFi.RSSI();d["hp"]=hp;
#if LEGACY_4E_GAME
   d["sw_mode_pressed"]=digitalRead(SW_MODE)==LOW;d["sw_reload_pressed"]=digitalRead(SW_RELOAD)==LOW;
#endif
   if(lastIrReceiver>=0){auto last=d.createNestedObject("last_ir");char hex[11];snprintf(hex,sizeof(hex),"0x%08lX",(unsigned long)lastIrFrame);last["frame"]=hex;last["receiver_id"]=RX_IDS[lastIrReceiver];last["device_time_ms"]=lastIrAt;}
   publish("telemetry",d,0);
 }
 bool safe=mqttOnline&&synced&&profileMatched&&hardwareReady&&!bench&&now-lastDesired<3000&&!batteryLatched&&!lowBattery;
 if(!safe||(phase!="ACTIVE"&&phase!="COUNTDOWN")){cancelCue();shotHeld=false;}
 if(phase=="COUNTDOWN"&&safe){
   const int64_t marks[]={startAt-5550,startAt-3930,startAt-2930,startAt-1910,startAt-870};
   for(int i=0;i<5;i++)if(!(countdownPulseMask&(1u<<i))&&serverNow()>=marks[i]){
     countdownPulseMask|=1u<<i;if(serverNow()-marks[i]<250){
#if LEGACY_4E_GAME
       cue(COUNTDOWN_PULSE_MS,1,0,1,COUNTDOWN_MOTOR_DUTIES[i]);
#else
       cue(COUNTDOWN_PULSE_MS,1,0,1);
#endif
     }
   }
 }
 if(phase=="COUNTDOWN"&&safe&&startCommitted&&serverNow()>=startAt){phase="ACTIVE";armed=true;cue(180,1,0,2,HIT_FEEDBACK_DUTY);}
#if !GAME_RECEIVER_ONLY
 bool raw=digitalRead(TRIGGER)==LOW;if(raw!=triggerRaw){triggerRaw=raw;lastDebounce=now;}if(now-lastDebounce>20)triggerDown=raw;
 if(!triggerDown){if(shotHeld){StaticJsonDocument<64>p;p["shot_seq"]=activeShotSeq;event("shot_released",p);}shotHeld=false;triggerConsumed=false;}
 if(triggerDown&&!triggerConsumed){
   triggerConsumed=true;
   if(safe&&armed&&phase=="ACTIVE"&&hp>0&&int32_t(now-cooldownUntil)>=0){
     lastShotLocal=now;cooldownUntil=now+fireMs;activeShotSeq=shotSeq++;shotHeld=true;
     StaticJsonDocument<128>p;p["shot_seq"]=activeShotSeq;p["weapon_id"]=1;event("shot_fired",p);
     Serial.printf("SHOT shooter=%u seq=%u\n",unsigned(shooter),unsigned(activeShotSeq));
     sendIr(irFrame(shooter,activeShotSeq,0));cue(SHOT_PULSE_MS,1,0,1,SHOT_FEEDBACK_DUTY);
#if LEGACY_4E_GAME
     shotLedUntil=millis()+310;
#endif
     now=millis();nextRescuePulse=now+80;lastHoldEvent=now-250;
   }
 }
 if(shotHeld&&triggerDown&&safe&&armed&&phase=="ACTIVE"&&hp>0){
   now=millis();if(now-lastHoldEvent>=250){StaticJsonDocument<64>p;p["shot_seq"]=activeShotSeq;event("shot_hold",p);lastHoldEvent=now;}
   if(int32_t(now-nextRescuePulse)>=0){sendIr(irFrame(shooter,activeShotSeq,1));nextRescuePulse=millis()+150;}
 }
#endif
#if !GAME_RECEIVER_ONLY
 now=millis();tickCue(now);
 if(now-lastRender>80){lastRender=now;renderLeds(now,safe);}
#endif
 logStatus();
 delay(1);
}
