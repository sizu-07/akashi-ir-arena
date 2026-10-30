// 試合結果の共有ページ。投影画面と同じ赤・墨黒・生成りで、Instagram用の縦画像とX用の横画像を作る。
const $ = (id) => document.getElementById(id);
const C = {red: '#ed2335', ink: '#141414', paper: '#f4f1e9', grey: '#6a6760'};
const PLAYER_COLORS = ['#1684a7', '#c45e28', '#6b9c31', '#9a58a7'];
const HASHTAG = '#明石光線';
const JP = "'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', sans-serif";
const token = decodeURIComponent(location.pathname.split('/').pop() ?? '');

let data = null;
let me = null;
let shareText = '';
const images = {};

const rankLabel = (player) => data.draw && player.rank === 1 ? '同率1位' : `${player.rank}位`;

function font(ctx, kind, size) {
  ctx.font = kind === 'display' ? `${size}px Anton, Impact, sans-serif` : kind === 'cond' ? `700 ${size}px Barlow, sans-serif` : `900 ${size}px ${JP}`;
}
function text(ctx, value, x, y, {kind = 'jp', size = 40, color = C.ink, align = 'left', max = 0, skew = -9} = {}) {
  ctx.save();
  font(ctx, kind, size);
  const width = ctx.measureText(value).width;
  if (max && width > max) font(ctx, kind, size * max / width);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.translate(x, y);
  ctx.transform(1, 0, Math.tan(skew * Math.PI / 180), 1, 0, 0);
  ctx.fillText(value, 0, 0);
  ctx.restore();
}
function plate(ctx, x, y, w, h, color) {
  const dx = Math.tan(9 * Math.PI / 180) * h;
  ctx.beginPath(); ctx.moveTo(x + dx, y); ctx.lineTo(x + w + dx, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
}
function background(ctx, w, h) {
  ctx.fillStyle = C.paper; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#1414140c'; ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 48) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 48) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke(); }
  ctx.fillStyle = C.red;
  ctx.beginPath(); ctx.moveTo(w * 0.72, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h); ctx.lineTo(w * 0.42, h); ctx.closePath();
  ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
}
function brand(ctx, x, y, size) {
  text(ctx, '↗', x, y, {kind: 'display', size: size * 1.25, color: C.red, skew: 0});
  text(ctx, '明石', x + size * 1.1, y, {size});
  text(ctx, '光線', x + size * 3.05, y, {size, color: C.red});
  text(ctx, 'AKASHI IR ARENA', x + size * 5.3, y - size * 0.1, {kind: 'cond', size: size * 0.42, skew: 0});
}
function standings(ctx, x, y, w, rowH, size) {
  for (const [index, player] of [...data.players].sort((a, b) => a.rank - b.rank || a.slot - b.slot).entries()) {
    const top = y + index * (rowH + 10), mine = player.slot === me.slot;
    ctx.fillStyle = mine ? '#ffffff' : '#fbf9f4'; ctx.fillRect(x, top, w, rowH);
    ctx.fillStyle = PLAYER_COLORS[player.slot - 1] ?? C.red; ctx.fillRect(x, top, size * 0.28, rowH);
    if (mine) { ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.strokeRect(x + 2, top + 2, w - 4, rowH - 4); }
    const base = top + rowH * 0.68;
    text(ctx, String(player.rank), x + size * 0.9, base, {kind: 'display', size: size * 1.15, color: mine ? C.red : C.ink, align: 'center'});
    text(ctx, mine ? player.name : `プレイヤー${player.slot}`, x + size * 1.7, base - size * 0.05, {size: size * 0.78, max: w - size * 5.2, color: mine ? C.ink : '#3a3a3a'});
    text(ctx, String(player.kills), x + w - size * 1.6, base, {kind: 'display', size: size * 1.15, color: C.red, align: 'right'});
    text(ctx, 'KILLS', x + w - size * 0.25, base - size * 0.05, {kind: 'cond', size: size * 0.36, align: 'right', skew: 0});
  }
}
function headline(ctx, x, y, size) {
  const winner = me.winner;
  text(ctx, winner ? (data.draw ? 'TIE FOR FIRST' : 'WINNER!') : 'FINAL RESULT', x, y, {kind: 'display', size: size * 0.7, color: winner ? C.red : C.ink});
  text(ctx, me.name, x, y + size * 1.25, {size: size * 1.1, max: size * 9.5});
  text(ctx, rankLabel(me), x, y + size * 2.55, {size: size * 1.05, color: C.red});
  text(ctx, `${me.kills}`, x + size * 3.6, y + size * 2.6, {kind: 'display', size: size * 1.45});
  text(ctx, 'キル', x + size * 3.6 + measure(ctx, 'display', size * 1.45, `${me.kills}`) + size * 0.25, y + size * 2.55, {size: size * 0.6});
  text(ctx, `${data.rounds}ゲーム合計 ／ デス ${me.deaths} ／ 命中率 ${me.accuracy}%`, x, y + size * 3.35, {size: size * 0.42, color: '#3a3a3a', skew: 0});
}
function measure(ctx, kind, size, value) { ctx.save(); font(ctx, kind, size); const width = ctx.measureText(value).width; ctx.restore(); return width; }
function footer(ctx, x, y, size, align = 'left') {
  text(ctx, HASHTAG, x, y, {size, color: C.paper, align});
}

function drawPortrait() {
  const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1920;
  const ctx = canvas.getContext('2d');
  background(ctx, 1080, 1920);
  ctx.fillStyle = C.ink; ctx.fillRect(70, 90, 940, 6); ctx.fillRect(70, 230, 940, 2);
  brand(ctx, 80, 195, 72);
  plate(ctx, 80, 300, 330, 64, C.ink);
  text(ctx, 'MATCH REPORT', 105, 350, {kind: 'cond', size: 40, color: C.paper, skew: 0});
  headline(ctx, 90, 480, 100);
  standings(ctx, 80, 960, 920, 150, 92);
  plate(ctx, 80, 1640, 640, 110, C.ink);
  footer(ctx, 120, 1720, 76);
  text(ctx, 'NO CONTACT. ALL IMPACT.', 1000, 1850, {kind: 'cond', size: 34, color: C.paper, align: 'right', skew: 0});
  return canvas;
}
function drawLandscape() {
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
  const ctx = canvas.getContext('2d');
  background(ctx, 1600, 900);
  ctx.fillStyle = C.ink; ctx.fillRect(60, 50, 1480, 5); ctx.fillRect(60, 150, 1480, 2);
  brand(ctx, 70, 125, 58);
  headline(ctx, 80, 260, 78);
  standings(ctx, 870, 200, 660, 118, 70);
  plate(ctx, 70, 720, 470, 90, C.ink);
  footer(ctx, 100, 785, 60);
  text(ctx, `${data.rounds} GAMES / FREE FOR ALL`, 1530, 840, {kind: 'cond', size: 30, color: C.paper, align: 'right', skew: 0});
  return canvas;
}
const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }

// LINEやInstagramなどアプリ内のブラウザでは、画像の共有機能が使えないことが多い。
const inAppBrowser = /Line\/|Instagram|FBAN|FBAV|Twitter|MicroMessenger|KAKAOTALK/i.test(navigator.userAgent);
let cardUpload = Promise.resolve();
const files = {};

// Xは文章とリンクを入れた投稿画面をすぐ開く。リンクのプレビューに結果画像（横長）が出る。
async function shareToX() {
  notice('Xの投稿画面を開きます。そのままポストできます。');
  await Promise.race([cardUpload, new Promise((resolve) => setTimeout(resolve, 2500))]);
  const pageUrl = `${location.origin}/s/${encodeURIComponent(token)}`;
  location.href = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}`;
}

// Instagramはタップの直後に共有メニューを開く（待ち時間をはさむとブラウザに拒否される）。
function shareToInstagram() {
  try { navigator.clipboard?.writeText(shareText).catch(() => {}); } catch {}
  const file = files.instagram;
  if (file && navigator.canShare?.({files: [file]})) {
    notice('共有メニューで「Instagram」→「ストーリーズ」を選んでください。文章とハッシュタグはコピー済みなので、必要ならテキストとして貼り付けられます。');
    navigator.share({files: [file]}).catch((error) => {
      if (error.name !== 'AbortError') notice('共有メニューを開けませんでした。下の画像を長押しして保存し、Instagramのストーリーズから投稿してください。');
    });
    return;
  }
  notice(inAppBrowser
    ? 'このアプリ内のブラウザでは直接共有できません。右上のメニューから「Safariで開く」または「ブラウザで開く」を選び、もう一度ボタンを押してください。'
    : 'この端末では直接共有できません。下の画像を長押しして保存し、Instagramのストーリーズから投稿してください。');
}

async function main() {
  try {
    const response = await fetch(`/api/public/share/${encodeURIComponent(token)}`, {cache: 'no-store'});
    const body = await response.json();
    if (!response.ok) throw Error(body.error ?? '結果を読み込めませんでした');
    data = body;
    me = data.players.find((player) => player.slot === data.me);
    await Promise.allSettled([document.fonts.load('40px Anton'), document.fonts.load('700 40px Barlow')]);
    shareText = `明石光線をプレイしました！ 結果は${rankLabel(me)}（${data.rounds}ゲーム合計 ${me.kills}キル）でした。 ${HASHTAG}`;
    $('headline').innerHTML = '';
    $('headline').append(`${me.name} さんは `, Object.assign(document.createElement('em'), {textContent: rankLabel(me)}), '！');
    $('summary').textContent = `${data.rounds}ゲーム合計 ${me.kills}キル ／ デス ${me.deaths} ／ 命中率 ${me.accuracy}%`;
    const portrait = drawPortrait(), landscape = drawLandscape();
    images.instagram = await toBlob(portrait);
    images.x = await toBlob(landscape);
    files.instagram = new File([images.instagram], 'akashi-kosen-story.png', {type: 'image/png'});
    // Xのリンクプレビュー用に、横長の画像を縮小したJPEGをサーバーへ渡しておく。
    const card = document.createElement('canvas'); card.width = 1200; card.height = 675;
    card.getContext('2d').drawImage(landscape, 0, 0, 1200, 675);
    cardUpload = new Promise((resolve) => card.toBlob(resolve, 'image/jpeg', 0.86))
      .then((blob) => fetch(`/api/public/share/${encodeURIComponent(token)}/card`, {method: 'POST', headers: {'Content-Type': 'image/jpeg'}, body: blob}))
      .catch(() => {});
    if (inAppBrowser) notice('アプリ内のブラウザで開いています。Instagramに共有するときは、右上のメニューから「Safariで開く」「ブラウザで開く」を選んでください。');
    $('previewPortrait').src = portrait.toDataURL('image/png');
    $('savePortrait').href = portrait.toDataURL('image/png');
    $('saveLandscape').href = landscape.toDataURL('image/png');
    $('expires').textContent = `このページは ${new Date(data.expiresAt).toLocaleDateString('ja-JP')} まで表示できます。`;
    $('shareX').onclick = () => shareToX();
    $('shareInstagram').onclick = () => shareToInstagram();
    $('loading').hidden = true;
    $('result').hidden = false;
  } catch (error) {
    $('loading').hidden = true;
    $('errorText').textContent = error.message;
    $('error').hidden = false;
  }
}
main();
