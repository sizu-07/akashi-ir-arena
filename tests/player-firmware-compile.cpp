#include "../firmware/include/player_identity.h"
#include "../firmware/include/serial_rx_gate.h"
#include "../firmware/include/battery_gate.h"
static_assert(batteryReplacementVoltage(true)==7.0f,"9 V board replacement threshold is 7 V");
static_assert(!batteryNeedsReplacement(9.0f,true),"Fresh 9 V battery is usable");
static_assert(!batteryNeedsReplacement(7.01f,true),"Above 7 V is usable");
static_assert(batteryNeedsReplacement(7.0f,true),"Exactly 7 V requires replacement");
static_assert(batteryNeedsReplacement(6.99f,true),"Below 7 V requires replacement");
static_assert(batteryLatchLow(7.0f,true),"9 V latch uses the same inclusive threshold");
static_assert(!batteryNeedsReplacement(3.3f,false)&&batteryNeedsReplacement(3.29f,false),"Other power profile retains its threshold");
static_assert(!batteryLatchLow(3.0f,false)&&batteryLatchLow(2.99f,false),"Other power profile retains its latch");
static_assert(batteryOverrideAllowed(true,true,true,true),"Fresh active test allows low battery");
static_assert(!batteryOverrideAllowed(false,true,true,true),"Normal match keeps protection");
static_assert(!batteryOverrideAllowed(true,false,true,true),"Override requires explicit permission");
static_assert(!batteryOverrideAllowed(true,true,false,true),"Paused/finished test keeps protection");
static_assert(!batteryOverrideAllowed(true,true,true,false),"Expired lease restores protection");
static_assert(!batteryGateBlocked(true,true,true),"Test bypass covers an existing low-voltage latch");
static_assert(batteryGateBlocked(true,true,false),"Protection resumes without clearing the latch");
static_assert(!batteryGateBlocked(false,false,false),"Normal healthy battery operates");
#define inline constexpr
#include "../firmware/include/ir_protocol.h"
#undef inline
static_assert(GAME_PLAYER_NUMBER>=1&&GAME_PLAYER_NUMBER<=4,"Build must identify one actual player");
static_assert(GAME_DEVICE_ID[6]=='0'+GAME_PLAYER_NUMBER,"Device ID must agree with player number");
static_assert(playerIdentityMatches(GAME_DEVICE_ID),"Accept matching provisioned identity");
static_assert(!playerIdentityMatches(nullptr),"Reject missing player identity");
static_assert(!playerIdentityMatches("gun-000"),"Reject another identity");
static_assert(!playerIdentityMatches("gun-001-extra"),"Reject ID prefix with unexpected suffix");
static_assert(playerShooterMatches(GAME_PLAYER_NUMBER),"Accept server shooter ID");
static_assert(!playerShooterMatches(GAME_PLAYER_NUMBER%4+1),"Reject mismatching server shooter ID");
constexpr uint32_t frame=irFrame(GAME_PLAYER_NUMBER,21,0);
static_assert(irValid(frame),"Each player's real shot carries valid game CRC");
static_assert(((frame>>22)&255)==GAME_PLAYER_NUMBER,"IR must identify the matching player");
constexpr bool logGateWorks(){
  SerialRxGate gate;
  if(!gate.allow(frame,0)||gate.allow(frame,1)||gate.allow(frame,999))return false;
  if(!gate.allow(frame,1000)||gate.allow(irFrame(GAME_PLAYER_NUMBER,21,1),1001))return false;
  return gate.allow(irFrame(GAME_PLAYER_NUMBER,22,0),1002);
}
static_assert(logGateWorks(),"Do not flood serial with repeated reception or rescue pulses");
constexpr bool wrapSafe(){SerialRxGate gate;return gate.allow(frame,0xffffff00u)&&!gate.allow(frame,0u)&&gate.allow(frame,0x400u);}
static_assert(wrapSafe(),"Serial suppression remains valid across millis wrap");
