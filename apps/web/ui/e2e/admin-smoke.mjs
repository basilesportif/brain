#!/usr/bin/env node
// Playwright smoke for the React `/admin` console (plan §8 step 7).
//
// It builds the UI, starts the Brain admin service against a throwaway temp-dir
// fixture (never touching ~/.brain or any live store), and asserts:
//   1. the SPA shell loads and the static handler serves the built app;
//   2. all five routes deep-link (SPA history fallback returns the shell);
//   3. `/admin-v2` redirects preserve path suffixes for old bookmarks;
//   4. `/admin-legacy` is gone and does not fall into the SPA;
//   5. an unbuilt console returns the 503 "not built" page.
//
// AUTH LIMITATION (documented): the `/admin` shell is served unauthenticated
// so Clerk can boot client-side, but authenticating a real browser session
// requires Clerk's hosted JS + a real session, which is unavailable in this
// sandbox. So the browser-level check asserts the shell mounts (#root + injected
// config + title) rather than a signed-in console; the HTTP-level checks below
// fully cover static serving, SPA fallback, and the 503 path. The gated API
// stays fail-closed server-side regardless of what the SPA renders.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import { ADMIN_SPA_ROUTE_PATH, ADMIN_V2_REDIRECT_ROUTE_PATH } from "../../dist/admin-routes.js";
import { createBrainAdminServer, loadBrainAdminServiceConfig } from "../../dist/admin-service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "..");
const distDir = path.join(uiRoot, "dist");

const ROUTES = [
  ADMIN_SPA_ROUTE_PATH,
  `${ADMIN_SPA_ROUTE_PATH}/setup`,
  `${ADMIN_SPA_ROUTE_PATH}/settings`,
  `${ADMIN_SPA_ROUTE_PATH}/users`,
  `${ADMIN_SPA_ROUTE_PATH}/operations`,
];
// A valid-format Clerk test publishable key so the shell injects it (no network
// call is made by these checks; the browser check tolerates Clerk not booting).
const CLERK_PK = "pk_test_c21va2UuY2xlcmsuYWNjb3VudHMuZGV2JA";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function makeConfig(root, adminUiDir) {
  return loadBrainAdminServiceConfig({
    BRAIN_ADMIN_HOST: "127.0.0.1",
    BRAIN_ADMIN_PORT: "0",
    BRAIN_ADMIN_PUBLIC_BASE_URL: "",
    CLERK_PUBLISHABLE_KEY: CLERK_PK,
    CLERK_SECRET_KEY: "sk_test_smoke",
    CLERK_ALLOWED_EMAILS: "smoke@example.com",
    BRAIN_CODEX_CHAT_ENV_FILE: path.join(root, "codex-chat.env"),
    BRAIN_ADMIN_AUDIT_LOG: path.join(root, "audit.jsonl"),
    BRAIN_CAPABILITY_STORE_PATH: path.join(root, "capabilities.json"),
    BRAIN_SLACK_SETUP_STATE_PATH: path.join(root, "slack-setup.json"),
    BRAIN_ADMIN_UI_DIR: adminUiDir,
  });
}

const authDeps = {
  verifyTokenImpl: async () => ({ sub: "user_smoke" }),
  getUser: async () => ({ primaryEmailAddressId: "email_1", emailAddresses: [{ id: "email_1", emailAddress: "smoke@example.com" }] }),
};

async function main() {
  // 1. Build the UI so the static handler has real assets to serve.
  await build({ root: uiRoot, logLevel: "warn" });

  const builtRoot = await mkdtemp(path.join(tmpdir(), "brain-admin-smoke-"));
  const unbuiltRoot = await mkdtemp(path.join(tmpdir(), "brain-admin-unbuilt-"));
  const emptyDist = path.join(unbuiltRoot, "empty-dist");
  await mkdir(emptyDist, { recursive: true });

  const builtServer = createBrainAdminServer(makeConfig(builtRoot, distDir), authDeps);
  const unbuiltServer = createBrainAdminServer(makeConfig(unbuiltRoot, emptyDist), authDeps);
  const baseUrl = await listen(builtServer);
  const unbuiltUrl = await listen(unbuiltServer);

  const browser = await chromium.launch({ headless: true });
  try {
    // 2. Shell + SPA history fallback for all five routes (HTTP level).
    for (const route of ROUTES) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200, `${route} should serve the SPA shell`);
      const html = await res.text();
      assert.ok(html.includes('<div id="root">'), `${route} shell missing #root`);
      assert.ok(html.includes("window.__BRAIN_UI_CONFIG__"), `${route} shell missing injected config`);
      assert.ok(html.includes(CLERK_PK), `${route} shell missing publishable key`);
    }

    // 3. Old `/admin-v2` bookmarks are permanent redirects to `/admin`.
    const oldRoute = await fetch(`${baseUrl}${ADMIN_V2_REDIRECT_ROUTE_PATH}/users?tab=grants`, { redirect: "manual" });
    assert.equal(oldRoute.status, 308, "admin-v2 deep link should redirect permanently");
    assert.equal(oldRoute.headers.get("location"), `${ADMIN_SPA_ROUTE_PATH}/users?tab=grants`);

    // 4. The old server-rendered console is removed and must not receive the SPA.
    const legacy = await fetch(`${baseUrl}/admin-legacy`, { headers: { authorization: "Bearer smoke-token" } });
    assert.equal(legacy.status, 404, "legacy console should be removed");
    const legacyBody = await legacy.text();
    assert.equal(legacyBody.includes("window.__BRAIN_UI_CONFIG__"), false, "legacy path must not receive SPA shell");

    // 5. Unbuilt console returns the 503 "not built" page (no path leak).
    const unbuilt = await fetch(`${unbuiltUrl}${ADMIN_SPA_ROUTE_PATH}`);
    assert.equal(unbuilt.status, 503, "unbuilt console should 503");
    const unbuiltHtml = await unbuilt.text();
    assert.ok(unbuiltHtml.includes("not built"), "503 page should explain the console is not built");
    assert.ok(unbuiltHtml.includes(ADMIN_SPA_ROUTE_PATH), "503 page should name the SPA mount");
    assert.equal(unbuiltHtml.includes("/admin-legacy"), false, "503 page must not advertise a legacy fallback");
    assert.equal(unbuiltHtml.includes(emptyDist), false, "503 page must not leak the build path");

    // 6. Browser: the shell mounts (see AUTH LIMITATION above).
    const page = await browser.newPage();
    // Avoid hanging on Clerk's hosted JS (unreachable in the sandbox).
    await page.route("**/*clerk*.js", (route) => route.abort());
    await page.route("**/@clerk/**", (route) => route.abort());
    await page.goto(`${baseUrl}${ADMIN_SPA_ROUTE_PATH}`, { waitUntil: "domcontentloaded" });
    assert.equal(await page.title(), "Brain", "shell document title");
    await page.locator("#root").waitFor({ state: "attached", timeout: 5_000 });
    const injected = await page.evaluate(() => window.__BRAIN_UI_CONFIG__);
    assert.ok(injected && injected.clerkPublishableKey === CLERK_PK, "injected UI config present in browser");
    assert.equal(injected.routePath, ADMIN_SPA_ROUTE_PATH, "SPA route path");
    assert.equal(injected.signInUrl, ADMIN_SPA_ROUTE_PATH, "SPA sign-in URL");
    await page.close();

    console.log(`admin smoke passed: shell + 5 routes + redirects + no legacy + 503 at ${baseUrl}${ADMIN_SPA_ROUTE_PATH}`);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => builtServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => unbuiltServer.close((error) => (error ? reject(error) : resolve())));
    await rm(builtRoot, { recursive: true, force: true });
    await rm(unbuiltRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
