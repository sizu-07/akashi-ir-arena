export function decodeGameFrame(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]{8}$/i.test(hex)) return null;
  const frame = Number.parseInt(hex.slice(2), 16);
  let crc = 0;
  for (const shift of [24, 16, 8]) {
    crc ^= (frame >>> shift) & 255;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 128) ? 7 : 0)) & 255;
  }
  const version = frame >>> 30, weapon = (frame >>> 10) & 15, flags = (frame >>> 8) & 3;
  if (version !== 1 || weapon !== 1 || flags > 1 || crc !== (frame & 255)) return null;
  return {shooterId: (frame >>> 22) & 255, seq: (frame >>> 14) & 255, weapon, flags};
}
