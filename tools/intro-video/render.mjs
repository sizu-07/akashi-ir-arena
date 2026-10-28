// ルール説明動画を生成する。
//   node render.mjs                         Windows標準のHarukaで音声を作って書き出す
//   node render.mjs --voice voicevox --speaker 3   VOICEVOX（起動しておく）で作る
//   node render.mjs --preview               書き出さずにブラウザ確認用のURLを開いたままにする
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {scenes} from './script.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const flag = name => process.argv.includes(`--${name}`);
const engine = arg('voice', 'haruka');
const speaker = Number(arg('speaker', 3));
const speed = Number(arg('speed', engine === 'haruka' ? 1.2 : 1.15));
const output = path.resolve(root, arg('out', 'assets/rules-intro.webm'));
const voiceDir = path.join(here, 'build/voice');
mkdirSync(voiceDir, {recursive: true});

function wavSeconds(file) {
  const buffer = readFileSync(file);
  let byteRate = 0;
  for (let offset = 12; offset < buffer.length - 8;) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = buffer.readUInt32LE(offset + 16);
    if (id === 'data') return size / byteRate;
    offset += 8 + size + (size % 2);
  }
  throw Error(`WAVの長さを読めません: ${file}`);
}

async function voicevox(text, file) {
  const host = arg('voicevox-url', 'http://127.0.0.1:50021');
  const query = await fetch(`${host}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, {method: 'POST'})
    .catch(() => { throw Error('VOICEVOXに接続できません。VOICEVOXを起動してから実行してください'); });
  if (!query.ok) throw Error(`VOICEVOX audio_query: ${query.status}`);
  const body = await query.json();
  body.speedScale = speed;
  body.outputSamplingRate = 48000;
  const wav = await fetch(`${host}/synthesis?speaker=${speaker}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!wav.ok) throw Error(`VOICEVOX synthesis: ${wav.status}`);
  writeFileSync(file, Buffer.from(await wav.arrayBuffer()));
}

function haruka(jobs) {
  if (!jobs.length) return;
  const list = path.join(voiceDir, 'haruka-jobs.json');
  writeFileSync(list, JSON.stringify(jobs.map(([text, file]) => ({text, file}))));
  const rate = Math.round((speed - 1) * 10);
  const script = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Haruka Desktop'); $s.Rate = ${rate}
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($job in (Get-Content -Raw -Encoding UTF8 '${list}' | ConvertFrom-Json)) { $s.SetOutputToWaveFile($job.file, $format); $s.Speak($job.text); $s.SetOutputToNull() }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {encoding: 'utf8'});
  if (result.status !== 0) throw Error(`Harukaの音声合成に失敗しました: ${result.stderr}`);
}

async function buildVoices() {
  const lines = scenes.map((scene, index) => {
    const hash = createHash('sha1').update(`${engine}/${speaker}/${speed}/${scene.say}`).digest('hex').slice(0, 10);
    return {file: path.join(voiceDir, `${String(index + 1).padStart(2, '0')}-${engine}-${hash}.wav`), text: scene.say};
  });
  const missing = lines.filter(line => !existsSync(line.file));
  if (engine === 'haruka') haruka(missing.map(line => [line.text, line.file]));
  else if (engine === 'voicevox') for (const line of missing) await voicevox(line.text, line.file);
  else throw Error('--voice は haruka か voicevox を指定してください');
  let credit = '';
  if (engine === 'voicevox') {
    const host = arg('voicevox-url', 'http://127.0.0.1:50021');
    const speakers = await (await fetch(`${host}/speakers`)).json();
    const name = speakers.find(s => s.styles.some(style => style.id === speaker))?.name ?? `speaker ${speaker}`;
    credit = `VOICEVOX:${name}`;
  }
  const manifest = {engine, speaker, speed, credit, lines: lines.map(line => ({url: `/tools/intro-video/build/voice/${path.basename(line.file)}`, seconds: wavSeconds(line.file)}))};
  writeFileSync(path.join(voiceDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'video/webm'};
function serve() {
  let resolveUpload;
  const uploaded = new Promise(resolve => { resolveUpload = resolve; });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/__output') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      mkdirSync(path.dirname(output), {recursive: true});
      writeFileSync(output, data);
      res.end('ok');
      resolveUpload(data.length);
      return;
    }
    const file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/tools/intro-video/index.html' : url.pathname));
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store'});
    res.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port, uploaded})));
}

const manifest = await buildVoices();
console.log(`ナレーション ${manifest.lines.length} 本 (${engine})`);
const {server, port, uploaded} = await serve();
const url = `http://127.0.0.1:${port}/tools/intro-video/index.html`;
if (flag('preview')) {
  console.log(`プレビュー: ${url}  （Ctrl+Cで終了）`);
} else if (flag('stills')) {
  // 確認用の静止画: --stills 5,12.5,30 → build/stills/*.png
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
    await page.goto(`${url}?mode=render`);
    await page.waitForFunction(() => window.show);
    mkdirSync(path.join(here, 'build/stills'), {recursive: true});
    // 4コマずつ2×2の一覧画像にする
    const times = arg('stills').split(',').map(Number);
    for (let i = 0; i < times.length; i += 4) {
      const png = await page.evaluate(group => {
        const sheet = document.createElement('canvas'); sheet.width = 1920; sheet.height = 1080;
        const g = sheet.getContext('2d'), main = document.querySelector('canvas');
        group.forEach((t, k) => { window.show(t); g.drawImage(main, (k % 2) * 960, Math.floor(k / 2) * 540, 960, 540); g.fillStyle = '#000'; g.fillRect((k % 2) * 960, Math.floor(k / 2) * 540, 90, 30); g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(t.toFixed(1), (k % 2) * 960 + 8, Math.floor(k / 2) * 540 + 22); });
        return sheet.toDataURL('image/png').split(',')[1];
      }, times.slice(i, i + 4));
      writeFileSync(path.join(here, `build/stills/sheet-${i / 4 + 1}.png`), Buffer.from(png, 'base64'));
    }
  } finally {
    await browser.close();
    server.close();
  }
} else {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
    page.on('console', message => console.log(`[page] ${message.text()}`));
    await page.goto(`${url}?mode=render`);
    page.setDefaultTimeout(0);
    await page.waitForFunction(() => window.renderVideo);
    const stats = await page.evaluate(() => window.renderVideo());
    const bytes = await uploaded;
    const report = {output: path.relative(root, output).replaceAll('\\', '/'), bytes, sha256: createHash('sha256').update(readFileSync(output)).digest('hex'), voice: {engine, speaker: engine === 'voicevox' ? speaker : null, credit: manifest.credit}, ...stats};
    writeFileSync(output.replace(/\.webm$/, '.json'), JSON.stringify(report, null, 2));
    console.log(`${report.output}: ${stats.durationSeconds.toFixed(1)}秒, ${(bytes / 1048576).toFixed(1)}MB`);
  } finally {
    await browser.close();
    server.close();
  }
}
