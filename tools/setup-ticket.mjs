import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';

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
