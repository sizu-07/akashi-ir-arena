import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import {linkTicketConfig} from './link-ticket-config.mjs';
mkdirSync('config', { recursive: true });
if (existsSync('config/local.json')) {
  console.log('既存設定を保持しました: config/local.json');
} else {
  const config = { httpPort: 8080, mqttPort: 1883, operatorPin: String(randomInt(10000000, 99999999)),
    devices: [1,2,3,4].map(n => ({id: `gun-00${n}`, key: randomBytes(24).toString('hex'), shooterId: n, team: n <= 2 ? 'A' : 'B', name: `プレイヤー${n}`})) };
  writeFileSync('config/local.json', JSON.stringify(config, null, 2));
  console.log('設定を作成しました。運営PINと各銃の鍵は config/local.json をローカルで確認してください。公開しないでください。');
}
const link = linkTicketConfig();
if (link.linked) console.log(`${link.changed ? 'ゲーム設定へ整理券連携を設定しました' : 'ゲーム設定の整理券連携を確認しました'}: ${link.url}`);
else if (link.reason === 'external') console.log(`外部整理券サーバー設定を保持しました: ${link.url}`);
