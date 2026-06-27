#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBrainAdminServer, loadBrainAdminServiceConfig } from '../dist/admin-service.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function clerkStub({ signedIn, email = 'tim.galebach@gmail.com', token = 'smoke-token' }) {
  const userLiteral = signedIn
    ? `{ id: 'user_stub', primaryEmailAddressId: 'email_1', primaryEmailAddress: { emailAddress: '${email}' }, emailAddresses: [{ id: 'email_1', emailAddress: '${email}' }] }`
    : 'null';
  return `window.Clerk = {
    user: ${userLiteral},
    session: ${signedIn ? `{ getToken: async () => '${token}' }` : 'null'},
    load: async () => {},
    mountSignIn: (element, options) => {
      window.__brainAdminMountedSignIn = options;
      const button = document.createElement('button');
      button.textContent = 'Stub Clerk Sign In';
      element.appendChild(button);
    },
    signOut: async ({ redirectUrl } = {}) => { window.__brainAdminSignOutRedirect = redirectUrl || null; }
  };`;
}

async function stubClerk(page, options) {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/npm/@clerk/ui@1/dist/ui.browser.js', (route) => route.fulfill({ contentType: 'application/javascript', body: 'window.__internal_ClerkUICtor = function ClerkUI() {};' }));
  await page.route('**/npm/@clerk/clerk-js@6/dist/clerk.browser.js', (route) => route.fulfill({ contentType: 'application/javascript', body: clerkStub(options) }));
  return pageErrors;
}

async function runSignInScenario(page, baseUrl, signedIn) {
  const pageErrors = await stubClerk(page, { signedIn });
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
  await page.locator('text=Stub Clerk Sign In').waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(pageErrors, []);
}

async function runAllowedAutoContinueScenario(page, baseUrl) {
  const pageErrors = await stubClerk(page, { signedIn: true, email: 'tim.galebach@gmail.com', token: 'smoke-token' });
  await page.context().addCookies([{ name: '__session', value: 'smoke-token', url: baseUrl }]);
  await page.goto(`${baseUrl}/admin/auth/sign-in?redirect_url=${encodeURIComponent(`${baseUrl}/admin`)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(`${baseUrl}/admin`, { timeout: 5_000 });
  await page.locator('text=Brain').first().waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('button[aria-label="Open account menu"]').click();
  await page.locator('text=tim.galebach@gmail.com').first().waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(pageErrors, []);
}

async function runForbiddenSignedInScenario(page, baseUrl) {
  const pageErrors = await stubClerk(page, { signedIn: true, email: 'other@example.test', token: 'forbidden-token' });
  await page.goto(`${baseUrl}/admin/auth/sign-in?redirect_url=${encodeURIComponent(`${baseUrl}/admin`)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('text=other@example.test').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('text=Sign out / switch account').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('text=forbidden').waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(page.url(), `${baseUrl}/admin/auth/sign-in?redirect_url=${encodeURIComponent(`${baseUrl}/admin`)}`);
  assert.deepEqual(pageErrors, []);
}

async function runAdminDashboardScenario(page, baseUrl, viewport) {
  if (viewport) await page.setViewportSize(viewport);
  await page.setExtraHTTPHeaders({ authorization: 'Bearer smoke-token' });
  const pageErrors = await stubClerk(page, { signedIn: true });
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
  await page.locator('text=Brain').first().waitFor({ state: 'visible', timeout: 5_000 });
  const navScope = viewport ? '.mobile-tabs' : '.side';
  await page.locator(`${navScope} a[href="#overview"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#slack-setup"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#mission"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#slack"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#manifest"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#mode-title', { hasText: 'Slack setup required' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-setup').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#mission').waitFor({ state: 'hidden', timeout: 5_000 });
  await page.locator('button:has-text("Skip Slack for now")').first().click();
  await page.locator('#mission-title', { hasText: 'Mission Control' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#mission').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#deploy-title', { hasText: 'Deploy / Restart' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#op-approval').waitFor({ state: 'detached', timeout: 5_000 });
  await page.locator('#op-run').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#op').selectOption('restart');
  await page.locator('text=Review & confirm restart').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('button[aria-label="Open account menu"]').click();
  await page.locator('text=Sign out / switch account').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('text=/^(other@example.test|tim.galebach@gmail.com)$/').first().waitFor({ state: 'visible', timeout: 5_000 });
  if (viewport) {
    await page.locator('.mobile-tabs').waitFor({ state: 'visible', timeout: 5_000 });
  }
  const bodyText = await page.locator('body').innerText();
  assert.equal(bodyText.includes('xoxb-super-secret'), false);
  assert.deepEqual(pageErrors, []);
}

const root = await mkdtemp(path.join(tmpdir(), 'brain-admin-smoke-'));
const config = loadBrainAdminServiceConfig({
  BRAIN_ADMIN_HOST: '127.0.0.1',
  BRAIN_ADMIN_PORT: '0',
  BRAIN_ADMIN_PUBLIC_BASE_URL: '',
  CLERK_PUBLISHABLE_KEY: 'pk_test_c21va2UuY2xlcmsuYWNjb3VudHMuZGV2JA',
  CLERK_SECRET_KEY: 'sk_test_smoke',
  CLERK_ALLOWED_EMAILS: 'tim.galebach@gmail.com',
  BRAIN_CODEX_CHAT_ENV_FILE: path.join(root, 'codex-chat.env'),
  BRAIN_ADMIN_AUDIT_LOG: path.join(root, 'audit.jsonl'),
});
const server = createBrainAdminServer(config, {
  verifyTokenImpl: async (token) => ({ sub: token === 'forbidden-token' ? 'user_forbidden' : 'user_stub' }),
  getUser: async (userId) => ({ primaryEmailAddressId: 'email_1', emailAddresses: [{ id: 'email_1', emailAddress: userId === 'user_forbidden' ? 'other@example.test' : 'tim.galebach@gmail.com' }] }),
});
const baseUrl = await listen(server);
const browser = await chromium.launch({ headless: true });
try {
  await runSignInScenario(await browser.newPage(), baseUrl, false);
  await runAllowedAutoContinueScenario(await browser.newPage(), baseUrl);
  await runForbiddenSignedInScenario(await browser.newPage(), baseUrl);
  await runAdminDashboardScenario(await browser.newPage(), baseUrl);
  await runAdminDashboardScenario(await browser.newPage(), baseUrl, { width: 390, height: 844 });
  console.log(`Brain admin sign-in/dashboard smoke passed at ${baseUrl}/admin`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
