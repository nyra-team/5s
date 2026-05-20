/**
 * E2E: signup → forgot-password → reset → login
 *
 * Exercises the full auth surface end-to-end:
 *   1. Open /login, switch to signup, create a fresh user (unique email
 *      per run so reruns don't collide on the email-unique constraint)
 *   2. Sign out (clear localStorage; the UI doesn't currently offer a
 *      logout button on operator pages immediately after signup)
 *   3. Use Forgot password? — the success card surfaces a dev-mode reset
 *      URL inline. Click it.
 *   4. Set a new password, get redirected to /login
 *   5. Sign in with the new password, land on operator home
 *
 * Each assertion is wrapped in a small helper that throws with a clear
 * label so the spec exits non-zero on the FIRST failure (the parent
 * process forwards the exit code via pnpm).
 *
 * Run via:
 *   node artifacts/five-s/e2e/auth-flow.mjs
 * Requires the dev stack to be running (./start.sh).
 */

import { resolve } from "node:path";

// puppeteer-core lives in the monorepo's hoisted node_modules but isn't a
// direct dep of any workspace; resolve it via a path the user can override.
const PUPPETEER_PATH =
  process.env.PUPPETEER_CORE_PATH ??
  "/tmp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const CHROMIUM = process.env.PUPPETEER_EXECUTABLE ?? "/usr/bin/chromium-browser";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const puppeteer = (await import(resolve(PUPPETEER_PATH))).default;

function ok(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  let failed = null;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.setCacheEnabled(false);

    const errs = [];
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));

    const stamp = Date.now();
    const email = `e2e-auth-${stamp}@test.local`;
    const initialPw = "InitialPw#$1";
    const newPw = "FreshSecret#$2";

    // 1. Signup
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2" });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => x.textContent?.trim() === "Create one",
      );
      b?.click();
    });
    await page.waitForSelector('input[name="displayName"]', { timeout: 4000 });
    await page.focus('input[name="displayName"]');
    await page.keyboard.type("E2E Tester");
    await page.focus('input[name="email"]');
    await page.keyboard.type(email);
    await page.focus('input[name="password"]');
    await page.keyboard.type(initialPw);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button[type=submit]")].find(
        (x) => x.textContent?.includes("Create account"),
      );
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 3000));
    ok("signup redirected away from /login", !page.url().endsWith("/login"));
    ok(
      "signup set a token in localStorage",
      !!(await page.evaluate(() => localStorage.getItem("token"))),
    );

    // 2. Sign out by clearing the token, return to /login
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2" });

    // 3. Forgot password — surface dev reset URL
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => x.textContent?.trim() === "Forgot password?",
      );
      b?.click();
    });
    await page.waitForSelector('input[name="email"]', { timeout: 4000 });
    await page.focus('input[name="email"]');
    await page.keyboard.type(email);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button[type=submit]")].find(
        (x) => x.textContent?.includes("Send reset link"),
      );
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 2500));
    const resetUrl = await page.evaluate(() => {
      const a = [...document.querySelectorAll("a")].find((x) =>
        (x.getAttribute("href") ?? "").includes("/reset-password?token="),
      );
      return a?.getAttribute("href") ?? null;
    });
    ok("forgot-password surfaced a dev reset URL", !!resetUrl);

    // 4. Open reset URL → set new password → land on /login
    await page.goto(resetUrl, { waitUntil: "networkidle2" });
    const pwInputs = await page.$$('input[type="password"]');
    ok("reset page has new+confirm password inputs", pwInputs.length === 2);
    await pwInputs[0].focus();
    await page.keyboard.type(newPw);
    await pwInputs[1].focus();
    await page.keyboard.type(newPw);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button[type=submit]")].find(
        (x) => x.textContent?.includes("Update"),
      );
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 2500));
    ok(
      "reset redirected back to /login",
      page.url().endsWith("/login"),
    );

    // 5. Sign in with new password
    await page.focus('input[name="email"]');
    await page.keyboard.type(email);
    await page.focus('input[name="password"]');
    await page.keyboard.type(newPw);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button[type=submit]")].find(
        (x) => x.textContent?.includes("Sign In"),
      );
      b?.click();
    });
    await new Promise((r) => setTimeout(r, 3000));
    ok(
      "login with new password redirected away from /login",
      !page.url().endsWith("/login"),
    );

    ok("no page errors thrown during the run", errs.length === 0);
  } catch (err) {
    failed = err;
  } finally {
    await browser.close();
  }

  if (failed) {
    console.error("\nFAIL", failed.message);
    process.exit(1);
  }
  console.log("\nAll auth-flow assertions passed.");
}

await main();
