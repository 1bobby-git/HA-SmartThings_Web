import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { KeeperPageManager, KEEPER_URL } from "../dist/bridge/src/browser/keeper-page.js";

// Entirely synthetic: all browser requests are intercepted, no user profile or account is used.
const root = await mkdtemp(join(tmpdir(), "stw-ci-lifecycle-"));
let context;
const configure = async (ctx) => {
  await ctx.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://my.smartthings.com") {
      await route.abort();
      return;
    }
    if (url.pathname === "/advanced") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic keeper</title>" });
  });
};
try {
  context = await chromium.launchPersistentContext(root, { headless: true });
  await configure(context);
  await context.addCookies([{
    name: "bridge_ci_session", value: "synthetic-only", url: KEEPER_URL,
    httpOnly: true, secure: true, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600
  }]);
  const before = await context.cookies();
  const manager = new KeeperPageManager(context);
  const pages = await Promise.all(Array.from({ length: 40 }, () => manager.ensureKeeper()));
  assert.equal(new Set(pages).size, 1);
  assert.equal(context.pages().length, 1);
  await assert.rejects(manager.openAdvancedPage());
  assert.equal(context.pages().length, 1);
  assert.deepEqual(await context.cookies(), before);
  await context.close();
  context = await chromium.launchPersistentContext(root, { headless: true });
  await configure(context);
  assert.deepEqual(await context.cookies(), before);
  const restored = new KeeperPageManager(context);
  await Promise.all(Array.from({ length: 20 }, () => restored.ensureKeeper()));
  assert.equal(context.pages().length, 1);
  assert.deepEqual(await context.cookies(), before);
  console.log(JSON.stringify({
    synthetic: true, concurrentKeeperCallers: 40, keeperPages: 1,
    failedAdvancedTabCleaned: true, persistentCookiesPreserved: true,
    realAccountTested: false
  }));
} finally {
  await context?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
