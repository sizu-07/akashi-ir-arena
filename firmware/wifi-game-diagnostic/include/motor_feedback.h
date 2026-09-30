#pragma once
#include <stdint.h>
#if __cplusplus >= 201402L
#define FEEDBACK_CONSTEXPR constexpr
#else
#define FEEDBACK_CONSTEXPR inline
#endif

namespace legacy_feedback {
// Restore the v3 motor profile. These are PWM values, not voltage protection.
constexpr uint8_t SHOT_DUTY = 220, HIT_DUTY = 255, DEFEAT_DUTY = 255;
constexpr uint8_t COUNTDOWN_DUTIES[5] = {150, 170, 190, 210, 230};
constexpr uint32_t SHOT_MS = 310, HIT_MS = 420, COUNTDOWN_MS = 300;
constexpr uint32_t DEFEAT_MS = 180, REVIVE_MS = 500;
constexpr uint32_t SHOT_COOLDOWN_MS = 1000, DEBOUNCE_MS = 25;
constexpr uint8_t LED_COUNT = 8, LED_WHITE = 51;
FEEDBACK_CONSTEXPR uint8_t reviveDuty(uint32_t elapsed) {
  return elapsed >= REVIVE_MS ? 0 : 120 + (135 * elapsed / REVIVE_MS);
}

enum class TriggerEvent : uint8_t { None, Released, Shot, Ignored };
class Trigger {
  bool rawPressed_ = false, stablePressed_ = false, armed_ = true, shotSeen_ = false;
  uint32_t changedAt_ = 0, lastShotAt_ = 0;
 public:
  FEEDBACK_CONSTEXPR void initialize(bool pressed, uint32_t now) {
    rawPressed_ = stablePressed_ = pressed;
    armed_ = !pressed; shotSeen_ = false; changedAt_ = now;
  }
  FEEDBACK_CONSTEXPR TriggerEvent update(bool pressed, uint32_t now, bool outputReady) {
    if (pressed != rawPressed_) { rawPressed_ = pressed; changedAt_ = now; }
    if (pressed == stablePressed_ || uint32_t(now - changedAt_) < DEBOUNCE_MS)
      return TriggerEvent::None;
    stablePressed_ = pressed;
    if (!pressed) { armed_ = true; return TriggerEvent::Released; }
    if (!armed_) return TriggerEvent::None;
    armed_ = false;
    // Discard cooldown/busy presses. A held press is never replayed later.
    if (!outputReady || (shotSeen_ && uint32_t(now - lastShotAt_) < SHOT_COOLDOWN_MS))
      return TriggerEvent::Ignored;
    lastShotAt_ = now; shotSeen_ = true;
    return TriggerEvent::Shot;
  }
};
} // namespace legacy_feedback
#undef FEEDBACK_CONSTEXPR
