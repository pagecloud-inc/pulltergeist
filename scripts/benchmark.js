const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { repo, origin, chainPulls, listHtml, pullPayload, pullHtml } = require("../tests/fixtures.js");

async function measure(extension) {
  const items = chainPulls(8, 17);
  const latency = 120;
  const htmlPadding = 200000;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const marks = { firstStackMs: null, completeMs: null };
      window.pulltergeistBenchmark = marks;
      new MutationObserver(() => {
        if (marks.firstStackMs === null && document.querySelector(".pulltergeist-group")) marks.firstStackMs = Math.round(performance.now());
        const status = document.querySelector('.pulltergeist-toolbar [role="status"]');
        if (marks.completeMs === null && status && !status.textContent.includes("Finding")) marks.completeMs = Math.round(performance.now());
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    let requests = 0;
    let bytes = 0;
    await page.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url());
      const match = url.pathname.match(/\/pull\/(\d+)(\/_layout)?$/);
      if (!match) {
        await route.fulfill({ contentType: "text/html", body: listHtml({ items, hints: true }) });
        return;
      }
      requests++;
      const item = items.find(pull => pull.number === Number(match[1]));
      const body = match[2] ? JSON.stringify(pullPayload(item, items)) : pullHtml(item, items, htmlPadding);
      bytes += Buffer.byteLength(body);
      await new Promise(resolve => setTimeout(resolve, latency));
      await route.fulfill({ contentType: match[2] ? "application/json" : "text/html", body });
    });
    const results = [];
    for (const mode of ["cold", "reload"]) {
      requests = 0;
      bytes = 0;
      if (mode === "cold") await page.goto(`${origin}${repo}/pulls`);
      else await page.reload();
      await page.waitForFunction(() => window.pulltergeistBenchmark.firstStackMs !== null && window.pulltergeistBenchmark.completeMs !== null);
      const { firstStackMs, completeMs } = await page.evaluate(() => window.pulltergeistBenchmark);
      results.push({ mode, firstStackMs, completeMs, metadataRequests: requests, responseBytes: bytes });
    }
    return results;
  } finally {
    await context.close();
  }
}

async function main() {
  const current = path.resolve(__dirname, "..");
  const targets = process.argv[2] ? [{ name: "before", directory: path.resolve(process.argv[2]) }, { name: "after", directory: current }]
    : [{ name: "current", directory: current }];
  const report = { fixture: "25 PRs, one 8-PR native stack, 120ms/request, HTML padded by 200KB", runs: [] };
  for (const target of targets) {
    for (let sample = 1; sample <= 3; sample++) {
      const results = await measure(target.directory);
      report.runs.push({ name: target.name, sample, results });
      console.log(target.name, sample, JSON.stringify(results));
    }
  }
  await fs.mkdir(path.join(current, "test-results"), { recursive: true });
  await fs.writeFile(path.join(current, "test-results/benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
