#pragma once
#ifndef GAME_PLAYER
#define GAME_PLAYER 0
#endif
#if GAME_PLAYER < 0 || GAME_PLAYER > 4
#error "GAME_PLAYER must be 1..4 for a player build, or 0 for configurable builds"
#endif

constexpr int GAME_PLAYER_NUMBER = GAME_PLAYER;
constexpr const char* GAME_DEVICE_ID = GAME_PLAYER == 1 ? "gun-001" : GAME_PLAYER == 2 ? "gun-002" :
    GAME_PLAYER == 3 ? "gun-003" : GAME_PLAYER == 4 ? "gun-004" : "";
constexpr bool samePlayerId(const char* left,const char* right) {
  return left&&right&&(*left==*right)&&(*left=='\0'||samePlayerId(left+1,right+1));
}
constexpr bool playerIdentityMatches(const char* id) {
  return GAME_PLAYER == 0 || samePlayerId(id,GAME_DEVICE_ID);
}
constexpr bool playerShooterMatches(unsigned shooter) {
  return GAME_PLAYER == 0 || shooter == GAME_PLAYER_NUMBER;
}
