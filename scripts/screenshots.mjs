// Walks the demo path in a real browser and saves screenshots to docs/screenshots/ — all with the synthetic demo data.
// Also fails if the walkthrough produces a console error, page error or 4xx/5xx response.
//
//   DEMO_USER_PASSWORD=… node scripts/screenshots.mjs [base-url]     (server running, database seeded with `npm run db:seed`)
//
// Set CHROME_PATH if Chrome/Edge is not in the default Windows location. Uses puppeteer-core (no browser download).
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:3000";
const password = process.env.DEMO_USER_PASSWORD;
const executablePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!password) {
  console.error("Set DEMO_USER_PASSWORD (from .env).");
  process.exit(2);
}
const out = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const desktop = { width: 1280, height: 860, deviceScaleFactor: 1 };
const phone = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport(desktop);
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text().slice(0, 160)}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 160)}`));
  page.on("response", (r) => r.status() >= 400 && !/favicon/.test(r.url()) && problems.push(`${r.status()} ${new URL(r.url()).pathname}`));

  // `tall`: resize the viewport to the whole page so fixed/sticky chrome (the sidebar) spans the image.
  const shot = async (name, { tall = false, ...opts } = {}) => {
    await sleep(400);
    if (tall) await page.setViewport({ ...desktop, height: await page.evaluate(() => document.documentElement.scrollHeight) });
    await page.screenshot({ path: `${out}${name}.png`, ...opts });
    if (tall) await page.setViewport(desktop);
    console.log("saved", name);
  };
  const clickText = async (selector, text) => {
    const ok = await page.evaluate((sel, t) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t));
      el?.click();
      return Boolean(el);
    }, selector, text);
    if (!ok) throw new Error(`no ${selector} containing "${text}"`);
  };
  const settle = () => page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});

  await page.goto(`${base}/login`, { waitUntil: "networkidle0" });
  await shot("01-login");
  await page.type("#email", "demo@opsflow.test");
  await page.type("#password", password);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button[type=submit]")]);
  await shot("02-dashboard");

  // The primary demo request: paste, extract, review.
  await page.goto(`${base}/workflows/new`, { waitUntil: "networkidle0" });
  await clickText("button", "Delivery with ambiguous time");
  await shot("03-new-request");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), clickText("button[type=submit]", "Extract and validate")]);
  await page.waitForFunction(() => /Review required/.test(document.body.innerText), { timeout: 30000 });
  await settle();
  await shot("04-review", { tall: true });

  // Edit, save, approve.
  await clickText("button", "Edit");
  await page.waitForSelector("input[name=requested_time_start]");
  await page.evaluate(() => {
    const set = (name, value) => {
      const el = document.querySelector(`input[name=${name}]`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("requested_time_start", "09:00");
    set("requested_time_end", "11:00");
    set("contact_phone", "519-555-0142");
  });
  await clickText("button[type=submit]", "Save changes");
  await page.waitForFunction(() => !document.querySelector("input[name=requested_time_start]"), { timeout: 15000 });
  await settle();
  await clickText("button[type=submit]", "Approve");
  await page.waitForFunction(() => /SIMULATED|Simulated/.test(document.body.innerText), { timeout: 30000 });
  await settle();
  await shot("05-completed", { tall: true });

  await page.goto(`${base}/usage`, { waitUntil: "networkidle0" });
  await shot("06-ai-usage");
  await page.goto(`${base}/settings`, { waitUntil: "networkidle0" });
  await shot("07-settings", { tall: true });

  // Mobile layout.
  await page.setViewport(phone);
  await page.goto(`${base}/dashboard`, { waitUntil: "networkidle0" });
  await shot("08-dashboard-mobile", { fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) problems.push("mobile: dashboard scrolls horizontally");
} finally {
  await browser.close();
}
console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.join("\n")}` : "\nNo console errors, page errors or failed requests.");
process.exit(problems.length ? 1 : 0);
