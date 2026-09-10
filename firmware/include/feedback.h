#pragma once
#include <stdint.h>
// Stateful gate shared by firmware and host tests. IDs are monotonic within a round.
class DamageFeedback {
  uint32_t lastId=0,lastPulse=0;
  bool initialized=false,pulsed=false;
public:
  #if __cplusplus >= 201402L
  constexpr
  #endif
  bool observe(bool sameRound,uint32_t id,int64_t at,int64_t serverNow,uint32_t now,
               bool allowed,uint32_t maxAge,uint32_t minInterval){
    if(!initialized||!sameRound){initialized=true;lastId=id;pulsed=false;return false;}
    if(id<=lastId)return false;
    lastId=id; // Discard stale/disabled events; do not replay after reconnection.
    if(!allowed||serverNow-at<0||serverNow-at>maxAge)return false;
    if(pulsed&&uint32_t(now-lastPulse)<minInterval)return false;
    lastPulse=now;pulsed=true;return true;
  }
};
