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
  assert.equal(await page.title(), 'Brain');
  const navScope = viewport ? '#mobile-section-menu' : '.side[data-app-area="control-plane"]';
  if (viewport) {
    await page.locator('#mobile-section-menu').waitFor({ state: 'hidden', timeout: 5_000 });
    await page.locator('button[aria-label="Open admin section menu"]').click();
    await page.locator('#mobile-section-menu').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#mobile-section-menu', { hasText: 'Control Plane sections' }).waitFor({ state: 'visible', timeout: 5_000 });
  }
  await page.locator(`${navScope} a[href="#overview"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#slack-setup"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#mission"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#openrouter"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#slack"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#manifest"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#env"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#deploy"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#audit"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${navScope} a[href="#advanced"]`).waitFor({ state: 'visible', timeout: 5_000 });
  if (viewport) {
    await page.locator(`${navScope} a[href="#overview"]`).click();
    await page.locator('#mobile-section-menu').waitFor({ state: 'hidden', timeout: 5_000 });
  }

  await page.locator('#app-area-capabilities-users').click();
  await page.locator('#admin-shell[data-app-area="capabilities-users"]').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#app-area-capabilities-users[aria-pressed="true"]').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#cap-users').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#overview').waitFor({ state: 'hidden', timeout: 5_000 });
  const capNavScope = viewport ? '#mobile-section-menu' : '.side[data-app-area="capabilities-users"]';
  if (viewport) {
    await page.locator('button[aria-label="Open admin section menu"]').click();
    await page.locator('#mobile-section-menu', { hasText: 'Capabilities & Users sections' }).waitFor({ state: 'visible', timeout: 5_000 });
  }
  await page.locator(`${capNavScope} a[href="#cap-overview"]`).waitFor({ state: 'detached', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-users"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-identities"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-grants"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-catalog"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-audit"]`).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#capabilities-status', { hasText: 'V2 identity/capability store loaded' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('[data-compact-capabilities-overview="true"]').waitFor({ state: 'detached', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-users"]`, { hasText: 'Users (1)' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-identities"]`, { hasText: 'Identities (2)' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-grants"]`, { hasText: 'Grants (25)' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator(`${capNavScope} a[href="#cap-catalog"]`, { hasText: 'Catalog (8/26)' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#capabilities-identities table[data-compact-identities="true"]', { hasText: 'Proof source' }).waitFor({ state: 'visible', timeout: 5_000 });
  const timUser = page.locator('#capabilities-people details[data-capability-user="person_tim"]');
  await timUser.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await timUser.evaluate((element) => element.open), false);
  await timUser.locator(':scope > summary').click();
  await timUser.locator('text=Linked identities').waitFor({ state: 'visible', timeout: 5_000 });
  const projectsGroup = page.locator('#capabilities-catalog details[data-capability-group="projects"]');
  await projectsGroup.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await projectsGroup.evaluate((element) => element.open), false);
  await projectsGroup.locator(':scope > summary').click();
  assert.equal(await projectsGroup.evaluate((element) => element.open), true);
  await projectsGroup.locator('tbody tr', { hasText: 'Write project files' }).waitFor({ state: 'visible', timeout: 5_000 });
  await projectsGroup.locator('td[data-label="Source grant / bundle"]', { hasText: 'direct projects.files.write' }).first().waitFor({ state: 'visible', timeout: 5_000 });
  await projectsGroup.locator('text=Project resources').waitFor({ state: 'visible', timeout: 5_000 });
  await projectsGroup.locator('tbody tr', { hasText: 'Work/Business Travel' }).waitFor({ state: 'visible', timeout: 5_000 });
  await projectsGroup.locator('td[data-label="files"]', { hasText: 'project:*' }).first().waitFor({ state: 'visible', timeout: 5_000 });
  if (viewport) {
    await page.locator('button[aria-label="Open admin section menu"]').click();
    await page.locator('#mobile-section-menu', { hasText: 'Capabilities & Users sections' }).waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator(`${capNavScope} a[href="#cap-users"]`).click();
    await page.locator('#mobile-section-menu').waitFor({ state: 'hidden', timeout: 5_000 });
  }
  await page.locator('#app-area-control-plane').click();
  await page.locator('#admin-shell[data-app-area="control-plane"]').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#overview').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#cap-users').waitFor({ state: 'hidden', timeout: 5_000 });

  await page.locator('#mode-title').filter({ hasText: /Slack setup wizard: Slack (setup required|partially configured)/ }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-setup').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-setup.setup-primary').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-app-settings-wizard-link', { hasText: 'Open Slack App Settings' }).waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await page.locator('#slack-app-settings-wizard-link').getAttribute('href'), 'https://api.slack.com/apps');
  await page.locator('#slack-app-settings-wizard-url', { hasText: 'https://api.slack.com/apps' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-wizard', { hasText: 'Configure Event Subscriptions inside Slack' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-wizard', { hasText: 'no trailing slash' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-wizard', { hasText: 'I configured this inside Slack, not only in Brain' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-wizard a:has-text("Open Slack App Settings")').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#mission').waitFor({ state: 'hidden', timeout: 5_000 });
  await page.locator('button:has-text("Skip Slack for now")').first().click();
  await page.locator('#mission-title', { hasText: 'Mission Control' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#mission').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#deploy-title', { hasText: 'Deploy / Restart' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-preset').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-apply', { hasText: 'Save changes / Apply model preset' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-preset-status', { hasText: 'Current active preset' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-preset-status', { hasText: 'Pending selection' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-preset-status', { hasText: 'Restart required after save' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-preset').selectOption('openrouter-glm-5.2');
  await page.locator('#main-model-apply').click();
  await page.locator('#main-model-confirm-modal').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-confirm-summary', { hasText: 'OpenRouter GLM 5.2' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-confirm-summary', { hasText: 'codex-chat restart required' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#main-model-confirm-modal button:has-text("Cancel")').click();
  await page.locator('#main-model-confirm-modal').waitFor({ state: 'hidden', timeout: 5_000 });
  await page.locator('#op-approval').waitFor({ state: 'detached', timeout: 5_000 });
  await page.locator('#slack-approval').waitFor({ state: 'detached', timeout: 5_000 });
  await page.locator('summary:has-text("Update Slack settings")').click();
  await page.locator('#slack-SLACK_BOT_TOKEN').fill('xoxb-super-secret');
  await page.locator('button:has-text("Review & write Slack settings")').click();
  await page.locator('#slack-confirm-modal').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-confirm-title', { hasText: 'Confirm Slack settings write' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-confirm-keys', { hasText: 'SLACK_BOT_TOKEN' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-confirm-keys', { hasText: 'write-only secret' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#slack-confirm-summary', { hasText: 'Runtime env file' }).waitFor({ state: 'visible', timeout: 5_000 });
  const confirmText = await page.locator('#slack-confirm-modal').innerText();
  assert.equal(confirmText.includes('xoxb-super-secret'), false);
  await page.locator('#slack-confirm-button').click();
  await page.locator('#slack-result', { hasText: 'Slack settings written' }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#op-run').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#op').selectOption('restart');
  await page.locator('text=Review & confirm restart').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('button[aria-label="Open account menu"]').click();
  await page.locator('text=Sign out / switch account').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('text=/^(other@example.test|tim.galebach@gmail.com)$/').first().waitFor({ state: 'visible', timeout: 5_000 });
  if (viewport) {
    await page.locator('.mobile-tabs').first().waitFor({ state: 'hidden', timeout: 5_000 });
    await page.locator('.mobile-tabs').nth(1).waitFor({ state: 'hidden', timeout: 5_000 });
    await page.locator('button[aria-label="Open admin section menu"]').waitFor({ state: 'visible', timeout: 5_000 });
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
