#pragma once
#include <stdint.h>
// Logging only. Every valid reception still reaches the game processing path.
class SerialRxGate {
  uint32_t lastFrame=0,lastAt=0;
  bool initialized=false;
public:
  #if __cplusplus >= 201402L
  constexpr
  #endif
  bool allow(uint32_t frame,uint32_t now) {
    if(((frame>>8)&3)!=0)return false; // Rescue repeats are shown through HP/state changes.
    if(initialized&&frame==lastFrame&&uint32_t(now-lastAt)<1000)return false;
    lastFrame=frame;lastAt=now;initialized=true;return true;
  }
};
