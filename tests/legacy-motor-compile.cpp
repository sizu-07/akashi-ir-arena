#include "../firmware/wifi-game-diagnostic/include/motor_feedback.h"
using namespace legacy_feedback;
constexpr bool rapidPressesNeverReplay() {
  Trigger t; t.initialize(false, 0);
  if(t.update(true, 100, true) != TriggerEvent::None) return false;
  if(t.update(true, 124, true) != TriggerEvent::None) return false;
  if(t.update(true, 125, true) != TriggerEvent::Shot) return false;
  t.update(false, 150, true); t.update(false, 175, true);
  t.update(true, 200, true);
  if(t.update(true, 225, true) != TriggerEvent::Ignored) return false;
  // Passing the cooldown while held must never replay the rejected press.
  if(t.update(true, 1125, true) != TriggerEvent::None) return false;
  t.update(false, 1200, true); t.update(false, 1225, true);
  t.update(true, 1250, true);
  return t.update(true, 1275, true) == TriggerEvent::Shot;
}
constexpr bool exactCooldownAndBusyRejection() {
  Trigger t; t.initialize(false, 0);
  t.update(true, 0, true);
  if(t.update(true, 25, true) != TriggerEvent::Shot) return false;
  t.update(false, 50, true); t.update(false, 75, true);
  t.update(true, 975, true);
  if(t.update(true, 1000, true) != TriggerEvent::Ignored) return false;
  t.update(false, 1000, true); t.update(false, 1025, true);
  t.update(true, 1025, true);
  if(t.update(true, 1050, true) != TriggerEvent::Shot) return false;
  t.update(false, 1075, true); t.update(false, 1100, true);
  t.update(true, 2200, false);
  if(t.update(true, 2225, false) != TriggerEvent::Ignored) return false;
  return t.update(true, 2300, true) == TriggerEvent::None;
}
constexpr bool startupHeldBounceAndWrap() {
  Trigger t; t.initialize(true, 0xffffffe0u);
  if(t.update(true, 0xffffffe5u, true) != TriggerEvent::None) return false;
  t.update(false, 0xffffffe5u, true); t.update(false, 0xfffffffeu, true);
  t.update(true, 0xffffffffu, true);
  if(t.update(true, 24u, true) != TriggerEvent::Shot) return false;
  t.update(false, 100, true); t.update(false, 125, true);
  t.update(true, 999, true);
  if(t.update(true, 1024, true) != TriggerEvent::Shot) return false;
  Trigger bounce; bounce.initialize(false, 0);
  bounce.update(true, 10, true); bounce.update(false, 20, true);
  return bounce.update(false, 100, true) == TriggerEvent::None;
}
static_assert(SHOT_DUTY == 220 && SHOT_MS == 310 && HIT_DUTY == 255 && HIT_MS == 420, "Restore the working v3 shot and hit profile");
static_assert(LED_COUNT == 8 && LED_WHITE == 51, "Eight RGB pixels at 20 percent");
static_assert(rapidPressesNeverReplay(), "Discard rapid presses and never replay a held press");
static_assert(exactCooldownAndBusyRejection(), "Ignored presses cannot extend the cooldown or wait for the motor");
static_assert(startupHeldBounceAndWrap(), "Require release after held boot, filter bounce and support uptime rollover");
static_assert(reviveDuty(0) == 120 && reviveDuty(499) == 254 && reviveDuty(500) == 0, "Revive must end after 500 ms");
