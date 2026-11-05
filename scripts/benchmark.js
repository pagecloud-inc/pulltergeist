const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { repo, origin, chainPulls, multipleStackPulls, manualStackPulls, listHtml, pullPayload, pullHtml } = require("../tests/fixtures.js");

const scenarios = [
  { name: "native-stack", items: () => chainPulls(8, 17) },
  { name: "manual-stack", items: manualStackPulls },
  { name: "multiple-native-stacks", items: multipleStackPulls },
  { name: "client-navigation", items: () => chainPulls(8, 17), clientNavigation: true },
  { name: "react-replacement", items: () => chainPulls(8, 17), replaceRows: true },
  { name: "slow-page-assets", items: () => chainPulls(8, 17), slowAsset: true },
  { name: "passive-pr-page", items: () => chainPulls(), passive: true },
  { name: "intent-prewarming", items: () => chainPulls(), prewarm: true },
];

async function measure(extension, scenario) {
  const items = scenario.items();
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let world;
    let resolveWorld;
    const worldReady = new Promise(resolve => { resolveWorld = resolve; });
    cdp.on("Runtime.executionContextCreated", ({ context }) => {
      if (context.name === "Pulltergeist") { world = context.id; resolveWorld(); }
    });
    await cdp.send("Runtime.enable");
    await page.addInitScript(({ replaceRows, clientNavigation }) => {
      const marks = { listReadyMs: null, firstStackMs: null, completeMs: null };
      window.pulltergeistBenchmark = marks;
      if (clientNavigation) {
        document.addEventListener("DOMContentLoaded", () => {
          setTimeout(() => {
            const template = document.querySelector("#next-list");
            history.pushState({}, "", `${location.pathname}?q=author%3Ame`);
            document.querySelector("main").append(template.content);
            document.dispatchEvent(new Event("turbo:render"));
          }, 150);
        });
      }
      let replacing = false;
      new MutationObserver(() => {
        if (replaceRows && !replacing && document.querySelector(".pulltergeist-toolbar")) {
          replacing = true;
          setTimeout(() => {
            const list = document.querySelector("#list");
            const next = list.cloneNode(true);
            next.querySelectorAll(".pulltergeist-group").forEach(group => group.remove());
            next.className = "";
            next.removeAttribute("style");
            for (const row of next.children) {
              row.className = "";
              row.removeAttribute("style");
            }
            list.replaceWith(next);
          }, 20);
        }
        if (marks.listReadyMs === null && document.querySelector("#list")) marks.listReadyMs = Math.round(performance.now());
        if (marks.firstStackMs === null && document.querySelector(".pulltergeist-group")) marks.firstStackMs = Math.round(performance.now());
        const status = document.querySelector('.pulltergeist-toolbar [role="status"]');
        if (marks.completeMs === null && status && !status.textContent.includes("Finding")) marks.completeMs = Math.round(performance.now());
      }).observe(document, { childList: true, subtree: true, characterData: true });
    }, { replaceRows: !!scenario.replaceRows, clientNavigation: !!scenario.clientNavigation });
    let requests = 0;
    let bytes = 0;
    await page.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/slow-image.svg") {
        await new Promise(resolve => setTimeout(resolve, 600));
        await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        return;
      }
      const match = url.pathname.match(/\/pull\/(\d+)(\/_layout)?$/);
      if (!match) {
        let body = listHtml({ items, hints: true });
        if (scenario.clientNavigation) body = body.replace(/(<ul id="list"[\s\S]*<\/ul>)/, '<template id="next-list">$1</template>');
        if (scenario.slowAsset) body = body.replace("</body>", '<img src="/slow-image.svg" alt=""></body>');
        await route.fulfill({ contentType: "text/html", body });
        return;
      }
      const item = items.find(pull => pull.number === Number(match[1]));
      if (!match[2] && route.request().isNavigationRequest()) {
        await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>${pullHtml(item, items)}</body></html>` });
        return;
      }
      requests++;
      const body = match[2] ? JSON.stringify(pullPayload(item, items)) : pullHtml(item, items, 200000);
      bytes += Buffer.byteLength(body);
      await new Promise(resolve => setTimeout(resolve, 120));
      await route.fulfill({ contentType: match[2] ? "application/json" : "text/html", body }).catch(() => {});
    });
    if (scenario.passive || scenario.prewarm) {
      await page.goto(`${origin}${repo}${scenario.passive ? "/pull/1" : ""}`);
      await worldReady;
      if (scenario.prewarm) {
        const response = await cdp.send("Runtime.evaluate", {
          expression: "chrome.storage.local.set({prewarm:true})", contextId: world, awaitPromise: true,
        });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
        await page.waitForTimeout(30);
        await page.locator("#nav").focus();
      }
      await page.waitForTimeout(750);
    }
    const preparationRequests = requests;
    const results = [];
    for (const mode of ["cold", "reload"]) {
      requests = 0;
      bytes = 0;
      if (mode === "cold") await page.goto(`${origin}${repo}/pulls`);
      else await page.reload();
      await page.waitForFunction(() => window.pulltergeistBenchmark.firstStackMs !== null && window.pulltergeistBenchmark.completeMs !== null);
      const { listReadyMs, firstStackMs, completeMs } = await page.evaluate(() => window.pulltergeistBenchmark);
      results.push({ mode, preparationRequests: mode === "cold" ? preparationRequests : 0, listReadyMs, firstStackMs, groupingDelayMs: firstStackMs - listReadyMs, completeMs, metadataRequests: requests, responseBytes: bytes });
    }
    return results;
  } finally { await context.close(); }
}

async function main() {
  const current = path.resolve(__dirname, "..");
  const targets = process.argv[2] ? [{ name: "before", directory: path.resolve(process.argv[2]) }, { name: "after", directory: current }]
    : [{ name: "current", directory: current }];
  const report = { fixture: "25 PRs, or 8 native PRs for passive/prewarming; 120ms/metadata request, HTML padded by 200KB; slow asset 600ms; client insertion 150ms; warming preparation 750ms excluded from navigation timing", runs: [] };
  for (const scenario of scenarios) {
    for (const target of targets) {
      for (let sample = 1; sample <= 3; sample++) {
        const results = await measure(target.directory, scenario);
        report.runs.push({ scenario: scenario.name, name: target.name, sample, results });
        console.log(scenario.name, target.name, sample, JSON.stringify(results));
      }
    }
  }
  await fs.mkdir(path.join(current, "test-results"), { recursive: true });
  await fs.writeFile(path.join(current, "test-results/benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
