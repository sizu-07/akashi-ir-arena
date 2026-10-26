#pragma once
#include <stddef.h>
#include <stdint.h>

struct Pulse { uint16_t duration; uint8_t level; };
struct DecodedFrame { bool found; uint32_t value; size_t next; };

constexpr bool nearDuration(uint16_t got, uint16_t expected) {
  return uint32_t(got) * 100 > uint32_t(expected) * 65 &&
         uint32_t(got) * 100 < uint32_t(expected) * 135;
}

// The game uses a NEC-shaped envelope but transmits its 32 bits MSB first.
// Require the final LOW mark too; incomplete frames remain unclassified.
constexpr DecodedFrame decodeEnvelope(const Pulse* pulses, size_t count, size_t from = 0) {
  for (size_t start = from; start + 66 < count; ++start) {
    if (pulses[start].level != 0 || pulses[start + 1].level != 1 ||
        !nearDuration(pulses[start].duration, 9000) ||
        !nearDuration(pulses[start + 1].duration, 4500)) continue;
    uint32_t value = 0;
    bool valid = true;
    for (size_t bit = 0; bit < 32; ++bit) {
      const size_t at = start + 2 + bit * 2;
      if (pulses[at].level != 0 || pulses[at + 1].level != 1 ||
          !nearDuration(pulses[at].duration, 560)) { valid = false; break; }
      value <<= 1;
      if (nearDuration(pulses[at + 1].duration, 1690)) value |= 1;
      else if (!nearDuration(pulses[at + 1].duration, 560)) { valid = false; break; }
    }
    if (valid && pulses[start + 66].level == 0 && nearDuration(pulses[start + 66].duration, 560))
      return {true, value, start + 67};
  }
  return {false, 0, count};
}
