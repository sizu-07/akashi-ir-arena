// 電圧の測定回路は正確ではないため、参考値として表示するだけで警告・色分けはしない。
export function batteryStatus(player) {
  const measured = Number.isFinite(player.battery) && player.battery >= 0;
  return {
    text: measured ? `電池 ${player.battery.toFixed(2)} V（参考値）${player.connected ? '' : '（最終受信）'}` : '電池 未測定',
    warning: false,
    status: '',
  };
}
