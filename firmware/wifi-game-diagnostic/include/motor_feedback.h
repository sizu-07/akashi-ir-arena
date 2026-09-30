#pragma once
#include <stdint.h>
#if __cplusplus >= 201402L
#define MOTOR_EFFECT_CONSTEXPR constexpr
#else
#define MOTOR_EFFECT_CONSTEXPR inline
#endif

// Conservative, open-loop settings for the legacy PCB. This is a PWM ceiling,
// not a measured voltage/current limit. The motor rail has no feedback sensor.
namespace legacy_feedback {
constexpr uint8_t MAX_DUTY = 220;
constexpr uint8_t RUN_MAX_DUTY = 180;
constexpr uint8_t STARTUP_DUTY = 220;
constexpr uint32_t STARTUP_MS = 60, SETTLE_MS = 20;
constexpr uint8_t SHOT_DUTY = 150;
constexpr uint8_t HIT_DUTY = 180;
constexpr uint8_t DEFEAT_DUTY = 180;
constexpr uint8_t COUNTDOWN_DUTIES[5] = {120, 135, 150, 165, 180};
constexpr uint32_t SHOT_MS = 310, HIT_MS = 420, COUNTDOWN_MS = 300;
constexpr uint32_t DEFEAT_PULSE_MS = 180, DEFEAT_REST_MS = 300;
constexpr uint32_t REVIVE_MS = 500, RECOVERY_MS = 250, TICK_US = 5000;
enum class Pattern : uint8_t { None, Shot, Hit, Countdown, Defeat, Revive };

constexpr uint8_t clampDuty(uint32_t duty) {
  return duty > MAX_DUTY ? MAX_DUTY : static_cast<uint8_t>(duty);
}
constexpr uint32_t duration(Pattern pattern) {
  return pattern == Pattern::Shot ? SHOT_MS :
         pattern == Pattern::Hit ? HIT_MS :
         pattern == Pattern::Countdown ? COUNTDOWN_MS :
         pattern == Pattern::Defeat ? 3 * DEFEAT_PULSE_MS + 2 * DEFEAT_REST_MS :
         pattern == Pattern::Revive ? REVIVE_MS : 0;
}
MOTOR_EFFECT_CONSTEXPR uint8_t blend(uint8_t from, uint8_t to, uint32_t t, uint32_t span) {
  if (t >= span) return clampDuty(to);
  return clampDuty((uint32_t(from) * (span - t) + uint32_t(to) * t) / span);
}
MOTOR_EFFECT_CONSTEXPR uint8_t assistedPulse(uint32_t t, uint32_t span, uint8_t target) {
  // A short kick at the previously working duty starts the motor from rest.
  // Only this kick/settling period may exceed the sustained-drive ceiling.
  if (t >= span) return 0;
  if (t < STARTUP_MS) return STARTUP_DUTY;
  if (t < STARTUP_MS + SETTLE_MS) return blend(STARTUP_DUTY, target, t - STARTUP_MS, SETTLE_MS);
  if (t >= span - 30) return blend(target, 0, t - (span - 30), 30);
  return clampDuty(target);
}
MOTOR_EFFECT_CONSTEXPR uint8_t reviveDuty(uint32_t t) {
  if (t >= REVIVE_MS) return 0;
  if (t < STARTUP_MS) return STARTUP_DUTY;
  if (t < STARTUP_MS + SETTLE_MS) return blend(STARTUP_DUTY, 130, t - STARTUP_MS, SETTLE_MS);
  if (t < 100) return 130;
  if (t < 350) {
    const uint32_t x = t - 100;
    // Accelerating swell: a quiet opening, then a rapid rise into the peak.
    return clampDuty(130 + (50 * x * x / (250 * 250)));
  }
  if (t < 410) return RUN_MAX_DUTY;
  return blend(RUN_MAX_DUTY, 0, t - 410, 90);
}
MOTOR_EFFECT_CONSTEXPR uint8_t dutyAt(Pattern pattern, uint32_t elapsed, uint8_t countdownIndex = 0) {
  if (elapsed >= duration(pattern)) return 0;
  if (pattern == Pattern::Shot) return assistedPulse(elapsed, SHOT_MS, SHOT_DUTY);
  if (pattern == Pattern::Hit) return assistedPulse(elapsed, HIT_MS, HIT_DUTY);
  if (pattern == Pattern::Countdown) {
    const uint8_t target = COUNTDOWN_DUTIES[countdownIndex < 5 ? countdownIndex : 4];
    return assistedPulse(elapsed, COUNTDOWN_MS, target);
  }
  if (pattern == Pattern::Defeat) {
    const uint32_t within = elapsed % (DEFEAT_PULSE_MS + DEFEAT_REST_MS);
    return assistedPulse(within, DEFEAT_PULSE_MS, DEFEAT_DUTY);
  }
  return pattern == Pattern::Revive ? reviveDuty(elapsed) : 0;
}

struct Frame { uint8_t duty; bool pulseStarted; bool finished; Pattern pattern; };
class Controller {
  Pattern pattern_ = Pattern::None;
  uint32_t started_ = 0, ended_ = 0;
  uint8_t countdownIndex_ = 0, notifiedPulse_ = 255;
  bool endedOnce_ = false;
 public:
  constexpr bool active() const { return pattern_ != Pattern::None; }
  constexpr Pattern pattern() const { return pattern_; }
  constexpr bool ready(uint32_t now) const {
    return !active() && (!endedOnce_ || uint32_t(now - ended_) >= RECOVERY_MS);
  }
  MOTOR_EFFECT_CONSTEXPR bool start(Pattern pattern, uint32_t now, uint8_t countdownIndex = 0) {
    if (pattern == Pattern::None || !ready(now)) return false;
    pattern_ = pattern; started_ = now; countdownIndex_ = countdownIndex;
    notifiedPulse_ = 255;
    return true;
  }
  MOTOR_EFFECT_CONSTEXPR void cancel(uint32_t now) {
    if (active()) { pattern_ = Pattern::None; ended_ = now; endedOnce_ = true; }
  }
  MOTOR_EFFECT_CONSTEXPR Frame update(uint32_t now) {
    const Pattern previous = pattern_;
    if (!active()) return {0, false, false, Pattern::None};
    const uint32_t elapsed = uint32_t(now - started_);
    if (elapsed >= duration(pattern_)) {
      // End at the scheduled time even if the timer callback was delayed.
      ended_ = started_ + duration(pattern_); endedOnce_ = true;
      pattern_ = Pattern::None;
      return {0, false, true, previous};
    }
    const uint8_t duty = dutyAt(pattern_, elapsed, countdownIndex_);
    const uint8_t pulse = pattern_ == Pattern::Defeat ?
        elapsed / (DEFEAT_PULSE_MS + DEFEAT_REST_MS) : 0;
    const bool pulseStarted = duty > 0 && pulse != notifiedPulse_;
    if (pulseStarted) notifiedPulse_ = pulse;
    return {duty, pulseStarted, false, pattern_};
  }
};
static_assert(MAX_DUTY < 255, "Every motor effect must remain below full duty");
static_assert(REVIVE_MS <= 500 && SHOT_MS <= 500 && HIT_MS <= 500,
              "No continuous motor pulse may exceed 500 ms");
}  // namespace legacy_feedback
#undef MOTOR_EFFECT_CONSTEXPR
