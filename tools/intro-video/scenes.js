// 投影画面（apps/web/display.css）と同じ赤・墨黒・生成り、Anton / Barlow Condensed / Noto Sans JP で描く。
import {sections, scenes} from './script.js';

export const W = 1920, H = 1080, FPS = 30;
const C = {red: '#ed2335', ink: '#141414', paper: '#f4f1e9', grey: '#8a8780', led: '#2b2b2b', green: '#6b9c31'};
// ゲームの表示色と同じ：プレイヤー1＝青、2＝オレンジ、3＝緑、4＝紫。
const TEAM = [
  {ja: '1', en: 'PLAYER 1', color: '#1684a7'},
  {ja: '2', en: 'PLAYER 2', color: '#c45e28'},
  {ja: '3', en: 'PLAYER 3', color: '#6b9c31'},
  {ja: '4', en: 'PLAYER 4', color: '#9a58a7'},
];
const SECTION_SEC = 1.7, VOICE_LEAD = 0.35, TAIL = 0.55;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const prog = (t, start, length) => clamp((t - start) / length);
const easeOut = x => 1 - Math.pow(1 - x, 3);
const easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const back = x => { const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const lerp = (a, b, x) => a + (b - a) * x;
const rad = deg => deg * Math.PI / 180;

export function buildTimeline(manifest) {
  const items = [];
  let at = 0, current = null;
  scenes.forEach((scene, index) => {
    if (scene.section !== current) {
      current = scene.section;
      items.push({kind: 'section', section: sections.find(s => s.id === current), start: at, duration: SECTION_SEC});
      at += SECTION_SEC;
    }
    const voiceSec = manifest.lines[index].seconds;
    const duration = Math.max(scene.min, VOICE_LEAD + voiceSec + TAIL);
    items.push({kind: 'scene', scene, index, start: at, duration, voiceAt: at + VOICE_LEAD, voiceSec, voiceUrl: manifest.lines[index].url});
    at += duration;
  });
  return {items, duration: at + 0.6, credit: manifest.credit};
}

// ---------- 共通の描画部品 ----------
function font(family, size, weight = 900) {
  const name = family === 'display' ? 'Anton' : family === 'cond' ? 'Barlow' : 'Noto';
  return `${family === 'jp' ? weight : family === 'cond' ? 700 : 400} ${size}px ${name}, 'Yu Gothic', sans-serif`;
}
function text(ctx, str, x, y, {family = 'jp', size = 40, weight = 900, color = C.ink, align = 'left', baseline = 'alphabetic', skew = 0, max = 0, spacing = 0, stroke = null, alpha = 1} = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = font(family, size, weight);
  if (spacing) ctx.letterSpacing = `${spacing}px`;
  let width = ctx.measureText(str).width;
  if (max && width > max) { size *= max / width; ctx.font = font(family, size, weight); width = max; }
  ctx.textAlign = align; ctx.textBaseline = baseline;
  ctx.translate(x, y);
  if (skew) ctx.transform(1, 0, Math.tan(rad(skew)), 1, 0, 0);
  if (stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = stroke.width; ctx.strokeStyle = stroke.color; ctx.strokeText(str, 0, 0); }
  ctx.fillStyle = color;
  ctx.fillText(str, 0, 0);
  ctx.restore();
  return width;
}
function para(ctx, x, y, w, h, skew, color) {
  const dx = Math.tan(rad(skew)) * h;
  ctx.beginPath(); ctx.moveTo(x - dx, y); ctx.lineTo(x + w - dx, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
}
function ring(ctx, x, y, r, color, width, spin = 0, ticks = 12) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(spin);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0.2, Math.PI - 0.2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.62, Math.PI + 0.2, Math.PI * 2 - 0.2); ctx.stroke();
  for (let i = 0; i < ticks; i++) {
    const a = i / ticks * Math.PI * 2, inner = i % 3 ? r * 1.06 : r * 0.82;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner); ctx.lineTo(Math.cos(a) * r * 1.16, Math.sin(a) * r * 1.16); ctx.stroke();
  }
  ctx.restore();
}
function halftone(ctx, x, y, w, h, color, step = 18) {
  ctx.save(); ctx.fillStyle = color;
  for (let gy = 0; gy < h; gy += step) for (let gx = 0; gx < w; gx += step) {
    const r = step * 0.42 * (gx / w) * (1 - gy / h * 0.5);
    if (r < 0.6) continue;
    ctx.beginPath(); ctx.arc(x + gx + (gy / step % 2) * step / 2, y + gy, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function barcode(ctx, x, y, h, color, seed = 7) {
  ctx.fillStyle = color; let px = x;
  for (let i = 0; i < 34; i++) { const w = ((i * seed * 13) % 5) + 1; if (i % 2 === 0) ctx.fillRect(px, y, w, h); px += w + 1; }
}
function ngMark(ctx, x, y, r, t) {
  if (t <= 0) return;
  const s = lerp(1.8, 1, back(prog(t, 0, 0.32)));
  ctx.save(); ctx.translate(x, y); ctx.rotate(rad(-8)); ctx.scale(s, s); ctx.globalAlpha *= prog(t, 0, 0.12);
  ctx.strokeStyle = C.red; ctx.lineWidth = r * 0.26; ctx.lineCap = 'square';
  ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); ctx.stroke();
  ctx.restore();
}
function okMark(ctx, x, y, r, t) {
  if (t <= 0) return;
  ctx.save(); ctx.translate(x, y); const s = lerp(1.6, 1, back(prog(t, 0, 0.32))); ctx.scale(s, s); ctx.globalAlpha *= prog(t, 0, 0.12);
  ctx.strokeStyle = C.ink; ctx.lineWidth = r * 0.24;
  ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * easeOut(prog(t, 0, 0.3))); ctx.stroke();
  ctx.restore();
}
function sticker(ctx, x, y, label, {color = C.red, fg = C.paper, size = 34, rotate = -4, t = 1} = {}) {
  if (t <= 0) return;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rad(rotate)); const s = lerp(1.5, 1, back(prog(t, 0, 0.3))); ctx.scale(s, s);
  ctx.font = font('jp', size); const w = ctx.measureText(label).width + size * 1.2, h = size * 1.7;
  para(ctx, -w / 2, -h / 2, w, h, -9, color);
  text(ctx, label, 0, 0, {size, color: fg, align: 'center', baseline: 'middle', skew: -9});
  ctx.restore();
}

// ---------- 銃（側面・上面） ----------
function gunSide(ctx, x, y, s, {leds = [], shake = 0, beam = 0, angle = 0} = {}) {
  ctx.save(); ctx.translate(x + shake, y); ctx.rotate(angle); ctx.scale(s, s);
  ctx.fillStyle = C.ink;
  ctx.beginPath(); ctx.moveTo(-190, 40); ctx.lineTo(-95, 40); ctx.lineTo(-130, 250); ctx.lineTo(-235, 250); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 16; ctx.strokeStyle = C.ink; ctx.beginPath(); ctx.moveTo(-90, 50); ctx.quadraticCurveTo(-60, 150, 20, 60); ctx.stroke();
  ctx.fillStyle = C.red; ctx.beginPath(); ctx.roundRect(-62, 50, 22, 56, 8); ctx.fill();
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.roundRect(-260, -80, 500, 135, 22); ctx.fill();
  ctx.beginPath(); ctx.roundRect(220, -52, 140, 76, 10); ctx.fill();
  ctx.fillStyle = '#3a3a3a'; ctx.fillRect(-240, 20, 460, 6);
  // 受信部（前は銃口の上、横は胴体の側面）
  ctx.fillStyle = '#5a5a5a'; ctx.beginPath(); ctx.arc(330, -52, 20, Math.PI, 0); ctx.fill();
  ctx.beginPath(); ctx.arc(60, -2, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C.paper; ctx.beginPath(); ctx.arc(365, -14, 14, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 8; i++) {
    const color = leds[i];
    ctx.fillStyle = color ?? C.led;
    if (color) { ctx.shadowColor = color; ctx.shadowBlur = 26; }
    ctx.beginPath(); ctx.roundRect(-235 + i * 56, -120, 42, 30, 6); ctx.fill();
    ctx.shadowBlur = 0;
    // 白く光ったLEDが生成りの背景に埋もれないよう、枠で囲う。
    ctx.lineWidth = 5; ctx.strokeStyle = C.ink; ctx.stroke();
  }
  if (beam > 0) {
    ctx.globalAlpha = beam; ctx.fillStyle = C.red;
    ctx.beginPath(); ctx.moveTo(375, -24); ctx.lineTo(1400, -60); ctx.lineTo(1400, 30); ctx.lineTo(375, -4); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
// 受信部は銃口の先（前）と、銃身の付け根の左右。
const RX_TOP = {front: [0, -330], left: [-58, -262], right: [58, -262]};
function gunTop(ctx, x, y, s, {angle = 0} = {}) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.scale(s, s);
  ctx.fillStyle = C.ink;
  ctx.beginPath(); ctx.roundRect(-36, -330, 72, 140, 12); ctx.fill();
  ctx.beginPath(); ctx.roundRect(-70, -210, 140, 380, 30); ctx.fill();
  ctx.fillStyle = '#3a3a3a'; ctx.fillRect(-8, -190, 16, 330);
  ctx.fillStyle = '#6a6a6a';
  for (const [rx, ry] of Object.values(RX_TOP)) { ctx.beginPath(); ctx.arc(rx, ry, 22, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
function hand(ctx, x, y, s, alpha = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.globalAlpha = alpha;
  ctx.fillStyle = '#e9c8a4'; ctx.strokeStyle = C.ink; ctx.lineWidth = 6;
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.roundRect(-100, -56 + i * 30, 120, 26, 13); ctx.fill(); ctx.stroke(); }
  ctx.beginPath(); ctx.ellipse(-130, 0, 70, 80, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

// ---------- 人物ピクトグラム ----------
const POSES = {
  walk: {head: [0, -178], neck: [0, -150], hip: [0, -66], arms: [[[-26, -110], [-36, -70]], [[28, -112], [44, -78]]], legs: [[[-18, -32], [-34, 0]], [[20, -34], [30, 0]]]},
  crouch: {head: [6, -118], neck: [4, -92], hip: [-14, -36], arms: [[[30, -70], [70, -78]], [[22, -60], [64, -66]]], legs: [[[30, -46], [24, 0]], [[-38, -16], [-30, 0]]]},
  run: {head: [36, -170], neck: [26, -144], hip: [0, -70], arms: [[[56, -118], [82, -140]], [[-6, -108], [-40, -96]]], legs: [[[44, -60], [50, -18]], [[-34, -38], [-74, -26]]]},
  slide: {head: [-80, -74], neck: [-56, -64], hip: [26, -30], arms: [[[-90, -40], [-120, -24]], [[-34, -30], [-10, -10]]], legs: [[[76, -18], [130, -8]], [[60, -44], [96, -14]]]},
  jump: {head: [0, -222], neck: [0, -194], hip: [0, -112], arms: [[[-32, -232], [-48, -262]], [[32, -232], [48, -262]]], legs: [[[-28, -78], [-44, -44]], [[26, -74], [40, -40]]]},
};
function figure(ctx, x, y, s, pose, color = C.ink) {
  const p = POSES[pose];
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 17; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const line = (...pts) => { ctx.beginPath(); ctx.moveTo(...pts[0]); for (const pt of pts.slice(1)) ctx.lineTo(...pt); ctx.stroke(); };
  line(p.neck, p.hip);
  for (const [a, b] of p.arms) line(p.neck, a, b);
  for (const [a, b] of p.legs) line(p.hip, a, b);
  ctx.beginPath(); ctx.arc(...p.head, 24, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ---------- フィールド（ホワイトボードの配置図より） ----------
const FIELD_RATIO = 1.12;
// スタート地点は左上から時計回りにプレイヤー1〜4。
const STARTS = [[0.07, 0.08], [0.82, 0.1], [0.88, 0.92], [0.1, 0.92]];
const BUTTONS = [[0.35, 0.36, 1], [0.6, 0.35, 2], [0.36, 0.62, 3], [0.62, 0.6, 0]];
function field(ctx, x, y, w, {players = [], t = 0, highlightStarts = 0, label = true} = {}) {
  const h = w * FIELD_RATIO, X = v => x + v * w, Y = v => y + v * h;
  ctx.save();
  ctx.fillStyle = '#fbf9f4'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#14141412'; ctx.lineWidth = 1;
  for (let g = 1; g < 12; g++) { ctx.beginPath(); ctx.moveTo(X(g / 12), y); ctx.lineTo(X(g / 12), y + h); ctx.moveTo(x, Y(g / 12)); ctx.lineTo(x + w, Y(g / 12)); ctx.stroke(); }
  // 遮光カーテン（左壁の外側）
  ctx.strokeStyle = C.grey; ctx.lineWidth = 5; ctx.beginPath();
  for (let i = 0; i <= 40; i++) { const yy = Y(0.04 + i / 40 * 0.92); const xx = x - 22 + Math.sin(i * 1.3) * 7; i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
  ctx.stroke();
  // 運営席・説明
  ctx.fillStyle = '#e4ded1'; ctx.fillRect(X(0.8), Y(0.36), w * 0.13, h * 0.28);
  ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.strokeRect(X(0.8), Y(0.36), w * 0.13, h * 0.28);
  text(ctx, '運', X(0.865), Y(0.47), {size: w * 0.045, align: 'center', baseline: 'middle'});
  text(ctx, '営', X(0.865), Y(0.53), {size: w * 0.045, align: 'center', baseline: 'middle'});
  // 遮蔽パネル（斜線のハッチ）
  const panel = (cx, cy, len, angle, thick = 0.022) => {
    ctx.save(); ctx.translate(X(cx), Y(cy)); ctx.rotate(rad(angle));
    const L = len * w, T = thick * w;
    ctx.fillStyle = C.paper; ctx.fillRect(-L / 2, -T / 2, L, T);
    ctx.save(); ctx.beginPath(); ctx.rect(-L / 2, -T / 2, L, T); ctx.clip();
    ctx.strokeStyle = C.red; ctx.lineWidth = 3;
    for (let i = -L; i < L; i += 12) { ctx.beginPath(); ctx.moveTo(i, T); ctx.lineTo(i + T * 2, -T); ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.strokeRect(-L / 2, -T / 2, L, T);
    ctx.restore();
  };
  panel(0.465, 0.485, 0.17, 90, 0.11);               // 中央の大きな壁（ホワイトボード大）
  panel(0.45, 0.22, 0.1, 90); panel(0.23, 0.08, 0.08, 90); panel(0.68, 0.07, 0.08, 90);
  panel(0.3, 0.3, 0.13, -40); panel(0.64, 0.29, 0.13, 40); panel(0.3, 0.68, 0.13, 40); panel(0.64, 0.67, 0.13, -40);
  panel(0.17, 0.2, 0.12, -40); panel(0.73, 0.21, 0.12, 40); panel(0.18, 0.8, 0.12, 40); panel(0.75, 0.8, 0.12, -40);
  panel(0.1, 0.48, 0.16, 70, 0.05);
  // 三角の遮蔽（下中央）
  ctx.fillStyle = C.paper; ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(X(0.5), Y(0.8)); ctx.lineTo(X(0.55), Y(0.97)); ctx.lineTo(X(0.45), Y(0.97)); ctx.closePath(); ctx.fill(); ctx.stroke();
  // 置物のボタン
  for (const [bx, by, team] of BUTTONS) {
    ctx.fillStyle = TEAM[team].color; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(X(bx), Y(by), w * 0.018, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.stroke();
  }
  // 壁・柱・扉
  ctx.strokeStyle = C.ink; ctx.lineWidth = 8; ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = C.ink; for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) ctx.fillRect(X(cx) - 14, Y(cy) - 14, 28, 28);
  ctx.lineWidth = 3; ctx.setLineDash([8, 7]);
  for (const dy of [0.06, 0.9]) { ctx.beginPath(); ctx.moveTo(x + w, Y(dy)); ctx.arc(x + w, Y(dy), h * 0.07, -0.0, Math.PI / 2); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.fillStyle = '#fbf9f4'; for (const dy of [0.06, 0.9]) ctx.fillRect(x + w - 5, Y(dy), 10, h * 0.07);
  // スタート地点
  STARTS.forEach(([sx, sy], i) => {
    const pulse = highlightStarts ? 1 + 0.18 * Math.sin(t * 6 + i) * highlightStarts : 1;
    ctx.fillStyle = TEAM[i].color + '30'; ctx.beginPath(); ctx.arc(X(sx), Y(sy), w * 0.055 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = TEAM[i].color; ctx.lineWidth = 4; ctx.setLineDash([10, 6]); ctx.stroke(); ctx.setLineDash([]);
  });
  if (label) {
    text(ctx, '前', x + w / 2, y - 22, {size: 30, align: 'center'});
    text(ctx, 'FRONT', x + w / 2 + 30, y - 24, {family: 'cond', size: 22, color: C.grey});
    text(ctx, 'ART', x + w * 0.2, y - 22, {family: 'cond', size: 20, color: C.grey, spacing: 4});
    text(ctx, 'ART', x + w * 0.5, y + h + 34, {family: 'cond', size: 20, color: C.grey, spacing: 4, align: 'center'});
    text(ctx, '遮光カーテン', x - 40, y + h / 2, {size: 20, color: C.grey, align: 'right'});
    text(ctx, '説明', x + w + 18, y + h * 0.24, {size: 22, color: C.grey});
  }
  for (const pl of players) player(ctx, X(pl.x), Y(pl.y), w * 0.04, pl);
  ctx.restore();
  return {X, Y, h};
}
function player(ctx, x, y, r, {team, dir = 0, out = false, alpha = 1, scale = 1}) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.globalAlpha = alpha;
  ctx.rotate(dir);
  ctx.fillStyle = out ? C.grey : TEAM[team].color;
  ctx.beginPath(); ctx.moveTo(0, -r * 1.9); ctx.lineTo(r * 0.55, -r * 0.8); ctx.lineTo(-r * 0.55, -r * 0.8); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = C.ink; ctx.stroke();
  ctx.rotate(-dir);
  text(ctx, TEAM[team].ja, 0, 3, {family: 'display', size: r * 1.25, color: '#fff', align: 'center', baseline: 'middle'});
  ctx.restore();
}

// ---------- 画面の枠 ----------
function background(ctx, t) {
  ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#14141409'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 58) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 58) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  halftone(ctx, 1500, 150, 420, 300, '#14141412');
  ctx.strokeStyle = '#ed233540'; ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) { const off = ((t * 120 + i * 260) % 900) - 300; ctx.beginPath(); ctx.moveTo(1300 + off, 880); ctx.lineTo(1700 + off, 150); ctx.stroke(); }
}
function masthead(ctx, item) {
  ctx.fillStyle = C.ink; ctx.fillRect(70, 34, W - 140, 4); ctx.fillRect(70, 128, W - 140, 1.5);
  text(ctx, '↗', 76, 118, {family: 'display', size: 92, color: C.red});
  const w = text(ctx, '明石', 160, 106, {size: 56, skew: -9, spacing: -6});
  text(ctx, '光線', 160 + w, 106, {size: 56, skew: -9, color: C.red, spacing: -6});
  ctx.fillStyle = C.ink; ctx.fillRect(400, 58, 1.5, 54);
  text(ctx, 'AKASHI', 418, 82, {family: 'cond', size: 22, spacing: 2});
  text(ctx, 'IR ARENA', 418, 106, {family: 'cond', size: 22, spacing: 2});
  text(ctx, 'ルール説明', 1190, 82, {size: 22, spacing: 4});
  text(ctx, 'RULE BRIEFING / 4 PLAYERS', 1190, 106, {family: 'cond', size: 18, spacing: 3});
  const section = item.kind === 'section' ? item.section : sections.find(s => s.id === item.scene.section);
  para(ctx, 1520, 56, 330, 58, -9, C.ink);
  ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(1545, 85, 6, 0, Math.PI * 2); ctx.fill();
  text(ctx, `${section.no}  ${section.en}`, 1562, 96, {family: 'display', size: 32, color: C.paper, spacing: 1, max: 260});
  text(ctx, '↗', 1832, 98, {family: 'display', size: 34, color: C.paper, align: 'right'});
}
function telop(ctx, item, t) {
  if (item.kind !== 'scene') return;
  const a = easeOut(prog(t, 0.05, 0.3)), section = sections.find(s => s.id === item.scene.section);
  const y = 900, h = 112, x = lerp(-200, 110, a);
  ctx.save(); ctx.globalAlpha = a;
  para(ctx, x + 22, y + 10, W - 250, h, -9, C.red);
  para(ctx, x, y, W - 250, h, -9, C.ink);
  text(ctx, section.no, x + 30, y + 72, {family: 'display', size: 50, color: C.red});
  ctx.fillStyle = '#f4f1e960'; ctx.fillRect(x + 108, y + 24, 2, h - 48);
  text(ctx, item.scene.caption, x + 138, y + 76, {size: 52, color: C.paper, max: W - 520, skew: -4});
  ctx.restore();
}
function progressBar(ctx, tl, now) {
  const x = 110, y = 1048, w = W - 220;
  ctx.fillStyle = '#14141420'; ctx.fillRect(x, y, w, 6);
  ctx.fillStyle = C.red; ctx.fillRect(x, y, w * clamp(now / tl.duration), 6);
  for (const item of tl.items) if (item.kind === 'section') { ctx.fillStyle = C.ink; ctx.fillRect(x + w * item.start / tl.duration, y - 6, 3, 18); }
  if (tl.credit) text(ctx, tl.credit, W - 110, y - 12, {family: 'jp', size: 18, weight: 700, color: C.grey, align: 'right'});
}
// ---------- 章の扉 ----------
function sectionCard(ctx, item, t) {
  const d = item.duration, inP = easeInOut(prog(t, 0, 0.45)), outP = easeInOut(prog(t, d - 0.4, 0.4));
  const left = lerp(W + 400, -300, inP) + lerp(0, -W - 700, outP);
  ctx.save();
  ctx.beginPath(); ctx.moveTo(left, 0); ctx.lineTo(left + W + 600, 0); ctx.lineTo(left + W + 300, H); ctx.lineTo(left - 300, H); ctx.closePath();
  ctx.fillStyle = C.red; ctx.fill(); ctx.clip();
  halftone(ctx, left + W - 300, 0, 800, H, '#14141422', 22);
  const s = item.section, cx = left + 300;
  text(ctx, s.no, cx + 60, 640, {family: 'display', size: 520, color: '#14141430', skew: -9});
  text(ctx, s.en, cx + 160, 520, {family: 'display', size: 170, color: C.paper, skew: -9, spacing: 2});
  para(ctx, cx + 170, 580, 520, 92, -9, C.ink);
  text(ctx, s.ja, cx + 200, 648, {size: 58, color: C.paper, skew: -9});
  ring(ctx, cx + 1350, 420, 150, C.paper, 4, t * 1.5);
  barcode(ctx, cx + 200, 760, 60, C.ink, 3);
  ctx.restore();
}

// ---------- 各シーン ----------
const V = {};
V.title = (ctx, t) => {
  const a = easeOut(prog(t, 0, 0.6));
  ctx.save(); ctx.beginPath(); ctx.moveTo(lerp(-900, 0, a), 150); ctx.lineTo(lerp(-900, 0, a) + 1080, 150); ctx.lineTo(lerp(-900, 0, a) + 860, 880); ctx.lineTo(lerp(-900, 0, a), 880); ctx.closePath(); ctx.fillStyle = C.red; ctx.fill(); ctx.restore();
  ring(ctx, 1450, 480, 230, C.ink, 5, t * 0.6);
  ring(ctx, 1450, 480, 120, C.red, 4, -t * 1.2, 8);
  const pop = back(prog(t, 0.45, 0.5));
  ctx.save(); ctx.translate(140, 560); ctx.scale(pop, pop);
  text(ctx, '明石', 0, 0, {size: 250, skew: -9, color: C.paper, spacing: -30});
  text(ctx, '光線', 470, 0, {size: 250, skew: -9, color: C.ink, spacing: -30});
  ctx.restore();
  text(ctx, 'AKASHI IR ARENA', 150, 700, {family: 'display', size: 96, color: C.ink, skew: -9, alpha: prog(t, 0.8, 0.4), spacing: 4});
  sticker(ctx, 1450, 480, 'RULE BRIEFING', {color: C.ink, size: 40, t: prog(t, 1.2, 1)});
  barcode(ctx, 150, 740, 70, C.ink, 5);
  text(ctx, 'NO CONTACT. ALL IMPACT.', 520, 800, {family: 'cond', size: 34, spacing: 6, alpha: prog(t, 1.4, 0.5)});
};
V.versus = (ctx, t) => {
  const bw = 270, gap = 150, x0 = (W - (bw * 4 + gap * 3)) / 2;
  TEAM.forEach((team, i) => {
    const p = back(prog(t, 0.3 + i * 0.4, 0.35)); if (p <= 0) return;
    const x = x0 + i * (bw + gap);
    ctx.save(); ctx.translate(x + bw / 2, 470); ctx.scale(p, p);
    para(ctx, -bw / 2, -200, bw, 330, -9, team.color);
    text(ctx, '1', 0, 90, {family: 'display', size: 300, color: C.paper, align: 'center', skew: -9});
    text(ctx, `P${i + 1}`, 0, -150, {family: 'display', size: 40, color: C.paper, align: 'center', skew: -9, spacing: 3});
    ctx.restore();
    if (i < 3) text(ctx, 'VS', x + bw + gap / 2, 500, {family: 'display', size: 90, align: 'center', skew: -9, alpha: prog(t, 0.5 + i * 0.4, 0.2), color: C.ink});
  });
  const k = prog(t, 2.1, 0.4);
  para(ctx, lerp(W, 560, easeOut(k)), 700, 820, 110, -9, C.ink);
  text(ctx, 'KILL COUNT BATTLE', lerp(W, 560, easeOut(k)) + 40, 778, {family: 'display', size: 70, color: C.paper, skew: -9, spacing: 3});
  text(ctx, '全員が敵！', lerp(W, 560, easeOut(k)) + 690, 690, {size: 54, color: C.red, skew: -9, alpha: k, align: 'center'});
};
V.rounds = (ctx, t) => {
  for (let i = 0; i < 3; i++) {
    const p = back(prog(t, 0.4 + i * 0.4, 0.4)); if (p <= 0) continue;
    const x = 250 + i * 480;
    ctx.save(); ctx.translate(x + 190, 420); ctx.scale(p, p);
    ctx.fillStyle = C.ink; ctx.fillRect(-190, -210, 380, 330);
    ctx.fillStyle = C.red; ctx.fillRect(-190, -210, 380, 70);
    text(ctx, `ROUND ${i + 1}`, 0, -155, {family: 'display', size: 50, color: C.paper, align: 'center', spacing: 3});
    text(ctx, '1:30', 0, 60, {family: 'display', size: 170, color: C.paper, align: 'center', skew: -9});
    ctx.restore();
    if (i < 2) text(ctx, '+', x + 430, 450, {family: 'display', size: 90, align: 'center', alpha: p});
  }
  const k = easeOut(prog(t, 2.5, 0.5));
  ctx.save(); ctx.globalAlpha = k;
  para(ctx, 420, 650, 1080, 150, -9, C.red);
  text(ctx, 'TOTAL KILLS', 470, 750, {family: 'display', size: 84, color: C.paper, skew: -9, spacing: 3});
  text(ctx, '＝', 1010, 748, {size: 80, color: C.ink, skew: -9});
  text(ctx, 'WIN!', 1120, 760, {family: 'display', size: 120, color: C.ink, skew: -9});
  ctx.restore();
};
V.oneShot = (ctx, t) => {
  const hitP = prog(t, 0.45, 0.2);
  ring(ctx, 520, 470, 200, hitP > 0 ? C.red : C.ink, 6, t * 0.5);
  if (t > 0.25 && t < 0.6) { ctx.fillStyle = C.red; ctx.globalAlpha = 0.8; ctx.fillRect(0, 462, 520, 16); ctx.globalAlpha = 1; }
  if (hitP > 0) {
    ctx.save(); ctx.translate(520, 470); ctx.rotate(rad(-8)); const s = back(hitP);
    ctx.scale(s, s); ctx.fillStyle = C.red; ctx.fillRect(-330, -80, 660, 160);
    text(ctx, 'OUT', 0, 58, {family: 'display', size: 170, color: C.paper, align: 'center', spacing: 10});
    ctx.restore();
    text(ctx, 'ONE SHOT', 520, 760, {family: 'display', size: 80, align: 'center', skew: -9, spacing: 3});
    text(ctx, '1発で即アウト', 520, 830, {size: 40, align: 'center', color: C.red});
  }
  const cd = prog(t, 0.9, 3.3), cx = 1360, cy = 470, r = 200;
  if (t > 0.8) {
    ctx.lineWidth = 34; ctx.strokeStyle = '#14141420'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    const done = cd >= 1;
    ctx.strokeStyle = done ? C.green : C.red;
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (done ? 1 : 1 - cd)); ctx.stroke();
    if (done) {
      sticker(ctx, cx, cy, 'REVIVE!', {color: C.green, size: 64, t: prog(t, 4.2, 1)});
    } else {
      text(ctx, String(Math.ceil(7 * (1 - cd))), cx, cy + 70, {family: 'display', size: 210, align: 'center', color: C.ink});
    }
    text(ctx, '約7秒で復活', cx, 760, {size: 52, align: 'center', skew: -9});
  }
};
V.hype = (ctx, t) => {
  ctx.fillStyle = C.red; ctx.fillRect(0, 140, W, 745);
  ctx.strokeStyle = '#f4f1e955'; ctx.lineWidth = 4;
  for (let i = 0; i < 18; i++) { const y = 170 + ((i * 97 + t * 900) % 690); ctx.beginPath(); ctx.moveTo(((i * 331) % 700), y); ctx.lineTo(((i * 331) % 700) + 300 + (i % 4) * 80, y); ctx.stroke(); }
  const p = back(prog(t, 0.05, 0.35)), shake = Math.sin(t * 60) * 5 * (1 - prog(t, 0.1, 1.2));
  ctx.save(); ctx.translate(W / 2 + shake, 520); ctx.scale(p, p);
  text(ctx, 'できるだけ多く', 0, -90, {size: 130, color: C.ink, align: 'center', skew: -9});
  text(ctx, 'たおせ！！', 0, 150, {size: 250, color: C.paper, align: 'center', skew: -9, stroke: {width: 26, color: C.ink}});
  ctx.restore();
  text(ctx, 'TAKE THEM ALL DOWN.', W / 2, 840, {family: 'display', size: 54, align: 'center', color: C.ink, spacing: 8, alpha: prog(t, 0.6, 0.4)});
};

V.field = (ctx, t) => {
  const appear = (i) => back(prog(t, 1.4 + i * 0.3, 0.35));
  const players = STARTS.map(([x, y], i) => ({x, y, team: i, dir: Math.atan2(0.5 - y, 0.5 - x) + Math.PI / 2, scale: appear(i), alpha: appear(i) > 0 ? 1 : 0}));
  field(ctx, 330, 190, 560, {players, t, highlightStarts: 1});
  text(ctx, 'STAND BY', 1080, 340, {family: 'display', size: 120, skew: -9, spacing: 4});
  text(ctx, '自分の色のスタート地点へ', 1085, 410, {size: 44, color: C.red});
  TEAM.forEach((team, i) => {
    const a = prog(t, 1.4 + i * 0.3, 0.3);
    ctx.save(); ctx.globalAlpha = a;
    para(ctx, 1090, 470 + i * 90, 90, 70, -9, team.color);
    text(ctx, team.ja, 1135, 520 + i * 90, {family: 'display', size: 50, color: '#fff', align: 'center'});
    text(ctx, `${team.en} START`, 1210, 524 + i * 90, {family: 'display', size: 48, skew: -9, spacing: 2});
    ctx.restore();
  });
};
V.toStart = (ctx, t) => {
  const from = [[0.42, 0.42], [0.58, 0.36], [0.62, 0.6], [0.36, 0.64]], walk = easeInOut(prog(t, 1, 9.5));
  const players = STARTS.map(([x, y], i) => {
    const [fx, fy] = from[i];
    return {x: lerp(fx, x, walk), y: lerp(fy, y, walk), team: i, dir: walk < 1 ? Math.atan2(y - fy, x - fx) + Math.PI / 2 : Math.atan2(0.5 - y, 0.5 - x) + Math.PI / 2};
  });
  const {X, Y} = field(ctx, 330, 190, 560, {players, t, highlightStarts: 1});
  ctx.strokeStyle = '#14141455'; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
  from.forEach(([fx, fy], i) => { ctx.beginPath(); ctx.moveTo(X(fx), Y(fy)); ctx.lineTo(X(STARTS[i][0]), Y(STARTS[i][1])); ctx.stroke(); });
  ctx.setLineDash([]);
  text(ctx, 'GO TO START', 1080, 340, {family: 'display', size: 110, skew: -9, spacing: 4});
  text(ctx, '自分のスタート地点へ', 1085, 410, {size: 44, color: C.red});
  TEAM.forEach((team, i) => {
    const arrived = walk >= 1;
    para(ctx, 1090, 470 + i * 90, 90, 70, -9, team.color);
    text(ctx, team.ja, 1135, 520 + i * 90, {family: 'display', size: 50, color: '#fff', align: 'center'});
    text(ctx, `${team.en} START`, 1210, 524 + i * 90, {family: 'display', size: 48, skew: -9, spacing: 2});
    if (arrived) okMark(ctx, 1790, 505 + i * 90, 26, t - 10.5 - i * 0.1);
  });
  sticker(ctx, 1730, 400, 'あるいて移動', {color: C.ink, size: 34, rotate: 4, t: prog(t, 2, 1)});
  if (t > 11) sticker(ctx, 1600, 862, '運営の合図を待ってね', {size: 40, t: prog(t, 11, 1)});
};
V.moves = (ctx, t) => {
  const cards = [['walk', 'あるく', true, 0.3], ['crouch', 'しゃがむ', true, 0.9], ['run', 'はしる', false, 2.6], ['slide', 'スライディング', false, 3.2]];
  cards.forEach(([pose, label, ok, at], i) => {
    const p = easeOut(prog(t, at - 0.25, 0.3)); if (p <= 0) return;
    const x = 160 + i * 410, y = 200;
    ctx.save(); ctx.globalAlpha = p; ctx.translate(0, (1 - p) * 40);
    ctx.fillStyle = ok ? '#fbf9f4' : '#f0e2df'; ctx.fillRect(x, y, 370, 560);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.strokeRect(x, y, 370, 560);
    const bob = pose === 'walk' ? Math.sin(t * 8) * 6 : 0;
    figure(ctx, x + 185, y + 420 + bob, 1.25, pose, ok ? C.ink : '#555');
    ctx.fillStyle = C.ink; ctx.fillRect(x + 30, y + 422, 310, 4);
    para(ctx, x + 20, y + 460, 330, 80, -9, ok ? C.ink : C.red);
    text(ctx, label, x + 185, y + 516, {size: 46, color: C.paper, align: 'center', max: 300});
    ctx.restore();
    if (ok) okMark(ctx, x + 300, y + 80, 52, t - at); else ngMark(ctx, x + 185, y + 230, 120, t - at);
  });
};
V.swing = (ctx, t) => {
  const swingA = t < 1.4 ? Math.sin(t * 9) * 0.5 : Math.sin(1.4 * 9) * 0.5 * (1 - prog(t, 1.4, 0.3));
  ctx.strokeStyle = '#14141440'; ctx.lineWidth = 6;
  for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(820, 700, 420 + i * 40, -Math.PI * 0.85, -Math.PI * 0.2); ctx.stroke(); }
  gunSide(ctx, 820, 520, 0.95, {angle: swingA});
  ngMark(ctx, 820, 500, 230, t - 1.4);
  text(ctx, 'NO SWING!', 1330, 420, {family: 'display', size: 110, skew: -9, color: C.red, alpha: prog(t, 1.5, 0.3)});
  text(ctx, 'こわれやすいので', 1340, 500, {size: 46, alpha: prog(t, 1.7, 0.3)});
  text(ctx, 'ふりまわさない', 1340, 565, {size: 46, alpha: prog(t, 1.7, 0.3)});
};
V.receiver = (ctx, t) => {
  const gx = 760, gy = 700, s = 1.0;
  gunTop(ctx, gx, gy, s);
  const spots = [['front', '前', 'FRONT', 0.6, [0, -110]], ['left', '左', 'LEFT', 1.1, [-230, 0]], ['right', '右', 'RIGHT', 1.6, [230, 0]]];
  for (const [key, ja, en, at, [lx, ly]] of spots) {
    const p = prog(t, at - 0.15, 0.35); if (p <= 0) continue;
    const [rx, ry] = RX_TOP[key], x = gx + rx * s, y = gy + ry * s;
    ring(ctx, x, y, lerp(140, 40, easeOut(p)), C.red, 5, t * 2, 8);
    ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.fill();
    text(ctx, ja, x + lx, y + ly + 20, {size: 72, align: 'center', color: C.red, alpha: p});
    text(ctx, en, x + lx, y + ly + 60, {family: 'cond', size: 28, align: 'center', alpha: p, spacing: 3});
  }
  text(ctx, 'TARGET', 1180, 360, {family: 'display', size: 120, skew: -9, spacing: 4, alpha: prog(t, 0.2, 0.3)});
  text(ctx, '受信部は3か所', 1190, 440, {size: 46, alpha: prog(t, 0.4, 0.3)});
  sticker(ctx, 1420, 620, 'ここをねらえ！', {size: 64, t: prog(t, 2.4, 1)});
};
V.cover = (ctx, t) => {
  const gx = 760, gy = 700, s = 1.0;
  gunTop(ctx, gx, gy, s);
  const [rx, ry] = RX_TOP.left, x = gx + rx * s, y = gy + ry * s;
  ring(ctx, x, y, 40, C.red, 5, t * 2, 8);
  const p = easeInOut(prog(t, 0.3, 0.9));
  hand(ctx, lerp(x - 420, x + 30, p), y, 1.1, 0.97);
  ngMark(ctx, x, y, 170, t - 1.5);
  text(ctx, 'DON\'T COVER', 1140, 400, {family: 'display', size: 100, skew: -9, color: C.red, alpha: prog(t, 1.6, 0.3), spacing: 3});
  text(ctx, '受信部を手でかくさない', 1150, 480, {size: 48, alpha: prog(t, 1.7, 0.3)});
};
function ledsFor(state, t) {
  const off = Array(8).fill(null);
  if (state === 'ready') { off[0] = '#ffffff'; return off; }
  if (state === 'flash') return Array(8).fill('#ffffff');
  if (state === 'dead') return Math.floor(t * 4) % 2 ? Array(8).fill(C.red) : off;
  return off;
}
V.ready = (ctx, t) => {
  const shots = [1.6, 4.6];
  const last = shots.filter(s => t >= s).at(-1);
  const since = last === undefined ? 99 : t - last;
  const state = since < 0.31 ? 'flash' : since < 1 ? 'cool' : 'ready';
  gunSide(ctx, 640, 560, 1.15, {leds: ledsFor(state, t), beam: since < 0.25 ? 1 - since / 0.25 : 0});
  const lx = 640 - 235 * 1.15 + 21 * 1.15, ly = 560 - 120 * 1.15;
  if (state === 'ready') {
    ring(ctx, lx, ly, 70 + Math.sin(t * 8) * 6, C.red, 4, t);
    ctx.strokeStyle = C.red; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(lx, ly - 80); ctx.lineTo(lx + 60, 230); ctx.lineTo(lx + 180, 230); ctx.stroke();
    text(ctx, 'READY!', lx + 190, 245, {family: 'display', size: 60, color: C.red, skew: -9});
    text(ctx, '1つ目が白 ＝ 撃てる', lx + 400, 245, {size: 36});
  } else {
    text(ctx, state === 'flash' ? 'SHOT!' : 'WAIT…', lx + 190, 245, {family: 'display', size: 60, color: C.ink, skew: -9});
  }
  const cool = since < 1 ? since : 1;
  const bx = 1220, by = 640;
  text(ctx, 'COOL DOWN', bx, by - 30, {family: 'display', size: 44, spacing: 3});
  ctx.fillStyle = '#14141420'; ctx.fillRect(bx, by, 520, 40);
  ctx.fillStyle = cool < 1 ? C.ink : C.red; ctx.fillRect(bx, by, 520 * (last === undefined ? 1 : cool), 40);
  text(ctx, '1.0s', bx + 540, by + 36, {family: 'display', size: 40});
  text(ctx, '撃ったら約1秒待ってから次の1発', bx, by + 100, {size: 34});
};
V.hit = (ctx, t) => {
  const shake = Math.sin(t * 70) * 14 * (t > 0.3 ? 1 : 0) * (0.6 + 0.4 * Math.sin(t * 5));
  gunSide(ctx, 760, 560, 1.15, {leds: t > 0.3 ? ledsFor('dead', t) : ledsFor('ready', t), shake});
  if (t > 0.3) {
    ctx.strokeStyle = C.ink; ctx.lineWidth = 6;
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
      const x = 760 + side * (520 + i * 36);
      ctx.beginPath(); ctx.moveTo(x, 470); for (let k = 1; k <= 6; k++) ctx.lineTo(x + (k % 2 ? 14 : -14) * side, 470 + k * 26); ctx.stroke();
    }
    text(ctx, 'ブルブル', 1340, 360 + Math.sin(t * 40) * 6, {size: 80, color: C.red, skew: -9, stroke: {width: 10, color: C.paper}});
    ctx.save(); ctx.translate(760, 300); ctx.rotate(rad(-5)); const s = back(prog(t, 0.3, 0.3)); ctx.scale(s, s);
    para(ctx, -360, -60, 720, 110, -9, C.red);
    text(ctx, 'HIT!  OUT', 0, 30, {family: 'display', size: 96, color: C.paper, align: 'center', spacing: 6});
    ctx.restore();
    text(ctx, 'ライトが全部赤＋振動', 1360, 640, {size: 44, alpha: prog(t, 0.8, 0.3)});
  }
};
V.respawn = (ctx, t) => {
  const walk = easeInOut(prog(t, 0.8, 5.2)), path = [[0.42, 0.33], [0.3, 0.2], [0.07, 0.08]];
  const seg = walk < 0.5 ? 0 : 1, local = walk < 0.5 ? walk * 2 : (walk - 0.5) * 2;
  const [ax, ay] = path[seg], [bx, by] = path[seg + 1];
  const revived = t >= 7.5;
  const me = {x: lerp(ax, bx, local), y: lerp(ay, by, local), team: 0, dir: Math.atan2(by - ay, bx - ax) + Math.PI / 2, out: !revived};
  const others = [{x: 0.7, y: 0.25, team: 1, dir: -2.4}, {x: 0.72, y: 0.75, team: 2, dir: -0.8}, {x: 0.28, y: 0.78, team: 3, dir: 0.6}];
  const {X, Y} = field(ctx, 200, 210, 520, {players: [...others, me], t, label: false});
  ctx.strokeStyle = C.red; ctx.lineWidth = 4; ctx.setLineDash([12, 10]);
  ctx.beginPath(); ctx.moveTo(X(path[0][0]), Y(path[0][1])); for (const [px, py] of path.slice(1)) ctx.lineTo(X(px), Y(py)); ctx.stroke(); ctx.setLineDash([]);
  if (t < 0.6) { ctx.fillStyle = C.red; ctx.globalAlpha = 1 - t / 0.6; ctx.beginPath(); ctx.arc(X(0.42), Y(0.33), 80 * (t / 0.6) + 20, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
  sticker(ctx, X(0.07) + 110, Y(0.08) - 10, 'START', {color: C.ink, size: 30, rotate: -6});
  // 銃のライトで残り秒数を表示する（7個の赤＝7秒）
  const left = clamp(7.5 - t, 0, 7), lit = Math.ceil(left);
  const leds = Array(8).fill(null);
  if (revived) leds.fill(C.green);
  else if (Math.floor(t * 4) % 2) { leds[0] = C.red; for (let i = 1; i <= lit; i++) leds[i] = C.red; }
  gunSide(ctx, 1260, 450, 0.8, {leds});
  if (revived) sticker(ctx, 1300, 760, 'REVIVE!', {color: C.green, size: 70, t: prog(t, 7.5, 1)});
  else {
    text(ctx, String(lit), 1700, 790, {family: 'display', size: 220, align: 'center', color: C.red});
    text(ctx, 'ライトのカウント', 1700, 560, {size: 36, align: 'center'});
  }
  text(ctx, 'GO BACK!', 820, 290, {family: 'display', size: 84, skew: -9, color: C.red, alpha: revived ? 0 : prog(t, 0.6, 0.3)});
};
// 待機画面で並んだ順（左から1〜4番目）と、それぞれの色を対応させて見せる。
V.colors = (ctx, t) => {
  text(ctx, 'YOUR COLOR', 160, 230, {family: 'display', size: 90, skew: -9, spacing: 4, alpha: prog(t, 0.2, 0.3)});
  text(ctx, 'スクリーンの前に並んだ順（左から）', 170, 290, {size: 40, color: C.red, alpha: prog(t, 0.4, 0.3)});
  const names = ['青', 'オレンジ', '緑', '紫'];
  TEAM.forEach((team, i) => {
    // ナレーションで色を読み上げるタイミングに合わせて出す。
    const p = back(prog(t, [6.0, 7.15, 8.75, 10.15][i], 0.4)); if (p <= 0) return;
    const x = 330 + i * 420;
    ctx.save(); ctx.translate(x, 0);
    text(ctx, `左から${i + 1}番目`, 0, 390, {size: 38, align: 'center', alpha: Math.min(1, p)});
    ctx.save(); ctx.translate(0, 470); ctx.scale(p, p);
    para(ctx, -150, -60, 300, 110, -9, team.color);
    text(ctx, names[i], 0, 30, {size: names[i].length > 2 ? 62 : 86, color: '#fff', align: 'center', skew: -9});
    ctx.restore();
    figure(ctx, 0, 820, 1.15, 'walk', team.color);
    ctx.fillStyle = C.ink; ctx.fillRect(-150, 824, 300, 5);
    text(ctx, team.en, 0, 870, {family: 'display', size: 34, align: 'center', spacing: 2, alpha: Math.min(1, p)});
    ctx.restore();
  });
};
V.report = (ctx, t) => {
  const rows = [[0, 6, 2, 46], [1, 5, 3, 41], [2, 3, 4, 30], [3, 2, 7, 22]];
  para(ctx, 260, 170, 1400, 100, -9, C.ink);
  text(ctx, 'ROUND 1 / 3', 300, 245, {family: 'display', size: 64, color: C.paper, skew: -9, spacing: 3});
  text(ctx, '中間報告', 740, 242, {size: 58, color: C.red, skew: -9});
  text(ctx, 'INTERIM RESULT', 1620, 240, {family: 'cond', size: 30, color: C.paper, align: 'right', spacing: 4});
  text(ctx, 'KILLS', 1150, 315, {family: 'cond', size: 28, spacing: 3, align: 'center'});
  text(ctx, 'DEATHS', 1330, 315, {family: 'cond', size: 28, spacing: 3, align: 'center'});
  text(ctx, 'ACC.', 1500, 315, {family: 'cond', size: 28, spacing: 3, align: 'center'});
  rows.forEach(([team, k, d, acc], i) => {
    const p = easeOut(prog(t, 0.4 + i * 0.25, 0.35)); if (p <= 0) return;
    const y = 335 + i * 120;
    ctx.save(); ctx.globalAlpha = p; ctx.translate((1 - p) * 120, 0);
    ctx.fillStyle = i ? '#fbf9f4' : '#fff'; ctx.fillRect(260, y, 1400, 104);
    ctx.fillStyle = TEAM[team].color; ctx.fillRect(260, y, 14, 104);
    ctx.strokeStyle = '#14141438'; ctx.lineWidth = 1; ctx.strokeRect(260, y, 1400, 104);
    text(ctx, String(i + 1), 330, y + 82, {family: 'display', size: 76, color: i ? C.ink : C.red, align: 'center'});
    text(ctx, `プレイヤー${team + 1}`, 420, y + 70, {size: 48});
    text(ctx, String(k), 1150, y + 84, {family: 'display', size: 76, align: 'center', color: C.red});
    text(ctx, String(d), 1330, y + 80, {family: 'display', size: 60, align: 'center'});
    text(ctx, `${acc}%`, 1500, y + 80, {family: 'display', size: 60, align: 'center'});
    ctx.restore();
  });
  sticker(ctx, 1330, 843, '確認したらスタート地点へ戻ろう！', {size: 40, rotate: -2, t: prog(t, 3.4, 1)});
};
function cautionCards(ctx, t, cards) {
  const n = cards.length, cw = Math.min(330, (W - 260 - (n - 1) * 30) / n), x0 = (W - (cw * n + 30 * (n - 1))) / 2;
  cards.forEach(([pose, label, ok, at], i) => {
    const p = easeOut(prog(t, at - 0.3, 0.3)); if (p <= 0) return;
    const x = x0 + i * (cw + 30), y = 230;
    ctx.save(); ctx.globalAlpha = p; ctx.translate(0, (1 - p) * 40);
    ctx.fillStyle = ok ? '#fbf9f4' : '#f0e2df'; ctx.fillRect(x, y, cw, 520); ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.strokeRect(x, y, cw, 520);
    if (typeof pose === 'function') pose(x + cw / 2, y + 250);
    else { figure(ctx, x + cw / 2, y + 390, 1.1, pose, ok ? C.ink : '#555'); ctx.fillStyle = C.ink; ctx.fillRect(x + 24, y + 392, cw - 48, 4); }
    para(ctx, x + 18, y + 420, cw - 36, 76, -9, ok ? C.ink : C.red);
    text(ctx, label, x + cw / 2, y + 474, {size: 40, color: C.paper, align: 'center', max: cw - 70});
    ctx.restore();
    if (ok) okMark(ctx, x + cw - 64, y + 70, 44, t - at); else ngMark(ctx, x + cw / 2, y + 210, 100, t - at);
  });
}
V.noRun = (ctx, t) => {
  text(ctx, 'NO RUNNING', 160, 205, {family: 'display', size: 60, skew: -9, color: C.red, spacing: 3});
  cautionCards(ctx, t, [['run', 'はしらない', false, 0.9], ['jump', 'ジャンプしない', false, 1.6], ['slide', 'スライディングしない', false, 2.3], ['walk', 'あるく', true, 4.2], ['crouch', 'しゃがむ', true, 4.7]]);
};
// 市販品と勘違いして振り回されないよう、手作りの銃であることをはっきり伝える。
V.handmade = (ctx, t) => {
  gunSide(ctx, 560, 600, 0.95, {angle: Math.sin(t * 1.6) * 0.025});
  ctx.strokeStyle = C.red; ctx.lineWidth = 6; ctx.setLineDash([14, 10]);
  ctx.beginPath(); ctx.ellipse(560, 600, 430, 300, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  sticker(ctx, 470, 280, 'HANDMADE', {color: C.ink, size: 66, rotate: -6, t: prog(t, 0.3, 1)});
  text(ctx, 'この銃は', 1080, 320, {size: 52, skew: -9, alpha: prog(t, 0.6, 0.3)});
  text(ctx, '自作（手作り）です', 1080, 420, {size: 80, skew: -9, color: C.red, alpha: prog(t, 0.9, 0.3)});
  text(ctx, 'お店で売っている市販品ではありません', 1085, 500, {size: 40, skew: -9, alpha: prog(t, 1.5, 0.3)});
  const s = back(prog(t, 2.3, 0.35));
  if (s > 0) {
    ctx.save(); ctx.translate(1420, 690); ctx.rotate(rad(-6)); ctx.scale(s, s);
    ctx.strokeStyle = C.red; ctx.lineWidth = 8; ctx.strokeRect(-330, -95, 660, 190);
    text(ctx, 'FRAGILE', 0, -10, {family: 'display', size: 100, color: C.red, align: 'center', spacing: 8, skew: 0});
    text(ctx, 'こわれやすい・やさしく扱ってね', 0, 62, {size: 38, align: 'center', skew: 0});
    ctx.restore();
  }
};
V.noSwing = (ctx, t) => {
  text(ctx, 'HANDLE WITH CARE', 160, 205, {family: 'display', size: 60, skew: -9, color: C.red, spacing: 3});
  const swingPic = (cx, cy) => { gunSide(ctx, cx, cy - 20, 0.42, {angle: Math.sin(t * 9) * 0.4}); ctx.strokeStyle = '#14141455'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(cx, cy + 110, 190, -Math.PI * 0.85, -Math.PI * 0.15); ctx.stroke(); };
  const coverPic = (cx, cy) => { gunTop(ctx, cx, cy + 40, 0.48); hand(ctx, cx + RX_TOP.left[0] * 0.48 + 18, cy + 40 + RX_TOP.left[1] * 0.48, 0.6); };
  cautionCards(ctx, t, [[swingPic, '銃をふりまわさない', false, 0.4], [coverPic, '受信部を手でかくさない', false, 1.9]]);
};
V.noContact = (ctx, t) => {
  text(ctx, 'NO CONTACT', 160, 205, {family: 'display', size: 60, skew: -9, color: C.red, spacing: 3});
  const near = easeInOut(prog(t, 0.1, 1.1)), apart = easeInOut(prog(t, 2.3, 0.9));
  const cx = W / 2, y = 770, gap = lerp(460, 130, near) + lerp(0, 330, apart);
  ctx.fillStyle = C.ink; ctx.fillRect(cx - 700, y + 4, 1400, 5);
  figure(ctx, cx - gap, y, 1.6, 'walk', TEAM[0].color);
  ctx.save(); ctx.translate(cx + gap, y); ctx.scale(-1, 1); figure(ctx, 0, 0, 1.6, 'walk', TEAM[1].color); ctx.restore();
  ctx.save(); ctx.globalAlpha = 1 - prog(t, 2.3, 0.3); ngMark(ctx, cx, y - 180, 120, t - 1.3); ctx.restore();
  const k = prog(t, 2.8, 0.4);
  if (k > 0) {
    ctx.save(); ctx.globalAlpha = k; ctx.strokeStyle = C.ink; ctx.fillStyle = C.ink; ctx.lineWidth = 8;
    const half = 220, ay = y - 160;
    ctx.beginPath(); ctx.moveTo(cx - half, ay); ctx.lineTo(cx + half, ay); ctx.stroke();
    for (const dir of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + dir * (half + 30), ay); ctx.lineTo(cx + dir * half, ay - 24); ctx.lineTo(cx + dir * half, ay + 24); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    text(ctx, '距離をとろう', cx, y - 210, {size: 56, align: 'center', skew: -9, alpha: k});
  }
  sticker(ctx, 1560, 290, '接触禁止', {size: 64, t: prog(t, 1.4, 1)});
};
V.goBack = (ctx, t) => {
  const p = easeInOut(prog(t, 0.2, 1.6));
  ctx.strokeStyle = C.red; ctx.lineWidth = 10; ctx.setLineDash([26, 18]); ctx.lineDashOffset = -t * 60;
  ctx.beginPath(); ctx.moveTo(1200, 650); ctx.quadraticCurveTo(900, 300, 520, 420); ctx.stroke(); ctx.setLineDash([]);
  const bx = (1 - p) ** 2 * 1200 + 2 * (1 - p) * p * 900 + p * p * 520, by = (1 - p) ** 2 * 650 + 2 * (1 - p) * p * 300 + p * p * 420;
  ctx.fillStyle = TEAM[0].color + '30'; ctx.beginPath(); ctx.arc(520, 420, 150, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = TEAM[0].color; ctx.lineWidth = 6; ctx.setLineDash([16, 10]); ctx.stroke(); ctx.setLineDash([]);
  text(ctx, 'START', 520, 640, {family: 'display', size: 70, align: 'center', spacing: 4});
  player(ctx, bx, by, 60, {team: 0, dir: Math.atan2(420 - by, 520 - bx) + Math.PI / 2, out: p < 1});
  text(ctx, 'やられたら', 1180, 300, {size: 60, skew: -9});
  text(ctx, 'すぐスタート地点へ！', 1180, 390, {size: 66, skew: -9, color: C.red});
};
V.trouble = (ctx, t) => {
  const p = back(prog(t, 0.2, 0.4));
  ctx.save(); ctx.translate(520, 520); ctx.scale(p, p);
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.moveTo(0, -260); ctx.lineTo(270, 200); ctx.lineTo(-270, 200); ctx.closePath(); ctx.fill();
  ctx.fillStyle = Math.floor(t * 3) % 2 ? C.red : '#e0a90f'; ctx.beginPath(); ctx.moveTo(0, -200); ctx.lineTo(220, 168); ctx.lineTo(-220, 168); ctx.closePath(); ctx.fill();
  text(ctx, '!', 0, 140, {family: 'display', size: 280, align: 'center', color: C.ink});
  ctx.restore();
  const a = prog(t, 0.8, 0.4);
  ctx.save(); ctx.globalAlpha = a;
  ctx.fillStyle = C.ink; ctx.fillRect(950, 260, 46, 150); ctx.fillRect(1030, 260, 46, 150);
  text(ctx, 'PAUSE', 1110, 380, {family: 'display', size: 120, skew: -9, spacing: 4});
  text(ctx, 'トラブル時は試合が止まることも', 955, 490, {size: 46});
  ctx.restore();
  sticker(ctx, 1290, 640, '運営の指示にしたがってね', {color: C.ink, size: 50, t: prog(t, 2.2, 1)});
};
V.stop = (ctx, t) => {
  const p = back(prog(t, 0.2, 0.4));
  ctx.save(); ctx.translate(520, 500); ctx.scale(p, p); ctx.rotate(Math.PI / 8);
  ctx.fillStyle = C.red; ctx.strokeStyle = C.paper; ctx.lineWidth = 14;
  ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; ctx.lineTo(Math.cos(a) * 250, Math.sin(a) * 250); } ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.rotate(-Math.PI / 8);
  text(ctx, 'STOP', 0, 60, {family: 'display', size: 170, align: 'center', color: C.paper, spacing: 6});
  ctx.restore();
  text(ctx, 'キケンと判断したら', 950, 360, {size: 56, skew: -9, alpha: prog(t, 0.8, 0.3)});
  text(ctx, '試合を中止・終了', 950, 450, {size: 72, skew: -9, color: C.red, alpha: prog(t, 1.2, 0.3)});
  text(ctx, 'することがあります', 950, 530, {size: 56, skew: -9, alpha: prog(t, 1.2, 0.3)});
  sticker(ctx, 1260, 680, 'SAFETY FIRST', {color: C.ink, size: 54, t: prog(t, 3.2, 1)});
};
V.tryIt = (ctx, t) => {
  const p = back(prog(t, 0.1, 0.45));
  ctx.save(); ctx.translate(160, 520); ctx.scale(p, p);
  text(ctx, 'TRY IT!', 0, 0, {family: 'display', size: 260, skew: -9, color: C.red, spacing: 6});
  ctx.restore();
  text(ctx, '手元の銃で', 180, 650, {size: 64, skew: -9, alpha: prog(t, 0.6, 0.3)});
  text(ctx, '1分間 ためし撃ち！', 180, 740, {size: 64, skew: -9, color: C.red, alpha: prog(t, 0.9, 0.3)});
  const off = (t * 1.4 % 1) * 120;
  for (let i = 0; i < 3; i++) {
    ctx.save(); ctx.globalAlpha = 0.35 + i * 0.3; ctx.translate(1240 + i * 150 + off, 480);
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.moveTo(-60, -110); ctx.lineTo(60, 0); ctx.lineTo(-60, 110); ctx.lineTo(-20, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  text(ctx, '1:00', 1430, 760, {family: 'display', size: 150, align: 'center', skew: -9, alpha: prog(t, 1.2, 0.3)});
  text(ctx, 'PRACTICE', 1430, 820, {family: 'cond', size: 40, align: 'center', spacing: 10, alpha: prog(t, 1.2, 0.3)});
};
const PRACTICE_START = 1.6, PRACTICE_SEC = 60;
V.practice = (ctx, t) => {
  const started = t >= PRACTICE_START, done = t >= PRACTICE_START + PRACTICE_SEC;
  const left = clamp(PRACTICE_SEC - (t - PRACTICE_START), 0, PRACTICE_SEC), sec = Math.ceil(left);
  const urgent = started && !done && left <= 10;
  text(ctx, 'PRACTICE', 160, 420, {family: 'display', size: 150, skew: -9, color: C.red, spacing: 4});
  text(ctx, '1分間 ためし撃ち', 170, 520, {size: 64, skew: -9});
  text(ctx, '・1つ目のライトが白 ＝ 撃てる', 175, 640, {size: 36});
  text(ctx, '・受信部（前・左・右）をねらえ', 175, 700, {size: 36});
  text(ctx, '・あるく・しゃがむだけ', 175, 760, {size: 36});
  const cx = 1340, cy = 500, r = 290;
  ring(ctx, cx, cy, r + 70, '#14141430', 2, t * 0.3, 24);
  ctx.lineWidth = 40; ctx.lineCap = 'butt';
  ctx.strokeStyle = '#14141418'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = urgent ? C.red : C.ink;
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (left / PRACTICE_SEC)); ctx.stroke();
  if (done) {
    sticker(ctx, cx, cy, 'TIME UP!', {size: 120, t: prog(t, PRACTICE_START + PRACTICE_SEC, 1)});
    return;
  }
  const pulse = urgent && left <= 5 ? 1 + 0.1 * (left - Math.floor(left)) : 1;
  ctx.save(); ctx.translate(cx, cy + 75); ctx.scale(pulse, pulse);
  text(ctx, `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, 0, 0, {family: 'display', size: 210, align: 'center', skew: -9, color: urgent ? C.red : C.ink});
  ctx.restore();
  if (!started) sticker(ctx, cx, cy + 170, 'READY?', {color: C.ink, size: 54, t: prog(t, 0.2, 1)});
  else text(ctx, 'TIME LEFT', cx, cy - 130, {family: 'cond', size: 40, align: 'center', spacing: 10});
};

export function drawFrame(ctx, tl, now) {
  const item = tl.items.findLast(i => i.start <= now) ?? tl.items[0];
  const t = now - item.start;
  background(ctx, now);
  if (item.kind === 'scene') {
    masthead(ctx, item);
    ctx.save();
    const fade = prog(t, 0, 0.18);
    ctx.globalAlpha = fade;
    V[item.scene.visual](ctx, t, item);
    ctx.restore();
    telop(ctx, item, t);
  } else {
    const previous = tl.items[tl.items.indexOf(item) - 1];
    if (previous) { masthead(ctx, previous); V[previous.scene.visual](ctx, previous.duration, previous); }
    else masthead(ctx, item);
    sectionCard(ctx, item, t);
  }
  progressBar(ctx, tl, now);
}

// ---------- 音（ナレーション・効果音） ----------
const FILES = {shot: 'shot.mp3', defeat: 'defeat.mp3', revive: 'revive.mp3', matchEnd: 'match-end.mp3', hit: 'hit.mp3'};
export async function loadSounds(ac, tl) {
  const decode = async url => ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const sounds = {};
  for (const [name, file] of Object.entries(FILES)) sounds[name] = await decode(`/assets/audio/effects/${file}`);
  const voices = {};
  for (const item of tl.items) if (item.kind === 'scene') voices[item.index] = await decode(item.voiceUrl);
  return {sounds, voices};
}
function synth(ac, out, name, when) {
  const osc = (type, f0, f1, start, length, peak) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, when + start); o.frequency.exponentialRampToValueAtTime(f1, when + start + length);
    g.gain.setValueAtTime(0.0001, when + start); g.gain.exponentialRampToValueAtTime(peak, when + start + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, when + start + length);
    o.connect(g).connect(out); o.start(when + start); o.stop(when + start + length + 0.02);
  };
  const noise = (start, length, f0, f1, peak, type = 'bandpass') => {
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * length), ac.sampleRate), data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(), filter = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = buffer; filter.type = type; filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(f0, when + start); filter.frequency.exponentialRampToValueAtTime(f1, when + start + length);
    g.gain.setValueAtTime(0.0001, when + start); g.gain.exponentialRampToValueAtTime(peak, when + start + length * 0.4); g.gain.exponentialRampToValueAtTime(0.0001, when + start + length);
    src.connect(filter).connect(g).connect(out); src.start(when + start);
  };
  if (name === 'pop') osc('sine', 1100, 320, 0, 0.11, 0.5);
  if (name === 'ok') { osc('sine', 660, 660, 0, 0.1, 0.35); osc('sine', 990, 990, 0.09, 0.16, 0.35); }
  if (name === 'ng') { osc('square', 170, 160, 0, 0.13, 0.16); osc('square', 170, 160, 0.17, 0.16, 0.16); }
  if (name === 'lock') { osc('sine', 1600, 1600, 0, 0.05, 0.3); osc('sine', 2200, 2200, 0.06, 0.06, 0.3); }
  if (name === 'chime') { osc('triangle', 880, 880, 0, 0.25, 0.4); osc('triangle', 1320, 1320, 0.1, 0.3, 0.35); osc('triangle', 1760, 1760, 0.2, 0.5, 0.3); }
  if (name === 'whoosh') noise(0, 0.5, 300, 4000, 0.5);
  if (name === 'impact') { osc('sine', 140, 38, 0, 0.6, 0.9); noise(0, 0.35, 2000, 200, 0.5, 'lowpass'); }
  if (name === 'alert') for (let i = 0; i < 3; i++) { osc('square', 880, 880, i * 0.3, 0.14, 0.1); osc('square', 660, 660, i * 0.3 + 0.15, 0.14, 0.1); }
}
// from 秒以降の音を ac の startAt から鳴らす（プレビューの途中再生と書き出しで共用）
export function scheduleAudio(ac, tl, {sounds, voices}, from = 0, startAt = ac.currentTime) {
  const master = ac.createGain(); master.gain.value = 0.95; master.connect(ac.destination);
  const sfxBus = ac.createGain(); sfxBus.gain.value = 0.45; sfxBus.connect(master);
  const nodes = [master];
  const at = time => startAt + time - from;
  for (const item of tl.items) {
    if (item.kind === 'section') { if (item.start >= from) synth(ac, sfxBus, 'whoosh', at(item.start)); continue; }
    const voice = voices[item.index];
    if (item.voiceAt + voice.duration > from) {
      const src = ac.createBufferSource(); src.buffer = voice; src.connect(master);
      const offset = Math.max(0, from - item.voiceAt);
      src.start(at(item.voiceAt + offset), offset); nodes.push(src);
    }
    for (const [offset, name] of item.scene.sfx ?? []) {
      const time = item.start + offset; if (time < from) continue;
      if (sounds[name]) { const src = ac.createBufferSource(); src.buffer = sounds[name]; src.connect(sfxBus); src.start(at(time)); nodes.push(src); }
      else synth(ac, sfxBus, name, at(time));
    }
  }
  return () => master.disconnect();
}
