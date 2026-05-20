/**
 * E2E: manager dashboard navigation
 *
 * Exercises the Phase 1+2 navigation surface as a manager would:
 *   1. Sign in as a known manager
 *   2. Land on the operator home → switch to /dashboard
 *   3. Verify the new Live Shift block sits ABOVE the Factory Overview header
 *   4. Click the gear icon → /settings
 *   5. Click through every tab in the Settings page; verify the pane swap
 *      surfaces the right content marker for each
 *   6. Verify the Cache hit rate panel resolves (no error toast)
 *
 * The test uses a known seeded manager (sreeram.gogineni@granulesindia.com
 * / Granules123). If those creds drift, swap in any manager from the
 * hosted Supabase users table.
 */
import { resolve } from "node:path";

const PUPPETEER_PATH =
  process.env.PUPPETEER_CORE_PATH ??
  "/tmp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const CHROMIUM = process.env.PUPPETEER_EXECUTABLE ?? "/usr/bin/chromium-browser";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL ?? "sreeram.gogineni@granulesindia.com";
const MANAGER_PW = process.env.E2E_MANAGER_PW ?? "Granules123";

const puppeteer = (await import(resolve(PUPPETEER_PATH))).default;

function ok(label, cond) {
  if (!cond) throw new Error(`FAIL: ${label}`);
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
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
    await page.setCacheEnabled(false);
    page.on("pageerror", (e) => console.error("pageerror:", e.message));

    // 1. Sign in
    await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle2" });
    await page.focus('input[name="email"]');
    await page.keyboard.type(MANAGER_EMAIL);
    await page.focus('input[name="password"]');
    await page.keyboard.type(MANAGER_PW);
    await page.evaluate(() =>
      [...document.querySelectorAll("button[type=submit]")]
        .find((x) => x.textContent?.includes("Sign In"))
        ?.click(),
    );
    await new Promise((r) => setTimeout(r, 3000));
    ok(
      "manager signed in (redirected off /login)",
      !page.url().endsWith("/login"),
    );

    // 2. Navigate to /dashboard
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 2000));

    // 3. Verify Live Shift sits above Factory Overview header
    const order = await page.evaluate(() => {
      const live = document.querySelector("[data-testid='dashboard-live-shift']");
      const heading = [...document.querySelectorAll("h1")].find((h) =>
        h.textContent?.includes("Factory overview"),
      );
      if (!live || !heading) return null;
      return live.getBoundingClientRect().top < heading.getBoundingClientRect().top;
    });
    ok("Live Shift block sits ABOVE Factory Overview header", order === true);

    // 4. Gear icon → /settings
    await page.evaluate(() => {
      document.querySelector("[data-testid='nav-settings']")?.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    ok("gear icon navigated to /settings", page.url().includes("/settings"));

    // 5. Click through every tab; verify the pane changes
    const tabs = ["notifications", "thresholds", "shifts", "ai", "stats", "theme"];
    for (const t of tabs) {
      await page.evaluate((id) => {
        const btn = document.querySelector(`[data-testid='settings-tab-${id}']`);
        btn?.click();
      }, t);
      await new Promise((r) => setTimeout(r, 350));
      const paneTestId = await page.evaluate(() => {
        const el = document.querySelector("[data-testid^='settings-pane-']");
        return el?.getAttribute("data-testid") ?? null;
      });
      ok(`tab "${t}" swapped the pane`, paneTestId === `settings-pane-${t}`);
    }

    // 6. On the Stats tab the Cache hit rate panel resolves (no error)
    await page.evaluate(() => {
      document.querySelector("[data-testid='settings-tab-stats']")?.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    const cachePanel = await page.evaluate(() => {
      const sec = document.querySelector("[data-testid='cache-hit-rate-panel']");
      if (!sec) return { mounted: false };
      const errText = sec.textContent?.includes("Couldn't load");
      return { mounted: true, hasError: !!errText };
    });
    ok("cache hit rate panel mounted", cachePanel.mounted === true);
    ok("cache hit rate panel did not show an error", cachePanel.hasError === false);
  } catch (err) {
    failed = err;
  } finally {
    await browser.close();
  }

  if (failed) {
    console.error("\nFAIL", failed.message);
    process.exit(1);
  }
  console.log("\nAll manager-flow assertions passed.");
}

await main();
