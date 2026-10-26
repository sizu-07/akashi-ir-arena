export function batteryStatus(player) {
  const measured = Number.isFinite(player.battery) && player.battery >= 0;
  const threshold = Number.isFinite(player.batteryReplaceVoltage) && player.batteryReplaceVoltage > 0
    ? player.batteryReplaceVoltage : null;
  const replacement = measured && threshold === 7 && player.battery <= threshold;
  const warning = replacement || player.lowBattery === true;
  return {
    text: measured ? `電池 ${player.battery.toFixed(2)} V${player.connected ? '' : '（最終受信）'}` : '電池 未測定',
    warning,
    status: replacement ? '要交換（7.0 V以下）' : warning ? '電池保護停止' : '',
  };
}
