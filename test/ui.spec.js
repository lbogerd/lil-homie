import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { createApp } from '../server.js';
let app, dir;
const origin = 'http://127.0.0.1:3216';
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lh-ui-'));
  app = createApp({ dataDir: dir, allowedUser: 'lucas', origin, send: async () => {} });
  // Emulate the trusted proxy for every request, including service-worker script fetches.
  app.server.prependListener('request', req => { req.headers['remote-user'] = 'lucas'; });
  await new Promise(r => app.server.listen(3216, '127.0.0.1', r));
});
test.afterAll(async () => { await new Promise(r => app.server.close(r)); app.close(); rmSync(dir, { recursive: true, force: true }); });
test.use({ viewport: { width: 430, height: 932 }, extraHTTPHeaders: { 'Remote-User': 'lucas' } });
async function mockPush(page, denied = false) {
  const key = createECDH('prime256v1'); key.generateKeys();
  const subscription = { endpoint: 'https://web.push.apple.com/ui-test', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  await page.addInitScript(({ subscription, denied }) => {
    let permission = 'default', sub = null;
    Object.defineProperty(Notification, 'permission', { get: () => permission });
    Notification.requestPermission = async () => { window.permissionRequests = (window.permissionRequests || 0) + 1; permission = denied ? 'denied' : 'granted'; return permission; };
    PushManager.prototype.getSubscription = async () => sub;
    PushManager.prototype.subscribe = async () => sub = { toJSON: () => subscription, unsubscribe: async () => { sub = null; return true; } };
  }, { subscription, denied });
}
test('mobile page opt-in, schedule, stop, re-enable and manual observation (simulated push)', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await mockPush(page); await page.goto(origin);
  await expect(page.locator('#enable')).toBeEnabled();
  expect(await page.evaluate(() => window.permissionRequests || 0)).toBe(0);
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.locator('#subscription')).toHaveText('Enabled');
  await page.getByRole('button', { name: 'Send in 30s', exact: true }).click();
  await expect(page.locator('#results')).toContainText('queued');
  await page.getByRole('button', { name: 'Stop notifications', exact: true }).click();
  await expect(page.locator('#subscription')).toHaveText('Stopped');
  await expect(page.locator('#results')).toContainText('cancelled');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.locator('#subscription')).toHaveText('Enabled');
  await page.getByRole('button', { name: 'Send test', exact: true }).click();
  await expect(page.locator('#results')).toContainText('Immediate · queued');
  await app.tick(); await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.locator('#results')).toContainText('accepted');
  await expect(page.locator('#results')).not.toContainText('You reported');
  await page.getByRole('button', { name: 'I saw it', exact: true }).click();
  await expect(page.locator('#results')).toContainText('You reported');
  await page.getByText('More test scenarios', { exact: true }).click();
  await page.getByRole('button', { name: 'Test denial', exact: true }).click();
  await expect(page.locator('#guide')).toContainText('different from denying the first prompt');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
test('denial disables send, reports recovery and does not prompt again (simulated permission)', async ({ page }) => {
  await mockPush(page, true); await page.goto(origin);
  await expect(page.locator('#enable')).toBeEnabled();
  await page.locator('#enable').click();
  await expect(page.locator('#permission')).toHaveText('denied');
  await expect(page.locator('#subscription')).toHaveText('Stopped');
  await expect(page.getByRole('button', { name: 'Send test', exact: true })).toBeDisabled();
  await page.locator('#enable').click();
  await expect(page.locator('#message')).toContainText('Settings');
  expect(await page.evaluate(() => window.permissionRequests)).toBe(1);
});
