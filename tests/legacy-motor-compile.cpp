#include "../firmware/wifi-game-diagnostic/include/motor_feedback.h"
#include <initializer_list>
using namespace legacy_feedback;

constexpr bool ceilingsAndEnvelopes() {
  for (auto pattern : {Pattern::Shot, Pattern::Hit, Pattern::Countdown, Pattern::Defeat, Pattern::Revive}) {
    for (uint8_t beat = 0; beat < 5; ++beat)
      for (uint32_t t = 0; t <= duration(pattern) + 20; ++t)
        if (dutyAt(pattern, t, beat) > MAX_DUTY) return false;
    if (dutyAt(pattern, duration(pattern)) != 0) return false;
  }
  if (dutyAt(Pattern::Shot, 100) != 110 || duration(Pattern::Shot) != 310) return false;
  if (!(reviveDuty(150) < reviveDuty(250) && reviveDuty(250) < reviveDuty(350))) return false;
  if (!(reviveDuty(350) == MAX_DUTY && reviveDuty(450) < MAX_DUTY && reviveDuty(500) == 0)) return false;
  uint32_t lastEnergy = 0;
  for (uint8_t beat = 0; beat < 5; ++beat) {
    uint32_t energy = 0;
    for (uint32_t t = 0; t < COUNTDOWN_MS; ++t) energy += dutyAt(Pattern::Countdown, t, beat);
    if (energy <= lastEnergy) return false;
    lastEnergy = energy;
  }
  return true;
}
constexpr bool completeTriplePulseAndRecovery() {
  Controller motor;
  if (!motor.start(Pattern::Defeat, 1000)) return false;
  unsigned pulses = 0;
  for (uint32_t elapsed = 0; elapsed <= duration(Pattern::Defeat); elapsed += 5) {
    const auto frame = motor.update(1000 + elapsed);
    if (frame.pulseStarted) ++pulses;
    if (elapsed < duration(Pattern::Defeat) &&
        elapsed % (DEFEAT_PULSE_MS + DEFEAT_REST_MS) >= DEFEAT_PULSE_MS && frame.duty) return false;
    if (elapsed == 400 && motor.start(Pattern::Shot, 1400)) return false;
  }
  const uint32_t end = 1000 + duration(Pattern::Defeat);
  if (pulses != 3 || motor.active() || motor.ready(end + RECOVERY_MS - 1)) return false;
  if (!motor.start(Pattern::Revive, end + RECOVERY_MS)) return false;
  return motor.update(end + RECOVERY_MS + REVIVE_MS).finished && !motor.active();
}
constexpr bool timerDelayCancelAndWrap() {
  Controller motor;
  if (!motor.start(Pattern::Revive, 0xfffffff0u)) return false;
  if (motor.update(4u).duty != reviveDuty(20)) return false;
  motor.cancel(4u);
  if (motor.update(10u).duty != 0 || motor.ready(253u)) return false;
  if (!motor.start(Pattern::Hit, 254u)) return false;
  // A delayed update still ends the effect instead of extending its pulse.
  const auto frame = motor.update(2000u);
  return frame.finished && frame.duty == 0 && motor.ready(2000u);
}
static_assert(ceilingsAndEnvelopes(), "All effects must stay under the PWM ceiling, fade out and grow as intended");
static_assert(completeTriplePulseAndRecovery(), "Death must finish three separate pulses and enforce recovery before the next effect");
static_assert(timerDelayCancelAndWrap(), "Effects must stop on cancellation, timer delay and millis rollover");
