import {createRequire} from 'node:module';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createTicketApp} from '../apps/ticket-server/main.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ticket-guest-browser-'));
const operatorPassword = 'guest-browser-test-password';
const app = await createTicketApp({dataDir, operatorPassword, gameApiKey: 'guest-browser-test-game-api-key'});
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  browser = await chromium.launch({channel: 'msedge', headless: true});
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  mkdirSync('artifacts/guest-ui', {recursive: true});
  await page.goto(`${base}/register`);
  await page.getByLabel('参加人数').selectOption('2');
  await page.getByLabel('1人目', {exact: true}).fill('あかし');
  await page.getByLabel('2人目', {exact: true}).fill('ひかり');
  await page.getByLabel('参加人数').selectOption('4');
  assert.equal(await page.locator('#nicknameFields input').count(), 4);
  assert.equal(await page.locator('#nicknameFields select').count(), 4);
  assert.equal(await page.getByLabel('4人目のチーム').inputValue(), 'B');
  assert.equal(await page.getByLabel('1人目', {exact: true}).inputValue(), 'あかし');
  await page.getByLabel('参加人数').selectOption('2');
  assert.equal(await page.locator('#nicknameFields select').count(), 0);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({width, height: 900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `受付 ${width}pxで横にはみ出さない`);
    if ([390, 1280].includes(width)) await page.screenshot({path: `artifacts/guest-ui/register-${width}.png`, fullPage: true});
  }
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('[name=consent]').check();
  await page.getByRole('button', {name: '整理券を取得する'}).click();
  await page.waitForURL('**/ticket#*');
  const ticket = app.queue.state.tickets.find(item => item.accessToken === new URL(page.url()).hash.slice(1));
  assert.ok(ticket);
  await page.locator('#content').waitFor({state: 'visible'});
  assert.match(await page.locator('#identity').innerText(), /あかし・ひかり \/ 2名/);
  await page.waitForFunction(() => document.querySelector('#qr').naturalWidth > 0);
  const ticketUrl = page.url();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({width, height: 900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `整理券 ${width}pxで横にはみ出さない`);
    if ([390, 1280].includes(width)) await page.screenshot({path: `artifacts/guest-ui/ticket-${width}.png`, fullPage: true});
  }
  await page.goto(`${base}/register`);
  await page.getByRole('link', {name: '保存済みの整理券を開く'}).click();
  assert.equal(page.url(), ticketUrl);
  // Exercise live call, announcement and check-in on the same issued ticket.
  const login = await fetch(`${base}/api/operator/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: operatorPassword})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await login.json();
  const headers = {'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': session.csrf};
  const state = await (await fetch(`${base}/api/operator/state`, {headers})).json();
  if (!state.rounds.some(round => round.status === 'CALLED')) {
    const call = await fetch(`${base}/api/operator/action`, {method: 'POST', headers, body: JSON.stringify({action: 'call_next', commandId: 'guest-call'})});
    assert.equal(call.status, 200);
  }
  await page.locator('#called').waitFor({state: 'visible'});
  const notice = '入場前に係員へ整理券をお見せください。';
  assert.equal((await fetch(`${base}/api/operator/action`, {method: 'POST', headers, body: JSON.stringify({action: 'global_message', commandId: 'guest-notice', value: notice})})).status, 200);
  await page.locator('#globalMessage').getByText(notice).waitFor();
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'artifacts/guest-ui/ticket-called.png', fullPage: true});
  const checkin = await fetch(`${base}/api/operator/check-in`, {method: 'POST', headers, body: JSON.stringify({value: ticket.qrToken})});
  assert.equal((await checkin.json()).code, 'OK');
  await page.locator('#status.CHECKED_IN').waitFor();
  assert.equal(await page.locator('#called').isVisible(), false);
  await page.locator('#checkinNotice').waitFor({state: 'visible'});
  assert.match(await page.locator('#checkinNotice').innerText(), /入場受付が完了しました/);
  assert.equal(await page.locator('#qrCard').isVisible(), false);
  await page.waitForTimeout(500);
  await page.screenshot({path: 'artifacts/guest-ui/ticket-checked-in.png', fullPage: true});
  await page.reload();
  await page.locator('#checkinNotice').waitFor({state: 'visible'});
  assert.equal(await page.locator('#qrCard').isVisible(), false);
  // A four-person group cannot fill the remaining two seats, so it stays cancelable.
  const registration = await fetch(`${base}/api/public/register`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({requestId: 'guest-cancel-ticket', nicknames: ['来場者1', '来場者2', '来場者3', '来場者4'], partySize: 4, consent: true})});
  assert.equal(registration.status, 201);
  const waitingTicket = await registration.json();
  await page.goto(`${base}/register`);
  await page.goto(waitingTicket.ticketUrl);
  await page.locator('#cancel').click();
  await page.locator('#status.CANCELED').waitFor();
  assert.equal(await page.locator('#guestTiming').isVisible(), false);
  assert.equal(await page.locator('#qrCard').isVisible(), false);
  await page.goto(`${base}/register`);
  await page.getByLabel('参加人数').selectOption('3');
  for (const [index, name] of ['チーム甲', 'チーム乙', 'チーム丙'].entries()) await page.getByLabel(`${index + 1}人目`, {exact: true}).fill(name);
  await page.getByLabel('1人目のチーム').selectOption('B');
  await page.getByLabel('2人目のチーム').selectOption('A');
  await page.getByLabel('3人目のチーム').selectOption('B');
  await page.locator('[name=consent]').check();
  await page.getByRole('button', {name: '整理券を取得する'}).click();
  await page.waitForURL('**/ticket#*');
  await page.getByText('チーム甲：チームB / チーム乙：チームA / チーム丙：チームB').waitFor();
  await page.screenshot({path: 'artifacts/guest-ui/ticket-with-teams.png', fullPage: true});
  const teamTicket = app.queue.state.tickets.find(item => item.accessToken === new URL(page.url()).hash.slice(1));
  assert.deepEqual(teamTicket.playerTeams, ['B', 'A', 'B']);
  assert.deepEqual(errors, []);
  console.log('Guest browser E2E: PASS');
} finally {
  await browser?.close();
  await app.close();
  if (path.dirname(dataDir) === os.tmpdir() && path.basename(dataDir).startsWith('ticket-guest-browser-')) rmSync(dataDir, {recursive: true, force: true});
}
