import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../apps/server/main.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-projector-'));
const output = 'artifacts/projector';
mkdirSync(output, {recursive: true});
const config = {
  httpPort: 0,
  mqttPort: 0,
  operatorPin: 'projector-test-only',
  devices: [1, 2, 3, 4].map((n) => ({
    id: `gun-00${n}`,
    key: `test-${n}`,
    name: `プレイヤー${n}`,
    team: n < 3 ? 'A' : 'B',
    shooterId: n,
  })),
};
const app = await createApp({
  config,
  demo: true,
  dataDir: dir,
  bind: '127.0.0.1',
});
const base = `http://127.0.0.1:${app.httpServer.address().port}`;
let browser;
const errors = [];
const checks = [];
try {
  browser = await chromium.launch({channel: 'msedge', headless: true});
  const context = await browser.newContext({
    viewport: {width: 1920, height: 1080},
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(`${message.text()} ${message.location().url}`);
  });
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${base}/display`);
  await page.locator('.player').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() =>
      [...document.fonts].every((font) => font.status === 'loaded'),
    ),
    true,
  );
  assert.equal(
    requests.every((url) => url.startsWith(base)),
    true,
  );
  checks.push('All three fonts load locally without external requests');

  const shot = (name) => page.screenshot({path: `${output}/${name}.png`});
  await shot('lobby-1920');
  // The DOM identity must survive clock ticks for CSS animations to continue.
  await page.evaluate(() => {
    window.originalCard = document.querySelector('.player');
  });
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(
      () => window.originalCard === document.querySelector('.player'),
    ),
    true,
  );
  checks.push('Player cards persist across clock updates');
  await page.locator('#prepare').click();
  await page.waitForFunction(() =>
    document.getElementById('status').textContent.includes('準備完了'),
  );
  await page.waitForFunction(async () =>
    (await (await fetch('/api/state')).json()).players.every(
      (p) => p.connected && p.syncRtt !== null,
    ),
  );
  app.game.start(true);
  for (const count of ['3', '2', '1']) {
    await page.waitForFunction(
      (count) => document.getElementById('overlayTitle').textContent === count,
      count,
    );
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator('#overlay').getAttribute('class'),
      'mode-countdown',
    );
    await shot(`countdown-${count}`);
  }
  await page.waitForFunction(() => document.body.dataset.phase === 'ACTIVE');
  await shot('go');
  await page.locator('#startBurst').waitFor({state: 'hidden'});
  checks.push('Server-synchronized 3/2/1 and GO transition');
  app.game.s.players[0].hp = 25;
  app.game.s.players[2].hp = 0;
  app.game.s.score.A = 1;
  await page.waitForFunction(
    () => document.querySelectorAll('.hp')[2].textContent === '0',
  );
  assert.equal(await page.locator('.is-out').count(), 1);
  assert.equal(await page.locator('#scoreA').textContent(), '01');
  await shot('active-1920');
  checks.push('HP, low-health, eliminated-player and team score display');

  app.game.pause();
  await page.waitForFunction(
    () => document.getElementById('overlay').className === 'mode-paused',
  );
  await shot('paused');
  app.game.start(true);
  await page.waitForFunction(
    () => document.getElementById('overlayTitle').textContent === '3',
  );
  assert.ok(
    await page
      .locator('.title-wrap')
      .evaluate((el) =>
        el.getAnimations().some((animation) => animation.currentTime < 900),
      ),
  );
  checks.push('Resume restarts the countdown animation');
  app.game.pause();
  app.game.finish();
  await page.waitForFunction(
    () => document.getElementById('overlayTitle').textContent === 'TEAM A WIN',
  );
  await page.waitForTimeout(750);
  await shot('winner');
  app.game.s.media = 'black';
  await page.waitForFunction(
    () => document.getElementById('overlay').className === 'mode-black',
  );
  assert.equal(
    await page
      .locator('#overlay')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(0, 0, 0)',
  );
  assert.equal(
    await page
      .locator('.display-tools')
      .evaluate((el) => getComputedStyle(el).visibility),
    'hidden',
  );
  await shot('black');
  checks.push(
    'Operator blackout overrides finished state, including decorations and controls',
  );
  app.game.s.media = 'rules';
  await page.waitForFunction(
    () =>
      document.getElementById('overlayTitle').textContent ===
      '赤外線チーム対戦',
  );
  await shot('rules');
  app.game.s.media = 'score';
  app.game.s.winner = 'DRAW';
  await page.waitForFunction(
    () => document.getElementById('overlayTitle').textContent === '引き分け',
  );
  await shot('draw');
  checks.push('Rules can be displayed after a match; draw and winner layouts');

  app.game.reset({hp: 1000, durationSec: 3600});
  app.game.setPlayerNames([
    'あいうえおかきくけこさしすせそたちつてと',
    '<img src=x>',
    'ABCDEFGHIJKLMNOPQRST',
    'プレイヤー4',
  ]);
  await page.waitForFunction(
    () => document.querySelector('.hp').textContent === '1000',
  );
  assert.equal(await page.locator('.player img').count(), 0);
  for (const [width, height] of [
    [1920, 1080],
    [1280, 720],
    [1024, 768],
    [2560, 1080],
    [390, 844],
  ]) {
    await page.setViewportSize({width, height});
    await page.evaluate(() => document.fonts.ready);
    const problems = await page.evaluate(() => {
      const issues = [];
      if (
        document.documentElement.scrollWidth > innerWidth ||
        document.documentElement.scrollHeight > innerHeight
      )
        issues.push('page overflow');
      const headline = document
        .querySelector('.headline')
        .getBoundingClientRect();
      const score = document.querySelector('.score-a').getBoundingClientRect();
      if (headline.bottom > score.top)
        issues.push('headline overlaps team score');
      for (const el of document.querySelectorAll('.player')) {
        const box = el.getBoundingClientRect();
        const name = el.querySelector('h2').getBoundingClientRect();
        const hp = el.querySelector('.hp-line').getBoundingClientRect();
        if (box.bottom > innerHeight || box.right > innerWidth)
          issues.push('card outside viewport');
        if (name.bottom > hp.top + 2) issues.push('name overlaps HP');
        if (el.scrollHeight > el.clientHeight + 2)
          issues.push('card content overflow');
      }
      return issues;
    });
    assert.deepEqual(problems, [], `Layout at ${width}×${height}`);
    await shot(`layout-${width}`);
  }
  checks.push(
    '1920×1080, 1280×720, 1024×768, 2560×1080 and portrait; 20-character names, HP1000, 60-minute timer',
  );
  await page.emulateMedia({reducedMotion: 'reduce'});
  assert.equal(
    await page
      .locator('.target-ring')
      .evaluate((el) => getComputedStyle(el, '::after').animationName),
    'none',
  );
  checks.push('Reduced-motion preference disables decoration animations');
  assert.deepEqual(errors, []);
  writeFileSync(
    `${output}/result.json`,
    JSON.stringify(
      {passed: true, checkedAt: new Date().toISOString(), checks, errors},
      null,
      2,
    ),
  );
  console.log('Projector browser checks: PASS\n' + checks.join('\n'));
} finally {
  await browser?.close();
  await app.close();
  if (
    path.dirname(dir) === os.tmpdir() &&
    path.basename(dir).startsWith('arena-projector-')
  )
    rmSync(dir, {recursive: true, force: true});
}
