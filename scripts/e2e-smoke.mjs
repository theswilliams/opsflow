// Browser-level smoke test against a RUNNING server, using an installed Chrome/Edge (puppeteer-core; no download).
//
//   DEMO_USER_PASSWORD=… CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" node scripts/e2e-smoke.mjs [base-url]
//
// Verifies what unit tests cannot: that the nonce-based CSP does not break hydration, and the audit's exact
// two-tab attack (F4) through the real UI. Requires the demo seed (npm run db:seed).
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:3000";
const password = process.env.DEMO_USER_PASSWORD;
const executablePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!password) {
  console.error("Set DEMO_USER_PASSWORD (from .env).");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
try {
  const context = browser.defaultBrowserContext();
  const violations = [];
  const errors = [];
  const watch = (page) => {
    page.on("console", (m) => {
      const t = m.text();
      if (/Content Security Policy|violates the following/i.test(t)) violations.push(t.slice(0, 200));
      // Resource failures are reported with URLs by the response listener below (the console text has none).
      if (m.type() === "error" && !/Failed to load resource/.test(t)) errors.push(t.slice(0, 200));
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) errors.push(`${r.status()} ${r.url()}`);
    });
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  };

  // --- sign in ---------------------------------------------------------------------------------------------
  const a = await context.newPage();
  watch(a);
  await a.goto(`${base}/login`, { waitUntil: "networkidle0" });
  await a.type("#email", "demo@opsflow.test");
  await a.type("#password", password);
  await Promise.all([a.waitForNavigation({ waitUntil: "networkidle0" }), a.click("button[type=submit]")]);
  check("sign-in works and lands on the dashboard", a.url().endsWith("/dashboard"), a.url());

  // --- hydration under the nonce CSP -----------------------------------------------------------------------
  await a.goto(`${base}/workflows/new`, { waitUntil: "networkidle0" });
  await a.click("button[role=tab]:nth-of-type(2)");
  await sleep(300);
  const selected = await a.$$eval("button[role=tab]", (els) => els.map((e) => e.getAttribute("aria-selected")));
  check("page hydrates (client-side tab switching works)", selected[1] === "true", JSON.stringify(selected));
  const csp = await a.evaluate(async () => (await fetch("/dashboard")).headers.get("content-security-policy"));
  check("CSP is enforced with a nonce and without 'unsafe-inline' for scripts", /script-src[^;]*'nonce-/.test(csp ?? "") && !/script-src[^;]*'unsafe-inline'/.test(csp ?? ""));
  check("no CSP violations on page load", violations.length === 0, violations[0]);

  // --- F4: the two-tab attack, through the UI ---------------------------------------------------------------
  await a.goto(`${base}/dashboard?q=ABC&status=REVIEW_REQUIRED`, { waitUntil: "networkidle0" });
  const href = await a.$eval("section[aria-labelledby='table-h'] a[href^='/workflows/']", (e) => e.getAttribute("href"));
  await a.goto(`${base}${href}`, { waitUntil: "networkidle0" });
  const versionA = await a.$eval("form input[name=version]", (e) => e.value);
  const addressA = await a.evaluate(() => document.body.innerText.match(/(\d+ [A-Za-z ]+(Street|Road)[^\n]*)/)?.[1] ?? "");

  const b = await context.newPage(); // "tab B": a second reviewer / second browser tab
  watch(b);
  await b.goto(`${base}${href}`, { waitUntil: "networkidle0" });
  await b.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Edit request/.test(x.textContent))?.click());
  await b.waitForSelector("input[name=address]");
  await b.$eval("input[name=address]", (e) => (e.value = ""));
  await b.type("input[name=address]", "1 Wrong Street, Toronto, Ontario");
  await b.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Save changes/.test(x.textContent))?.click());
  await b.waitForFunction(() => /Saved \d+ change/.test(document.body.innerText) || !document.querySelector("input[name=address]"), { timeout: 15_000, polling: 250 });
  await sleep(1000);
  check("tab B saved a new version", (await b.$eval("form input[name=version]", (e) => e.value)) !== versionA, `A sees v${versionA}`);

  // tab A still shows the OLD version and address; the reviewer switches back to it and clicks Approve.
  // (Background pages do not run requestAnimationFrame, so bring A to the front and poll on a timer.)
  await a.bringToFront();
  await a.evaluate(() => document.querySelector("button.btn-success")?.click());
  await a.waitForFunction(() => /changed while you were reviewing|changed after you opened it/i.test(document.body.innerText), { timeout: 15_000, polling: 250 });
  check("tab A's approval is refused with a clear 'request changed' notice", true);
  const stillReview = await a.evaluate(() => !/Approved by a person/.test(document.body.innerText) && !!document.querySelector("button.btn-success"));
  check("nothing was approved or sent", stillReview);

  // reload the latest version, then approve THAT version:
  await a.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Load the latest version/.test(x.textContent))?.click());
  await a.waitForFunction((old) => document.querySelector("form input[name=version]")?.value !== old, { timeout: 15_000, polling: 250 }, versionA);
  const addressNow = await a.evaluate(() => document.body.innerText.includes("1 Wrong Street"));
  check("after reloading, the reviewer sees the edited address", addressNow, `was: ${addressA}`);
  await a.evaluate(() => document.querySelector("button.btn-success")?.click());
  await a.waitForFunction(() => /Approved by a person/.test(document.body.innerText), { timeout: 20_000, polling: 250 });
  const confirmation = await a.evaluate(() => document.body.innerText);
  check("approving the current version completes and the confirmation carries exactly what was reviewed", /Delivery address: 1 Wrong Street, Toronto, Ontario/.test(confirmation));

  check("no unexpected console/page errors", errors.length === 0, errors[0]);
} catch (e) {
  failures++;
  console.error("FAIL  script error:", e?.message ?? e);
  for (const p of await browser.pages()) {
    const info = await p.evaluate(() => ({ url: location.pathname, alerts: [...document.querySelectorAll("[role=alert],[role=status]")].map((x) => x.innerText.slice(0, 160)), approveDisabled: document.querySelector("button.btn-success")?.disabled })).catch(() => null);
    console.error("  page:", JSON.stringify(info));
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
