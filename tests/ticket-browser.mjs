import {createRequire} from 'node:module';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
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

  browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']});
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${base}/scanner`);
  await page.locator('#loginRequired').waitFor({state: 'visible'});
  assert.equal(await page.locator('#connection').innerText(), '未ログイン');
  assert.equal(await page.locator('#scanner').isVisible(), false);
  await page.goto(`${base}/operator`);
  await page.locator('input[name="password"]').fill(operatorPassword);
  await page.getByRole('button', {name: 'ログイン'}).click();
  await page.locator('#app').waitFor({state: 'visible'});
  await page.locator('#registrationBanner').getByText('受付中', {exact: true}).waitFor();
  await page.locator('#compactRegistrationStatus').getByText('受付中', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'スマートフォンでページ全体を横スクロールさせない');
  assert.equal(await page.locator('#ticketSettings').getAttribute('open'), null);
  const order = await page.evaluate(() => {
    const top = (selector) => document.querySelector(selector).getBoundingClientRect().top;
    return top('#callNext') < top('#delayPanel') && top('#delayPanel') < top('#tickets') && top('#noticePanel') < top('#tickets');
  });
  assert.equal(order, true, '呼出・調整・案内を整理券一覧より上に配置する');
  const messageInput = page.locator('#messageForm textarea[name="message"]');
  await messageInput.fill('入力途中の全体連絡');
  const secondRegistration = await fetch(`${base}/api/public/register`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({requestId: 'ticket-browser-second-registration', nicknames: ['追加'], partySize: 1, consent: true}),
  });
  const secondTicket = await secondRegistration.json();
  await page.waitForTimeout(300);
  assert.equal(await messageInput.inputValue(), '入力途中の全体連絡');
  const callNext = page.getByRole('button', {name: /次の.*呼び出/});
  if (await callNext.isEnabled()) await callNext.click();
  await page.locator('#queueTimeline .timeline-round.called').waitFor();
  mkdirSync('artifacts/operator-ui', {recursive: true});
  await page.screenshot({path: 'artifacts/operator-ui/ticket-mobile.png', fullPage: true});
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: 'artifacts/operator-ui/ticket-desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: '調整枠を1枠追加'}).click();
  await page.locator('#delaySummary').getByText('調整中：残り1枠（15分）', {exact: true}).waitFor();
  await page.locator('#queueTimeline').getByText('調整・使用なし', {exact: true}).waitFor();
  await page.locator('#queueTimeline .timeline-round.scheduled').waitFor();
  assert.equal(await page.locator('#queueTimeline .timeline-round.called').count(), 0);
  const timelineStates = await page.locator('#queueTimeline .timeline-round').evaluateAll((nodes) => nodes.map((node) => node.className));
  assert.match(timelineStates[0], /delayed_empty/);
  assert.ok(timelineStates.findIndex((className) => className.includes('scheduled')) > 0);
  assert.match(await messageInput.inputValue(), /1枠（15分）遅れ/);
  assert.match(await messageInput.inputValue(), /変更される場合があります/);
  await page.locator('#nextAction').getByText(/先頭に1枠の調整枠/).waitFor();

  const timeline = page.locator('#queueTimeline');
  await timeline.evaluate((node) => { node.scrollLeft = 120; });
  await fetch(`${base}/api/public/register`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({requestId: 'ticket-browser-scroll-registration', nicknames: ['スクロール確認'], partySize: 1, consent: true}),
  });
  await page.waitForTimeout(300);
  assert.ok((await timeline.evaluate((node) => node.scrollLeft)) <= 1);

  await page.getByRole('button', {name: '調整枠を解除'}).click();
  await page.locator('#delaySummary').getByText('調整枠なし', {exact: true}).waitFor();
  await page.locator('#queueTimeline .timeline-round.called').waitFor();
  assert.notEqual(
    await page.locator('#queueTimeline .timeline-round.called').evaluate((node) => getComputedStyle(node).position),
    'sticky',
    '再呼出後のカードを固定表示にして後続カードへ重ねない',
  );

  await page.goto(`${base}/scanner`);
  await page.locator('#scanner').waitFor({state: 'visible'});
  assert.equal(await page.locator('#stop').isDisabled(), true);
  await page.screenshot({path: 'artifacts/operator-ui/scanner-mobile.png', fullPage: true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: 'artifacts/operator-ui/scanner-desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#start').click();
  await page.locator('#cameraStatus').getByText('読み取り中', {exact: true}).waitFor();
  assert.equal(await page.locator('#start').isDisabled(), true);
  assert.equal(await page.locator('#cameraPlaceholder').isVisible(), false);
  await page.evaluate(() => { window.testCameraTrack = document.querySelector('#video').srcObject.getVideoTracks()[0]; });
  await page.locator('#stop').click();
  assert.equal(await page.evaluate(() => window.testCameraTrack.readyState), 'ended');
  assert.equal(await page.locator('#start').isEnabled(), true);
  assert.equal(await page.locator('#cameraStatus').innerText(), 'カメラ停止中');
  await page.locator('input[name="token"]').fill('invalid-qr-token');
  await page.getByRole('button', {name: '入場を確認', exact: true}).click();
  await page.locator('#result').getByText('無効な整理券', {exact: true}).waitFor();
  await page.waitForFunction(() => document.querySelector('input[name="token"]').value === '');
  await page.goto(`${base}/scanner#AKASHI:${ticket.qrToken}`);
  await page.reload();
  await page.locator('#scanSuccess').waitFor({state: 'visible'});
  await assert.doesNotReject(() => page.getByRole('heading', {name: '読み取り成功'}).waitFor());
  await assert.doesNotReject(() => page.locator('#scanSuccessTicket').getByText(ticket.ticketNumber).waitFor());
  assert.equal(await page.locator('#scanSuccess').evaluate((node) => getComputedStyle(node).position), 'fixed');
  assert.equal(await page.locator('#nextScan').evaluate((node) => document.activeElement === node), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#nextScan').evaluate((node) => document.activeElement === node), true);
  await page.screenshot({path: 'artifacts/operator-ui/scanner-success-mobile.png', fullPage: true});
  await page.getByRole('button', {name: '次のQRコードを読み取る'}).click();
  await page.locator('#scanSuccess').waitFor({state: 'hidden'});
  await page.locator('input[name="token"]').fill(`AKASHI:${ticket.qrToken}`);
  await page.getByRole('button', {name: '入場を確認', exact: true}).click();
  await page.locator('#result').getByText(/入場処理済み/).waitFor();
  await page.waitForFunction(() => document.querySelector('input[name="token"]').value === '');
  assert.equal(await page.locator('#scanSuccess').isVisible(), false);
  await page.locator('#start').click();
  await page.locator('#cameraStatus').getByText('読み取り中', {exact: true}).waitFor();
  await page.locator('input[name="token"]').fill(`AKASHI:${secondTicket.qrToken}`);
  await page.getByRole('button', {name: '入場を確認', exact: true}).click();
  await page.locator('#scanSuccess').waitFor({state: 'visible'});
  assert.equal(await page.locator('#cameraStatus').innerText(), '次の読み取り待ち');
  await page.locator('#nextScan').click();
  await page.locator('#cameraStatus').getByText('読み取り中', {exact: true}).waitFor();
  await page.locator('#stop').click();
  assert.deepEqual(pageErrors, []);
  console.log('Ticket browser E2E: PASS');
} finally {
  await browser?.close();
  await app.close();
  if (path.dirname(dataDir) === os.tmpdir() && path.basename(dataDir).startsWith('ticket-browser-')) rmSync(dataDir, {recursive: true, force: true});
}
