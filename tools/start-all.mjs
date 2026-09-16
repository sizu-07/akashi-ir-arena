import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {createApp} from '../apps/server/main.mjs';
import {createTicketApp} from '../apps/ticket-server/main.mjs';

const demo = process.argv.includes('--demo');
const gameFile = 'config/local.json';
const ticketFile = 'config/ticket-local.json';
if (!existsSync(gameFile) || !existsSync(ticketFile)) {
  console.error('先に node tools/setup.mjs と node tools/setup-ticket.mjs を実行してください');
  process.exit(1);
}

const gameConfig = JSON.parse(readFileSync(gameFile, 'utf8'));
const ticketConfig = JSON.parse(readFileSync(ticketFile, 'utf8'));
let gameApp;
let ticketApp;
try {
  ticketApp = await createTicketApp({...ticketConfig, dataDir: path.resolve('data/tickets')});
  gameApp = await createApp({config: gameConfig, demo, dataDir: path.resolve(demo ? 'data/demo' : 'data/live')});
} catch (error) {
  await gameApp?.close().catch(() => {});
  await ticketApp?.close().catch(() => {});
  if (error.code === 'EADDRINUSE') console.error(`${error.port}番ポートが使用中です。既存の起動画面を閉じてから再実行してください。`);
  else console.error(`一括起動に失敗しました: ${error.message}`);
  process.exit(1);
}

console.log(`\nAKASHI IR ARENA 一括起動 ${demo ? '[デモ]' : '[本番]'}`);
console.log(`ゲーム運営: http://localhost:${gameConfig.httpPort}/`);
console.log(`整理券受付: http://localhost:${ticketConfig.port}/register`);
console.log(`整理券運営: http://localhost:${ticketConfig.port}/operator`);
console.log(`入場QR読取: http://localhost:${ticketConfig.port}/scanner`);
console.log('PINと運営パスワードは config/local.json と config/ticket-local.json を確認してください。');
console.log('終了するには Ctrl+C を押してください。');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  gameApp.game.pause('server_shutdown');
  await Promise.allSettled([gameApp.close(), ticketApp.close()]);
  process.exit(0);
});
