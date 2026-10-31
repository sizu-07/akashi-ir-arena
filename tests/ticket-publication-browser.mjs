import {createRequire} from 'node:module';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createTicketApp} from '../apps/ticket-server/main.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ticket-publication-'));
const app = await createTicketApp({dataDir, operatorPassword: 'publication-test-password', gameApiKey: 'publication-test-game-api-key'});
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  browser = await chromium.launch({channel: 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 390, height: 844}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/register`);
  const notice = page.locator('#mandatoryNotice');
  await notice.waitFor({state: 'visible'});
  assert.match(await notice.innerText(), /小さいお子さんには難しいゲーム/);
  assert.match(await notice.innerText(), /時間を適宜確認/);
  assert.match(await notice.innerText(), /入場時間は、整理券の登録後に変更できません/);
  assert.doesNotMatch(await notice.innerText(), /チーム/);
  await page.locator('#noticeConfirmed').check();
  await page.locator('#noticeContinue').click();
  assert.doesNotMatch(await page.locator('#registerForm').innerText(), /本名/);
  await page.getByLabel('参加人数').selectOption('4');
  assert.equal(await page.locator('#nicknameFields input').count(), 4);
  assert.equal(await page.locator('#nicknameFields select').count(), 0);
  await page.getByLabel('参加人数').selectOption('2');
  await page.getByLabel('1人目', {exact: true}).fill('あかし');
  await page.getByLabel('2人目', {exact: true}).fill('ひかり');
  await page.locator('[name=consent]').check();
  await page.waitForFunction(() => document.querySelector('#arrivalTime').textContent.includes('ごろ'));
  assert.match(await page.locator('#registerForm').innerText(), /入場時間はこの時間です/);
  assert.equal(await page.locator('#arrivalOptions').isVisible(), false);
  await page.locator('#changeArrival').click();
  assert.equal(await page.locator('#arrivalOptions').isVisible(), true);
  await page.locator('#arrivalSelect').selectOption({index: 1});
  // 確認画面は出さず、ボタン1回でそのまま登録する。
  await page.getByRole('button', {name: '確認して登録する'}).click();
  await page.waitForURL('**/ticket#*');
  await page.locator('#content').waitFor({state: 'visible'});
  assert.match(await page.locator('.operator-help').innerText(), /教室内の運営スタッフ/);
  assert.match(await page.locator('.ticket-time-reminder').innerText(), /適宜確認/);
  assert.deepEqual(errors, []);
  console.log('Ticket publication browser: PASS');
} finally {
  await browser?.close();
  await app.close();
  rmSync(dataDir, {recursive: true, force: true});
}
