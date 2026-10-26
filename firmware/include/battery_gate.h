#pragma once
constexpr float batteryReplacementVoltage(bool nineVoltBoard) { return nineVoltBoard ? 7.0f : 3.3f; }
constexpr bool batteryNeedsReplacement(float voltage, bool nineVoltBoard) {
  return nineVoltBoard ? voltage <= batteryReplacementVoltage(true) : voltage < batteryReplacementVoltage(false);
}
constexpr bool batteryLatchLow(float voltage, bool nineVoltBoard) {
  return nineVoltBoard ? voltage <= batteryReplacementVoltage(true) : voltage < 3.0f;
}
// A test override is temporary: it requires both server flags, an active test
// phase and a fresh desired lease. The measured/latching state is preserved.
constexpr bool batteryOverrideAllowed(bool testMode, bool requested, bool testPhase, bool freshLease) {
  return testMode && requested && testPhase && freshLease;
}
constexpr bool batteryGateBlocked(bool low, bool latched, bool overrideAllowed) {
  return (low || latched) && !overrideAllowed;
}
