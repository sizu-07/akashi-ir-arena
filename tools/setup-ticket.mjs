import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {linkTicketConfig} from './link-ticket-config.mjs';

mkdirSync('config', {recursive: true});
const file = 'config/ticket-local.json';
if (existsSync(file)) {
  console.log(`既存設定を保持しました: ${file}`);
} else {
  const config = {
    port: 8787,
    bind: '0.0.0.0',
    publicOrigin: '',
    operatorPassword: randomBytes(12).toString('base64url'),
    gameApiKey: randomBytes(32).toString('hex'),
  };
  writeFileSync(file, JSON.stringify(config, null, 2));
  console.log(`整理券設定を作成しました: ${file}`);
  console.log('運営パスワードとゲームAPIキーはこのファイルで確認してください。Gitには追加しないでください。');
}
const link = linkTicketConfig();
if (link.linked) console.log(`${link.changed ? 'ゲーム設定へ整理券連携を設定しました' : 'ゲーム設定の整理券連携を確認しました'}: ${link.url}`);
else if (link.reason === 'external') console.log(`外部整理券サーバー設定を保持しました: ${link.url}`);
else console.log('config/local.json の作成後に再実行すると、ゲーム連携を自動設定します。');
