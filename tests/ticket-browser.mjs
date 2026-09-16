import {createRequire} from 'node:module';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createTicketApp} from '../apps/ticket-server/main.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ticket-browser-'));
const operatorPassword = 'ticket-browser-password';
const app = await createTicketApp({dataDir, operatorPassword, gameApiKey: 'ticket-browser-game-api-key'});
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;

try {
  const registration = await fetch(`${base}/api/public/register`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({requestId: 'ticket-browser-registration', nicknames: ['テスト'], partySize: 1, consent: true}),
  });
  assert.equal(registration.status, 201);
  const ticket = await registration.json();

  browser = await chromium.launch({channel: 'msedge', headless: true});
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${base}/operator`);
  await page.locator('input[name="password"]').fill(operatorPassword);
  await page.getByRole('button', {name: 'ログイン'}).click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.locator('#registrationBanner').getByText('受付中', {exact: true}).waitFor();
  const messageInput = page.locator('#messageForm textarea[name="message"]');
  await messageInput.fill('入力途中の全体連絡');
  await fetch(`${base}/api/public/register`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({requestId: 'ticket-browser-second-registration', nicknames: ['追加'], partySize: 1, consent: true}),
  });
  await page.waitForTimeout(300);
  assert.equal(await messageInput.inputValue(), '入力途中の全体連絡');
  await page.getByRole('button', {name: '遅延を1枠追加'}).click();
  await page.locator('#delaySummary').getByText('1枠（15分）遅延', {exact: true}).waitFor();
  await page.locator('#queueTimeline').getByText('遅延・使用なし', {exact: true}).waitFor();
  await page.getByRole('button', {name: /次の.*呼び出/}).click();

  await page.goto(`${base}/scanner#AKASHI:${ticket.qrToken}`);
  await page.locator('#scanSuccess').waitFor({state: 'visible'});
  await assert.doesNotReject(() => page.getByRole('heading', {name: '読み取り成功'}).waitFor());
  await assert.doesNotReject(() => page.locator('#scanSuccessTicket').getByText(ticket.ticketNumber).waitFor());
  assert.equal(await page.locator('#scanSuccess').evaluate((node) => getComputedStyle(node).position), 'fixed');
  await page.getByRole('button', {name: '次のQRコードを読み取る'}).click();
  await page.locator('#scanSuccess').waitFor({state: 'hidden'});
  assert.deepEqual(pageErrors, []);
  console.log('Ticket browser E2E: PASS');
} finally {
  await browser?.close();
  await app.close();
  if (path.dirname(dataDir) === os.tmpdir() && path.basename(dataDir).startsWith('ticket-browser-')) rmSync(dataDir, {recursive: true, force: true});
}
