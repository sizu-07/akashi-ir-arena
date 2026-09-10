#pragma once
#include <stdint.h>
// MSB first: version(2), shooter(8), sequence(8), weapon(4), flags(2), CRC(8).
inline uint8_t irCrc(uint32_t upper24) {
  uint8_t crc=0;
  for(int shift=16;shift>=0;shift-=8){crc^=(upper24>>shift)&255;for(int i=0;i<8;i++)crc=(crc&128)?uint8_t((crc<<1)^0x07):uint8_t(crc<<1);}
  return crc;
}
inline uint32_t irFrame(uint8_t shooter,uint8_t seq){uint32_t top=(1u<<22)|(uint32_t(shooter)<<14)|(uint32_t(seq)<<6)|(1u<<2);return (top<<8)|irCrc(top);}
inline bool irValid(uint32_t v){return (v>>30)==1&&((v>>10)&15)==1&&((v>>8)&3)==0&&uint8_t(v)==irCrc(v>>8);}
