import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {createTicketApp} from '../apps/ticket-server/main.mjs';

const file = 'config/ticket-local.json';
if (!existsSync(file)) {
  console.error('先に npm run ticket:setup を実行してください');
  process.exit(1);
}
const config = JSON.parse(readFileSync(file, 'utf8'));
let app;
try {
  app = await createTicketApp({...config, dataDir: path.resolve('data/tickets')});
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`${error.port}番ポートでは整理券サーバーがすでに起動しているか、別のアプリケーションが使用中です。`);
  } else {
    console.error(`整理券サーバーを起動できません: ${error.message}`);
  }
  process.exit(1);
}
console.log(`整理券受付: http://localhost:${app.server.address().port}/register`);
console.log(`整理券運営: http://localhost:${app.server.address().port}/operator`);
console.log(`入場読取:   http://localhost:${app.server.address().port}/scanner`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  process.exit(0);
});
