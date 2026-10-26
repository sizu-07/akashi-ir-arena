#include "../firmware/receiver-diagnostic/src/pulse_decoder.h"

// Actual successful reception supplied by the user, not ideal generated pulses.
constexpr Pulse captured[] = {
  {8997,0},{4504,1},{605,0},{524,1},{527,0},{1712,1},{605,0},{525,1},
  {606,0},{504,1},{601,0},{525,1},{550,0},{581,1},{527,0},{577,1},
  {603,0},{530,1},{573,0},{536,1},{598,0},{1659,1},{583,0},{528,1},
  {605,0},{523,1},{610,0},{522,1},{577,0},{1657,1},{551,0},{581,1},
  {528,0},{1709,1},{552,0},{581,1},{576,0},{1658,1},{606,0},{527,1},
  {581,0},{527,1},{602,0},{528,1},{580,0},{1658,1},{606,0},{522,1},
  {552,0},{579,1},{582,0},{524,1},{552,0},{1710,1},{528,0},{578,1},
  {552,0},{579,1},{528,0},{580,1},{606,0},{1654,1},{576,0},{1663,1},
  {646,0},{1614,1},{578,0}
};
constexpr size_t count = sizeof(captured) / sizeof(captured[0]);
static_assert(count == 67, "Complete header, 32 bits and stop mark");
static_assert(decodeEnvelope(captured, count).found, "Accept actual game reception");
static_assert(decodeEnvelope(captured, count).value == 0x40454447, "Preserve MSB bit order");
static_assert(!decodeEnvelope(captured, count - 1).found, "Reject missing stop mark");
static_assert(!decodeEnvelope(captured, count - 3).found, "Reject truncated payload");
constexpr Pulse noise[] = {{123,0},{12000,1}};
static_assert(!decodeEnvelope(noise, 2).found, "Short noise is not a game frame");

constexpr bool rejectsDamagedPulse() {
  Pulse changed[67]{};
  for (size_t i = 0; i < count; ++i) changed[i] = captured[i];
  changed[15].duration = 1000; // Between legal 0 and 1 spaces.
  return !decodeEnvelope(changed, count).found;
}
static_assert(rejectsDamagedPulse(), "Reject ambiguous bit timing");

constexpr bool findsFrameAfterNoise() {
  Pulse prefixed[69]{};
  prefixed[0] = {123,0}; prefixed[1] = {400,1};
  for (size_t i = 0; i < count; ++i) prefixed[i + 2] = captured[i];
  return decodeEnvelope(prefixed, 69).value == 0x40454447;
}
static_assert(findsFrameAfterNoise(), "Noise before the header does not hide a valid frame");

// Game checks use the exact production irValid(), evaluated at compile time.
// constexpr is applied only in this test translation unit, leaving production unchanged.
#define inline constexpr
#include "../firmware/include/ir_protocol.h"
#undef inline
static_assert(irValid(0x40454447), "Captured frame passes production format and CRC checks");
static_assert(!irValid(0x40454446), "Corrupted CRC is not GAME");
static_assert(irValid(irFrame(1, 21, 0)), "Combat frame is GAME");
static_assert(irValid(irFrame(1, 21, 1)), "Rescue frame is GAME");
static_assert(!irValid(irFrame(1, 21, 2)), "Unknown flags are not GAME");
constexpr uint32_t externalTop = 0x001234;
static_assert(!irValid((externalTop << 8) | irCrc(externalTop)), "CRC alone does not make a frame GAME");
