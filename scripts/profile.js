const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

async function main() {
  const root = path.resolve(__dirname, "..");
  const extension = path.resolve(process.argv[2] || root);
  const url = process.argv[3] || "https://github.com/cli/cli/pulls";
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const marks = { firstRow: null, toolbar: null, firstStack: null, complete: null, domReady: null, loaded: null };
      window.pulltergeistProfile = marks;
      document.addEventListener("DOMContentLoaded", () => { marks.domReady = Math.round(performance.now()); });
      window.addEventListener("load", () => { marks.loaded = Math.round(performance.now()); });
      const observer = new MutationObserver(() => {
        const now = Math.round(performance.now());
        if (marks.firstRow === null && document.querySelector('[data-testid="listitem-title-link"]')) marks.firstRow = now;
        if (marks.toolbar === null && document.querySelector(".pulltergeist-toolbar")) marks.toolbar = now;
        if (marks.firstStack === null && document.querySelector(".pulltergeist-group")) marks.firstStack = now;
        const status = document.querySelector('.pulltergeist-toolbar [role="status"]');
        if (marks.complete === null && status && !status.textContent.includes("Finding")) {
          marks.complete = now;
          observer.disconnect();
        }
      });
      observer.observe(document, { childList: true, subtree: true, characterData: true });
    });
    let errors = [];
    let warnings = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "warning" || message.type() === "error") warnings.push(message.text().slice(0, 400));
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
    let requests = [];
    let start;
    page.on("request", request => {
      if (request.resourceType() !== "fetch" || !/\/pull\/\d+(\/_layout)?$/.test(new URL(request.url()).pathname)) return;
      requests.push({ path: new URL(request.url()).pathname, startMs: Date.now() - start });
    });
    const runs = [];
    for (const mode of ["cold", "reload"]) {
      requests = [];
      errors = [];
      warnings = [];
      start = Date.now();
      await cdp.send("Profiler.start");
      if (mode === "cold") await page.goto(url, { waitUntil: "domcontentloaded" });
      else await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.pulltergeistProfile?.complete != null, null, { timeout: 60000 });
      await page.waitForTimeout(750);
      const { profile } = await cdp.send("Profiler.stop");
      const nodes = new Map(profile.nodes.map(node => [node.id, node]));
      const parents = new Map(profile.nodes.flatMap(node => (node.children || []).map(child => [child, node.id])));
      const costs = new Map();
      for (let i = 0; i < (profile.samples || []).length; i++) {
        let node = nodes.get(profile.samples[i]);
        while (node && !node.callFrame.url.startsWith("chrome-extension://")) node = nodes.get(parents.get(node.id));
        if (!node) continue;
        const key = `${path.basename(node.callFrame.url)}:${node.callFrame.functionName || "anonymous"}:${node.callFrame.lineNumber + 1}`;
        costs.set(key, (costs.get(key) || 0) + profile.timeDeltas[i] / 1000);
      }
      const details = await page.evaluate(() => ({
        marks: window.pulltergeistProfile,
        status: document.querySelector('.pulltergeist-toolbar [role="status"]').textContent,
        rows: document.querySelectorAll('.pulltergeist-row').length,
        appAttributes: [...document.querySelectorAll("react-app")].map(app => Object.fromEntries([...app.attributes].map(attribute => [attribute.name, attribute.value]))),
      }));
      const run = {
        mode, ...details, requests, errors, warnings: [...new Set(warnings)],
        sampledExtensionCpuMs: Math.round([...costs.values()].reduce((a, b) => a + b, 0)),
        hotspots: [...costs].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([location, ms]) => ({ location, ms: Math.round(ms) })),
      };
      runs.push(run);
      console.log(JSON.stringify(run, null, 2));
    }
    await fs.mkdir(path.join(root, "test-results"), { recursive: true });
    await fs.writeFile(path.join(root, "test-results/profile.json"), `${JSON.stringify({ url, extension, runs }, null, 2)}\n`);
  } finally { await context.close(); }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
