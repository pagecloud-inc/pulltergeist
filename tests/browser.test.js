const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { chromium } = require("playwright");
const { repo, origin, pulls, chainPulls, multipleStackPulls, manualStackPulls, listHtml, pullPayload, pullHtml } = require("./fixtures.js");

async function fixture(context, options = {}) {
  const items = options.items || pulls;
  const page = await context.newPage();
  if (options.beforeNavigate) await options.beforeNavigate(page);
  const cdp = await context.newCDPSession(page);
  let world;
  let resolveWorld;
  const worldReady = new Promise(resolve => { resolveWorld = resolve; });
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.name !== "Pulltergeist") return;
    world = context.id;
    resolveWorld();
  });
  await cdp.send("Runtime.enable");
  async function storage(method, argument) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `chrome.storage.local.${method}(${argument === undefined ? "" : JSON.stringify(argument)})`,
      contextId: world, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitForMetadata(minimum = 1) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `new Promise((resolve, reject) => {
        const finish = metadata => {
          if (!metadata || Object.keys(metadata).length < ${minimum}) return;
          clearTimeout(timeout);
          chrome.storage.onChanged.removeListener(changed);
          resolve(metadata);
        };
        const changed = (changes, area) => { if (area === "local") finish(changes.metadata?.newValue); };
        const timeout = setTimeout(() => {
          chrome.storage.onChanged.removeListener(changed);
          reject(new Error("Metadata was not persisted"));
        }, 3000);
        chrome.storage.onChanged.addListener(changed);
        chrome.storage.local.get("metadata").then(result => finish(result.metadata));
      })`,
      contextId: world, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  const calls = [];
  const prewarmLists = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let active = 0;
  let maxActive = 0;
  let htmlActive = 0;
  let maxHtmlActive = 0;
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/\/pull\/(\d+)(\/_layout)?$/);
    if (!match) {
      if (/\/pulls(?:\/[^/]+)?\/?$/.test(url.pathname) && !route.request().isNavigationRequest()) prewarmLists.push(url.href);
      await route.fulfill({ contentType: "text/html", body: listHtml({ ...options, items }) });
      return;
    }
    if (!match[2] && route.request().isNavigationRequest()) {
      const item = items.find(pull => pull.number === Number(match[1]));
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><main><a id="nav" href="${repo}/pulls">Pull requests</a>${pullHtml(item, options.metadataItems || items)}</main></body></html>` });
      return;
    }
    calls.push(url.pathname);
    const layout = !!match[2];
    if (!layout) { htmlActive++; maxHtmlActive = Math.max(maxHtmlActive, htmlActive); }
    active++;
    maxActive = Math.max(maxActive, active);
    const item = items.find(pull => pull.number === Number(match[1]));
    await new Promise(resolve => setTimeout(resolve, typeof options.delay === "function" ? options.delay(item, layout) : options.delay || 20));
    active--;
    if (!layout) htmlActive--;
    const unsupported = typeof options.noLayout === "function" ? options.noLayout(item) : options.noLayout;
    const failure = typeof options.fail === "function" ? options.fail(item, layout) : options.fail === item.number;
    const status = failure ? options.status || 404 : layout && unsupported ? 404 : 200;
    const payload = pullPayload(item, options.metadataItems || items);
    if (options.layoutRefsOnly) delete payload.payload.pullRequestsLayoutRoute.stack;
    await route.fulfill({
      status, contentType: layout ? "application/json" : "text/html",
      body: layout ? JSON.stringify(payload) : pullHtml(item, options.metadataItems || items),
    }).catch(() => {});
  });
  await page.goto(origin);
  await worldReady;
  if (options.reset !== false) await storage("clear");
  if (options.settings) await storage("set", options.settings);
  await page.goto(`${origin}${options.startPath || `${repo}/pulls`}`);
  return { page, calls, prewarmLists, errors, storage, waitForMetadata, maxActive: () => maxActive, maxHtmlActive: () => maxHtmlActive };
}

async function ready(page) {
  await page.waitForFunction(() => {
    const status = document.querySelector('.pulltergeist-toolbar [role="status"]');
    return status && !status.textContent.includes("Finding");
  });
}

async function visible(page, selector) {
  return page.locator(selector).evaluateAll(elements => elements.filter(element => getComputedStyle(element).display !== "none").length);
}

async function preference(page, name, value) {
  const details = page.locator(".pulltergeist-settings");
  if (!(await details.evaluate(element => element.open))) await details.locator("summary").click();
  await page.getByRole("checkbox", { name, exact: true }).setChecked(value);
}

test("unpacked extension in Chromium", { timeout: 60000 }, async t => {
  const extension = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  t.after(() => context.close());

  for (const legacy of [false, true]) {
    await t.test(`${legacy ? "legacy" : "React"} list: collapse, expand, base-first order, native controls, flat mode and cache`, async () => {
      const { page, calls, errors, maxActive } = await fixture(context, { legacy });
      try {
        await ready(page);
        assert.equal(await page.locator(".pulltergeist-toolbar strong").innerText(), "Pulltergeist");
        const logo = page.locator(".pulltergeist-brand img");
        await logo.evaluate(image => image.decode());
        assert.deepEqual(await logo.evaluate(image => ({
          naturalWidth: image.naturalWidth, width: image.width, height: image.height, alt: image.alt,
        })), { naturalWidth: 32, width: 20, height: 20, alt: "" });
        assert.equal(await page.locator(".pulltergeist-group").count(), 1);
        assert.equal(await page.locator(".pulltergeist-collapsed").count(), 3);
        assert.equal(await visible(page, "#list > :not(.pulltergeist-group)"), 1);
        assert.equal(await page.locator(".pulltergeist-title").innerText(), "Feature foundation");
        assert.equal(await page.locator(".pulltergeist-count").innerText(), "3 PRs");
        assert.match(await page.locator(".pulltergeist-toggle").getAttribute("aria-label"), /3 PRs/);
        assert.match(await page.locator(".pulltergeist-meta").innerText(), /#1 · base-author opened/);
        assert.equal(await page.locator(".pulltergeist-opened").getAttribute("datetime"), "2026-01-01T12:00:00.000Z");
        assert.equal(await page.locator(".pulltergeist-toggle").evaluate(button => button.firstElementChild.matches("svg.pulltergeist-stack-icon")), true);
        const stackBox = await page.locator(".pulltergeist-group").boundingBox();
        const prBox = await page.locator("#issue_3").boundingBox();
        assert.ok(Math.abs(stackBox.width - prBox.width) <= 1);
        assert.equal(await page.locator("svg.pulltergeist-chevron, svg.pulltergeist-stack-icon").count(), 2);
        assert.equal(await page.locator(".pulltergeist-toggle").getAttribute("aria-expanded"), "false");
        assert.equal(calls.length, 4);
        assert.ok(maxActive() <= (legacy ? 3 : 6));
        if (!legacy) assert.ok(calls.every(url => url.endsWith("/_layout")));

        await page.locator(".pulltergeist-toggle").focus();
        await page.keyboard.press("Enter");
        const rootBox = await page.locator("#issue_1").boundingBox();
        const childBox = await page.locator("#issue_2").boundingBox();
        const lastBox = await page.locator("#issue_4").boundingBox();
        assert.ok(rootBox.y < childBox.y && childBox.y < lastBox.y);
        assert.equal(await page.locator("#issue_1").evaluate(element => element.parentElement.id), "list");
        await page.getByRole("checkbox", { name: "Select PR 1", exact: true }).check();
        assert.equal(await page.getByRole("checkbox", { name: "Select PR 1", exact: true }).isChecked(), true);
        await page.locator(".pulltergeist-toggle").focus();
        await page.keyboard.press("Space");
        assert.equal(await page.locator(".pulltergeist-collapsed").count(), 3);
        await page.keyboard.press("Enter");
        assert.equal(await page.locator(".pulltergeist-toggle").getAttribute("aria-expanded"), "true");

        await page.getByRole("button", { name: "Show flat list" }).click();
        await page.getByRole("button", { name: "Group stacks" }).waitFor();
        assert.equal(await page.locator(".pulltergeist-group").count(), 0);
        assert.equal(await visible(page, "#list > *"), 4);
        assert.equal(await page.locator("#issue_2").evaluate(element => element.style.getPropertyValue("--pulltergeist-order")), "");
        await page.getByRole("button", { name: "Group stacks" }).click();
        await page.locator(".pulltergeist-toggle").waitFor();
        assert.equal(await page.locator(".pulltergeist-toggle").getAttribute("aria-expanded"), "true");
        assert.equal(calls.length, 4);

        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await ready(page);
        assert.equal(calls.length, 8);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  await t.test("opened PR pages passively warm native stacks without extra requests", async () => {
    const { page, calls, errors, waitForMetadata } = await fixture(context, { items: chainPulls(), hints: true, startPath: `${repo}/pull/8` });
    try {
      const metadata = await waitForMetadata(8);
      assert.equal(calls.length, 0);
      const observed = metadata[`${origin}${repo}/pull/8`].time;
      await page.locator("main").evaluate(main => main.append(document.createElement("span")));
      await page.waitForTimeout(40);
      await page.goto(`${origin}${repo}/pulls`);
      await ready(page);
      assert.equal(calls.length, 0);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "8 PRs");
      assert.ok(observed <= Date.now());
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("a faster tab shares fresh results with a loading tab and skips its queued reads", async () => {
    const items = manualStackPulls();
    const first = await fixture(context, { items, hints: true, delay: 600 });
    let second;
    try {
      second = await fixture(context, { items, hints: true, reset: false });
      await ready(second.page);
      await first.page.locator(".pulltergeist-group").waitFor();
      assert.match(await first.page.locator(".pulltergeist-toolbar [role=status]").innerText(), /Finding/);
      assert.equal(first.calls.length, 6);
      await ready(first.page);
      assert.equal(first.calls.length, 6);
      assert.equal(await first.page.locator(".pulltergeist-count").innerText(), "3 PRs");
      assert.deepEqual([...first.errors, ...second.errors], []);
    } finally {
      if (second) await second.page.close();
      await first.page.close();
    }
  });

  await t.test("passive learning honors cache opt-out and shared metadata rejects changed SHAs", async () => {
    const first = await fixture(context, { items: chainPulls(), hints: true, startPath: `${repo}/pull/8`, settings: { cacheMetadata: false } });
    try {
      await first.page.waitForTimeout(60);
      assert.equal((await first.storage("get", "metadata")).metadata, undefined);
      assert.equal(first.calls.length, 0);
    } finally { await first.page.close(); }
    const items = chainPulls();
    const loading = await fixture(context, { items, hints: true, delay: 300 });
    let changed;
    try {
      const otherItems = items.map(pull => ({ ...pull, sha: "f".repeat(40) }));
      changed = await fixture(context, { items: otherItems, hints: true, reset: false, startPath: `${repo}/pull/8` });
      await changed.waitForMetadata(8);
      await loading.page.waitForTimeout(40);
      assert.equal(await loading.page.locator(".pulltergeist-group").count(), 0);
      await ready(loading.page);
      assert.equal(await loading.page.locator(".pulltergeist-count").innerText(), "8 PRs");
      assert.deepEqual([...loading.errors, ...changed.errors], []);
    } finally {
      if (changed) await changed.page.close();
      await loading.page.close();
    }
  });

  await t.test("prewarming defaults off and cancels short hover or focus intent", async () => {
    for (const prewarm of [false, true]) {
      const { page, calls, prewarmLists, errors } = await fixture(context, { startPath: repo, settings: { prewarm } });
      try {
        await page.locator("#nav").hover();
        if (prewarm) await page.mouse.move(900, 600);
        await page.waitForTimeout(300);
        if (prewarm) {
          await page.locator("#nav").focus();
          await page.locator("#nav").evaluate(anchor => anchor.blur());
          await page.waitForTimeout(300);
        }
        assert.equal(calls.length, 0);
        assert.equal(prewarmLists.length, 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("opt-in hover and keyboard prewarming are bounded, query-preserving, and reused on navigation", async () => {
    for (const intent of ["hover", "focus"]) {
      const { page, calls, prewarmLists, errors, waitForMetadata } = await fixture(context, {
        items: chainPulls(8, 17), hints: true, startPath: repo, settings: { prewarm: true },
      });
      try {
        await page.locator("#nav")[intent]();
        await waitForMetadata(13);
        assert.equal(calls.length, 6);
        assert.equal(prewarmLists.length, 1);
        assert.equal(new URL(prewarmLists[0]).searchParams.get("q"), "is:pr author:me");
        await page.goto(prewarmLists[0]);
        await ready(page);
        assert.equal(calls.length, 18);
        assert.equal(await page.locator(".pulltergeist-count").innerText(), "8 PRs");
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("prewarming stops on opt-out or disable and never follows foreign or non-list links", async () => {
    for (const stop of ["cacheMetadata", "enabled", "prewarm"]) {
      const { page, calls, prewarmLists, errors, storage } = await fixture(context, {
        items: manualStackPulls(), hints: true, startPath: repo, settings: { prewarm: true }, delay: 200,
      });
      try {
        await page.locator("#nav").focus();
        await page.waitForTimeout(260);
        await storage("set", { [stop]: false });
        await page.waitForTimeout(300);
        assert.ok(calls.length <= 1);
        assert.equal(prewarmLists.length, 1);
        const metadata = (await storage("get", "metadata")).metadata;
        assert.equal(Object.keys(metadata || {}).length, 0);
        if (stop === "cacheMetadata") assert.equal(metadata, undefined);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
    const { page, calls, prewarmLists, errors } = await fixture(context, { startPath: repo, settings: { prewarm: true } });
    try {
      for (const href of [`${origin}${repo}/issues`, `${origin}${repo}/pull/1`, `https://other.example${repo}/pulls`]) {
        await page.locator("#nav").evaluate((anchor, href) => { anchor.href = href; }, href);
        await page.locator("#nav").focus();
        await page.waitForTimeout(250);
        await page.locator("#nav").evaluate(anchor => anchor.blur());
      }
      assert.equal(calls.length, 0);
      assert.equal(prewarmLists.length, 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("prewarming uses sequential HTML fallback and obeys the lightweight setting", async () => {
    for (const fastMetadata of [true, false]) {
      const { page, calls, errors, waitForMetadata, maxHtmlActive } = await fixture(context, {
        items: manualStackPulls(), hints: true, startPath: repo, noLayout: true, settings: { prewarm: true, fastMetadata },
      });
      try {
        await page.locator("#nav").focus();
        await waitForMetadata(6);
        assert.equal(calls.filter(url => !url.endsWith("/_layout")).length, 6);
        assert.equal(calls.filter(url => url.endsWith("/_layout")).length, fastMetadata ? 1 : 0);
        assert.equal(maxHtmlActive(), 1);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("prewarming stops on rate limits without background retry loops", async () => {
    const { page, calls, errors } = await fixture(context, {
      items: manualStackPulls(), hints: true, startPath: repo, settings: { prewarm: true }, fail: 25, status: 429,
    });
    try {
      await page.locator("#nav").focus();
      await page.waitForTimeout(350);
      assert.equal(calls.length, 1);
      await page.locator("#nav").evaluate(anchor => anchor.blur());
      await page.locator("#nav").focus();
      await page.waitForTimeout(300);
      assert.equal(calls.length, 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("canonical author-filter routes group and prewarm like ordinary list URLs", async () => {
    const { page, errors, prewarmLists } = await fixture(context, {
      items: chainPulls(), hints: true, startPath: `${repo}/pulls/base-author`, settings: { prewarm: true },
    });
    try {
      await ready(page);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "8 PRs");
      await page.goto(`${origin}${repo}`);
      await page.locator("#nav").evaluate(anchor => { anchor.href = "/pagecloud/pagecloud/pulls/base-author"; });
      const warmed = page.waitForResponse(response => response.url().endsWith("/pulls/base-author") && response.request().resourceType() === "fetch");
      await page.locator("#nav").focus();
      await warmed;
      assert.equal(prewarmLists.length, 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("default-branch deploys stay standalone on cold and old-cache loads without hiding real stacks", async () => {
    const items = [
      { number: 99, title: "Release promotion", base: "master", head: "staging" },
      ...Array.from({ length: 21 }, (_, i) => ({ number: i + 1, title: `Feature ${i + 1}`, base: "staging", head: `feature-${i + 1}` })),
      { number: 22, title: "Feature follow-up", base: "feature-1", head: "followup" },
      { number: 23, title: "Other", base: "off-page", head: "other" },
      { number: 24, title: "Another", base: "off-page", head: "another" },
    ].map(pull => ({ ...pull, author: "author", openedAt: "2026-01-01T12:00:00Z" }));
    for (const mode of ["cold", "old-cache", "stale-default-cache", "legacy-old-cache"]) {
      const metadata = Object.fromEntries(items.map(pull => [`${origin}${repo}/pull/${pull.number}`, {
        base: JSON.stringify([repo.slice(1), pull.base]), head: JSON.stringify([repo.slice(1), pull.head]),
        sha: null, time: Date.now(), author: pull.author, openedAt: pull.openedAt,
        ...(mode === "stale-default-cache" ? { defaultRef: JSON.stringify([repo.slice(1), "master"]) } : {}),
      }]));
      const { page, calls, errors } = await fixture(context, {
        items, hints: mode !== "legacy-old-cache", legacy: mode === "legacy-old-cache",
        settings: mode === "cold" ? {} : { metadata },
        beforeNavigate: page => page.addInitScript(() => {
          window.deployWasGrouped = false;
          new MutationObserver(() => {
            for (const group of document.querySelectorAll(".pulltergeist-group")) {
              if (group.dataset.stack.split(",").includes("99")) window.deployWasGrouped = true;
            }
          }).observe(document, { childList: true, subtree: true });
        }),
      });
      try {
        await ready(page);
        assert.equal(await page.locator(".pulltergeist-group").count(), 1);
        assert.equal(await page.locator(".pulltergeist-count").innerText(), "2 PRs");
        assert.equal(await page.locator(".pulltergeist-title").innerText(), "Feature 1");
        assert.equal(await page.locator("#issue_99").isVisible(), true);
        assert.equal(await page.locator("#issue_99.pulltergeist-member, #issue_99.pulltergeist-collapsed").count(), 0);
        assert.equal(await page.evaluate(() => window.deployWasGrouped), false);
        assert.equal(calls.length, mode === "cold" ? 25 : mode === "legacy-old-cache" ? 1 : 0);
        calls.length = 0;
        await page.reload();
        await ready(page);
        assert.equal(calls.length, 0);
        assert.equal(await page.locator(".pulltergeist-count").innerText(), "2 PRs");
        assert.equal(await page.evaluate(() => window.deployWasGrouped), false);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("unreadable metadata leaves its PR alone", async () => {
    const { page, errors } = await fixture(context, { fail: 1 });
    try {
      await ready(page);
      assert.equal(await page.locator(".pulltergeist-group").count(), 0);
      assert.equal(await visible(page, "#list > *"), 4);
      assert.match(await page.locator('.pulltergeist-toolbar [role="status"]').innerText(), /1 unreadable, left alone/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("unchanged React row replacement preserves in-flight requests and the settings panel", async () => {
    const items = chainPulls(8, 5);
    const { page, calls, errors } = await fixture(context, { items, hints: true, delay: 250 });
    try {
      await page.locator(".pulltergeist-settings summary").click();
      const settings = await page.locator(".pulltergeist-settings").elementHandle();
      await page.locator("#list").evaluate(list => list.replaceWith(list.cloneNode(true)));
      await ready(page);
      assert.equal(calls.length, 6);
      assert.equal(new Set(calls).size, calls.length);
      assert.equal(await settings.evaluate(element => element.isConnected && element.open), true);
      assert.equal(await page.locator(".pulltergeist-group").count(), 1);
      assert.equal(await page.locator(".pulltergeist-collapsed").count(), 8);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("manual stacks read both list ends early with six JSON or three HTML jobs", async () => {
    for (const fastMetadata of [true, false]) {
      const items = manualStackPulls();
      const { page, calls, maxActive, errors } = await fixture(context, { items, hints: true, settings: { fastMetadata }, delay: 40 });
      try {
        await ready(page);
        assert.equal(calls.length, 25);
        assert.ok(calls[0].includes("/pull/25"));
        assert.ok(calls[1].includes("/pull/1"));
        assert.equal(maxActive(), fastMetadata ? 6 : 3);
        assert.equal(await page.locator(".pulltergeist-title").innerText(), "Manual PR 1");
        assert.equal(await page.locator(".pulltergeist-count").innerText(), "3 PRs");
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("first useful stacks are cached before slow unrelated metadata finishes", async () => {
    const { page, calls, waitForMetadata, errors } = await fixture(context, { delay: pull => pull.number === 3 ? 800 : 20 });
    try {
      await page.locator(".pulltergeist-group").waitFor();
      const metadata = await waitForMetadata();
      assert.ok(metadata[`${origin}${repo}/pull/1`]);
      assert.match(await page.locator(".pulltergeist-toolbar [role=status]").innerText(), /Finding/);
      calls.length = 0;
      await page.reload();
      await page.locator(".pulltergeist-group").waitFor();
      await ready(page);
      assert.deepEqual(calls, [`${repo}/pull/3/_layout`]);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "3 PRs");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("a late lightweight-endpoint failure never exceeds three concurrent HTML fallbacks", async () => {
    const items = manualStackPulls();
    const { page, maxActive, maxHtmlActive, errors } = await fixture(context, {
      items, hints: true, noLayout: pull => ![25, 1, 24].includes(pull.number), delay: 30,
    });
    try {
      await ready(page);
      assert.ok(maxActive() <= 6);
      assert.equal(maxHtmlActive(), 3);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "3 PRs");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("an HTML rate limit stops fallbacks already waiting for a slot", async () => {
    const { page, calls, errors, maxHtmlActive } = await fixture(context, {
      items: manualStackPulls(), hints: true, noLayout: true, status: 429,
      fail: (pull, layout) => !layout && pull.number === 25,
      delay: (pull, layout) => layout || pull.number === 25 ? 30 : 200,
    });
    try {
      await ready(page);
      assert.equal(calls.filter(url => url.endsWith("/_layout")).length, 6);
      assert.equal(calls.filter(url => !url.endsWith("/_layout")).length, 3);
      assert.equal(maxHtmlActive(), 3);
      assert.equal(await visible(page, "#list > *"), 25);
      assert.match(await page.locator(".pulltergeist-toolbar [role=status]").innerText(), /rate limit/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("rate limiting at six JSON jobs stops the remaining queue", async () => {
    const items = manualStackPulls();
    const { page, calls, maxActive, errors } = await fixture(context, {
      items, hints: true, fail: 23, status: 429, delay: pull => [25, 1, 24, 23].includes(pull.number) ? 30 : 200,
    });
    try {
      await ready(page);
      assert.ok(calls.length < items.length);
      assert.equal(new Set(calls).size, calls.length);
      assert.ok(maxActive() <= 6);
      assert.equal(await page.locator("#issue_23").isVisible(), true);
      assert.match(await page.locator(".pulltergeist-toolbar [role=status]").innerText(), /rate limit/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("independent native stacks probe their bases in parallel, including filtered stacks", async () => {
    const metadataItems = multipleStackPulls();
    for (const [minimum, maximum] of [[1, 8], [3, 8], [1, 1]]) {
      const items = metadataItems.filter(pull => !pull.stackPosition || (pull.stackPosition >= minimum && pull.stackPosition <= maximum));
      const { page, calls, errors, maxActive } = await fixture(context, { items, metadataItems, hints: true, delay: 100 });
      try {
        await ready(page);
        assert.equal(calls.length, 4);
        assert.deepEqual(calls.slice(0, 3), [minimum, minimum + 8, minimum + 16].map(number => `${repo}/pull/${number}/_layout`));
        assert.equal(maxActive(), 4);
        assert.equal(await page.locator(".pulltergeist-group").count(), maximum > minimum ? 3 : 0);
        assert.equal(await page.locator(".pulltergeist-collapsed").count(), maximum > minimum ? 3 * (maximum - minimum + 1) : 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("missing native positions retain coalescing and hints alone cannot group PRs", async () => {
    const scenarios = [
      { items: multipleStackPulls().map(pull => ({ ...pull, stackPosition: undefined })), groups: 3, requests: 4 },
      { items: chainPulls(0, 6).map(pull => ({ ...pull, stackSize: 6, stackPosition: 1 })), layoutRefsOnly: true, groups: 0, requests: 6 },
    ];
    for (const scenario of scenarios) {
      const { page, calls, errors } = await fixture(context, { ...scenario, hints: true });
      try {
        await ready(page);
        assert.equal(calls.length, scenario.requests);
        assert.equal(await page.locator(".pulltergeist-group").count(), scenario.groups);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("native stack metadata resolves eight PRs with one request", async () => {
    const { page, calls, errors } = await fixture(context, { items: chainPulls(), hints: true });
    try {
      await ready(page);
      assert.equal(calls.length, 1);
      assert.equal(await page.locator(".pulltergeist-collapsed").count(), 8);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "8 PRs");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("base-first native probes supply opening details even without list timestamps", async () => {
    for (const hintDates of [true, false]) {
      const items = chainPulls();
      const { page, calls, errors } = await fixture(context, {
        items, hints: true, density: "compact", timestamps: false, hintDates,
      });
      try {
        await ready(page);
        assert.deepEqual(calls, [`${repo}/pull/1/_layout`]);
        assert.equal(await page.locator(".pulltergeist-author").innerText(), "author-1");
        assert.equal(await page.locator(".pulltergeist-opened").getAttribute("datetime"), "2026-01-01T12:00:00.000Z");
        assert.equal(await page.locator(".pulltergeist-meta").isVisible(), true);
        assert.equal(await page.locator(".pulltergeist-count").innerText(), "8 PRs");
        calls.length = 0;
        await page.reload();
        await ready(page);
        assert.equal(calls.length, 0);
        assert.equal(await page.locator(".pulltergeist-author").innerText(), "author-1");
        assert.equal(await page.locator(".pulltergeist-opened").getAttribute("datetime"), "2026-01-01T12:00:00.000Z");
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("unavailable opening details do not trigger a request loop", async () => {
    const items = chainPulls().map(pull => ({ ...pull, openedAt: null }));
    const { page, calls, errors } = await fixture(context, { items, hints: true, density: "compact" });
    try {
      await ready(page);
      assert.equal(calls.length, 1);
      assert.equal(await page.locator(".pulltergeist-opened").innerText(), "date unavailable");
      await page.waitForTimeout(200);
      assert.equal(calls.length, 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("reload uses the local cache with no metadata requests", async () => {
    const { page, calls, storage, errors } = await fixture(context);
    try {
      await ready(page);
      assert.equal(Object.keys((await storage("get", "metadata")).metadata).length, 4);
      calls.length = 0;
      await page.reload();
      await ready(page);
      assert.equal(calls.length, 0);
      assert.equal(await page.locator(".pulltergeist-group").count(), 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("all display settings apply live and survive reload", async () => {
    const { page, calls, storage, errors } = await fixture(context);
    try {
      await ready(page);
      await preference(page, "Open stacks by default", true);
      await page.waitForFunction(() => document.querySelector('.pulltergeist-toggle[aria-expanded="true"]'));
      await preference(page, "Base PR first", false);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector("#issue_2")).order) < Number(getComputedStyle(document.querySelector("#issue_1")).order));
      assert.equal(await page.locator(".pulltergeist-author").innerText(), "base-author");
      assert.equal(await page.locator(".pulltergeist-opened").getAttribute("datetime"), "2026-01-01T12:00:00.000Z");
      await preference(page, "Highlight stack members", false);
      await page.waitForFunction(() => !document.querySelector(".pulltergeist-member"));
      await preference(page, "Show PR counts", false);
      await page.waitForFunction(() => !document.querySelector(".pulltergeist-count"));
      await preference(page, "Compact stack text", true);
      await page.waitForSelector(".pulltergeist-compact");
      assert.equal(await page.locator(".pulltergeist-meta").isVisible(), false);
      assert.equal(await page.getByRole("checkbox").count(), 14);
      await preference(page, "Prewarm PR lists", true);
      const stored = await storage("get", null);
      assert.equal(stored.autoExpand, true);
      assert.equal(stored.baseFirst, false);
      assert.equal(stored.highlight, false);
      assert.equal(stored.showCounts, false);
      assert.equal(stored.compact, true);
      assert.equal(stored.prewarm, true);
      calls.length = 0;
      await page.reload();
      await ready(page);
      assert.equal(calls.length, 0);
      assert.equal(await page.locator('.pulltergeist-toggle[aria-expanded="true"]').count(), 1);
      assert.equal(await page.locator(".pulltergeist-member, .pulltergeist-count").count(), 0);
      assert.equal(await page.locator(".pulltergeist-compact").count(), 1);
      await page.locator(".pulltergeist-settings summary").click();
      assert.equal(await page.getByRole("checkbox", { name: "Prewarm PR lists", exact: true }).isChecked(), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("disabled grouping makes no requests, including after reload", async () => {
    const { page, calls, errors } = await fixture(context, { settings: { enabled: false } });
    try {
      await ready(page);
      assert.equal(calls.length, 0);
      assert.equal(await visible(page, "#list > *"), 4);
      await page.reload();
      await ready(page);
      assert.equal(calls.length, 0);
      await page.getByRole("button", { name: "Group stacks" }).click();
      await page.locator(".pulltergeist-group").waitFor();
      await ready(page);
      assert.equal(calls.length, 4);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("disabling persistent cache deletes branch metadata and reload fetches again", async () => {
    const { page, calls, storage, errors } = await fixture(context);
    try {
      await ready(page);
      await preference(page, "Cache metadata across reloads", false);
      await page.waitForTimeout(50);
      assert.equal((await storage("get", "metadata")).metadata, undefined);
      calls.length = 0;
      await page.reload();
      await ready(page);
      assert.equal(calls.length, 4);
      assert.equal((await storage("get", "metadata")).metadata, undefined);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("fast reads can be disabled, unsupported endpoints fall back to HTML", async () => {
    for (const fastMetadata of [false, true]) {
      const { page, calls, errors } = await fixture(context, { settings: { fastMetadata }, noLayout: true });
      try {
        await ready(page);
        assert.equal(await page.locator(".pulltergeist-group").count(), 1);
        assert.equal(calls.filter(url => !url.endsWith("/_layout")).length, 4);
        assert.equal(calls.filter(url => url.endsWith("/_layout")).length, fastMetadata ? 4 : 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("progressive rendering does not wait for an unrelated slow PR", async () => {
    for (const progressive of [true, false]) {
      const { page, errors } = await fixture(context, {
        settings: { progressive }, delay: pull => pull.number === 3 ? 600 : 20,
      });
      try {
        if (progressive) {
          await page.locator(".pulltergeist-group").waitFor();
          assert.match(await page.locator('.pulltergeist-toolbar [role="status"]').innerText(), /Finding/);
          await page.locator(".pulltergeist-toggle").click();
        } else {
          await page.waitForTimeout(200);
          assert.equal(await page.locator(".pulltergeist-group").count(), 0);
        }
        await ready(page);
        assert.equal(await page.locator(".pulltergeist-group").count(), 1);
        if (progressive) assert.equal(await page.locator(".pulltergeist-toggle").getAttribute("aria-expanded"), "true");
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("a rate limit stops queued requests without hiding PRs", async () => {
    const items = chainPulls(1, 20);
    const { page, calls, errors } = await fixture(context, { items, fail: items[0].number, status: 429 });
    try {
      await ready(page);
      assert.ok(calls.length <= 6);
      assert.equal(await visible(page, "#list > *"), 21);
      assert.match(await page.locator('.pulltergeist-toolbar [role="status"]').innerText(), /rate limit/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("settings changes propagate to another open tab", async () => {
    const first = await fixture(context);
    let second;
    try {
      await ready(first.page);
      second = await fixture(context, { reset: false });
      await ready(second.page);
      assert.equal(second.calls.length, 0);
      await preference(first.page, "Open stacks by default", true);
      await second.page.waitForSelector('.pulltergeist-toggle[aria-expanded="true"]');
      await first.page.getByRole("button", { name: "Show flat list" }).click();
      await second.page.getByRole("button", { name: "Group stacks" }).waitFor();
      assert.equal(await second.page.locator(".pulltergeist-group").count(), 0);
      assert.deepEqual([...first.errors, ...second.errors], []);
    } finally {
      if (second) await second.page.close();
      await first.page.close();
    }
  });

  await t.test("turning grouping off cancels loading and stops the queue", async () => {
    const { page, calls, storage, errors } = await fixture(context, { items: manualStackPulls(), delay: 250 });
    try {
      await page.getByRole("button", { name: "Show flat list" }).click();
      await page.getByRole("button", { name: "Group stacks" }).waitFor();
      await page.waitForTimeout(350);
      assert.ok(calls.length <= 6);
      assert.equal(await page.locator(".pulltergeist-group").count(), 0);
      assert.equal(await visible(page, "#list > *"), 25);
      assert.equal((await storage("get", "metadata")).metadata, undefined);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("turning caching off during loading cannot persist metadata", async () => {
    const { page, storage, errors } = await fixture(context, { delay: 250 });
    try {
      await preference(page, "Cache metadata across reloads", false);
      await ready(page);
      assert.equal((await storage("get", "metadata")).metadata, undefined);
      assert.equal(await page.locator(".pulltergeist-group").count(), 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("changed head SHAs invalidate only the affected cached PR", async () => {
    const items = pulls.map(pull => ({ ...pull, sha: String(pull.number).padStart(40, "0") }));
    const { page, calls, errors } = await fixture(context, { items, hints: true });
    try {
      await ready(page);
      items[0].sha = "f".repeat(40);
      calls.length = 0;
      await page.reload();
      await ready(page);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes("/pull/2/"));
      assert.equal(await page.locator(".pulltergeist-group").count(), 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("a growing stack preserves expansion and keyboard focus", async () => {
    const items = [
      { number: 3, title: "Tip", base: "middle", head: "tip" },
      { number: 2, title: "Middle", base: "root", head: "middle" },
      { number: 1, title: "Root", base: "staging", head: "root" },
    ];
    const { page, errors } = await fixture(context, { items, delay: pull => pull.number === 1 ? 500 : 20 });
    try {
      await page.locator(".pulltergeist-toggle").waitFor();
      await page.locator(".pulltergeist-toggle").focus();
      await page.keyboard.press("Enter");
      await ready(page);
      assert.match(await page.locator(".pulltergeist-toggle").innerText(), /Root/);
      assert.equal(await page.locator(".pulltergeist-toggle").getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator(".pulltergeist-toggle").evaluate(element => document.activeElement === element), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("settings fit a narrow viewport and Escape returns focus", async () => {
    const { page, errors } = await fixture(context);
    try {
      await ready(page);
      await page.setViewportSize({ width: 390, height: 700 });
      await page.locator(".pulltergeist-settings summary").click();
      const panel = await page.locator(".pulltergeist-settings-panel").boundingBox();
      assert.ok(panel.x >= 0 && panel.x + panel.width <= 390);
      await page.getByRole("checkbox", { name: "Group stacked PRs", exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".pulltergeist-settings").evaluate(element => element.open), false);
      assert.equal(await page.locator(".pulltergeist-settings summary").evaluate(element => document.activeElement === element), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("settings dismiss on outside clicks or Escape without swallowing other clicks", async () => {
    const { page, errors } = await fixture(context);
    try {
      await ready(page);
      const details = page.locator(".pulltergeist-settings");
      const summary = details.locator("summary");
      await summary.click();
      await details.locator(".pulltergeist-settings-panel p").click();
      assert.equal(await details.evaluate(element => element.open), true);
      await preference(page, "Highlight stack members", false);
      assert.equal(await details.evaluate(element => element.open), true);
      await page.locator(".pulltergeist-brand").click();
      assert.equal(await details.evaluate(element => element.open), false);
      await summary.click();
      await page.getByRole("checkbox", { name: "Select PR 3", exact: true }).click();
      assert.equal(await details.evaluate(element => element.open), false);
      assert.equal(await page.getByRole("checkbox", { name: "Select PR 3", exact: true }).isChecked(), true);
      assert.equal(await page.getByRole("checkbox", { name: "Select PR 3", exact: true }).evaluate(element => document.activeElement === element), true);
      await summary.click();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Escape");
      assert.equal(await details.evaluate(element => element.open), false);
      assert.equal(await summary.evaluate(element => document.activeElement === element), true);
      await summary.click();
      await page.getByRole("checkbox", { name: "Select PR 3", exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await details.evaluate(element => element.open), false);
      assert.equal(await summary.evaluate(element => document.activeElement === element), true);
      await summary.click();
      assert.equal(await details.evaluate(element => element.open), true);
      await summary.click();
      assert.equal(await details.evaluate(element => element.open), false);
      await page.getByRole("checkbox", { name: "Select PR 3", exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("checkbox", { name: "Select PR 3", exact: true }).evaluate(element => document.activeElement === element), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("settings dismissal listeners are removed with their view", async () => {
    const { page, errors } = await fixture(context);
    try {
      await ready(page);
      await page.locator(".pulltergeist-settings summary").click();
      await page.evaluate(() => {
        const details = document.querySelector(".pulltergeist-settings");
        window.removedSettings = details;
        document.dispatchEvent(new Event("turbo:before-cache"));
      });
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => window.removedSettings.open), true);
      await page.mouse.click(1, 1);
      assert.equal(await page.evaluate(() => window.removedSettings.open), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("collapsed height and icon indentation match native selectable rows in both densities", async () => {
    const { page, calls, errors } = await fixture(context, { nativeLayout: true });
    try {
      await ready(page);
      async function aligned(height) {
        await page.waitForFunction(height => Math.abs(document.querySelector(".pulltergeist-group").getBoundingClientRect().height - height) < 0.5, height);
        const geometry = await page.evaluate(() => {
          const native = document.querySelector("#issue_3");
          const stack = document.querySelector(".pulltergeist-group");
          return {
            nativeHeight: native.getBoundingClientRect().height,
            stackHeight: stack.getBoundingClientRect().height,
            nativeIconX: native.querySelector("svg").getBoundingClientRect().left,
            stackIconX: stack.querySelector(".pulltergeist-stack-icon").getBoundingClientRect().left,
            nativeTitleX: native.querySelector("[data-testid=listitem-title-link]").getBoundingClientRect().left,
            stackTitleX: stack.querySelector(".pulltergeist-title").getBoundingClientRect().left,
            nativePadding: getComputedStyle(native).paddingTop,
          };
        });
        assert.equal(geometry.nativeHeight, height);
        assert.equal(geometry.stackHeight, height);
        assert.equal(geometry.stackIconX, geometry.nativeIconX);
        assert.equal(geometry.stackTitleX, geometry.nativeTitleX);
        return geometry;
      }
      assert.equal((await aligned(67)).nativePadding, "12px");
      assert.equal(await page.locator(".pulltergeist-group input, .pulltergeist-group [role=checkbox]").count(), 0);
      await preference(page, "Compact stack text", true);
      await page.waitForSelector(".pulltergeist-compact");
      assert.equal((await aligned(67)).nativePadding, "12px");
      await page.keyboard.press("Escape");
      await page.locator(".pulltergeist-toggle").click();
      assert.equal((await page.locator(".pulltergeist-group").boundingBox()).height, 33);
      assert.equal(await page.locator(".pulltergeist-meta").isVisible(), false);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "3 PRs");
      assert.equal(await page.locator(".pulltergeist-title").evaluate(element => getComputedStyle(element).whiteSpace), "nowrap");
      await page.locator(".pulltergeist-toggle").focus();
      await page.keyboard.press("Space");
      await aligned(67);
      await page.locator("#list").evaluate(list => {
        list.setAttribute("data-density", "compact");
        for (const row of list.querySelectorAll(".fixture-pr-row")) row.className = "fixture-pr-row";
      });
      await aligned(38);
      assert.equal(await page.locator(".pulltergeist-meta").isVisible(), true);
      await page.locator(".pulltergeist-toggle").click();
      assert.equal((await page.locator(".pulltergeist-group").boundingBox()).height, 33);
      await page.locator("#list").evaluate(list => list.setAttribute("data-density", "default"));
      await page.waitForTimeout(150);
      assert.equal(await page.locator(".pulltergeist-toggle").getAttribute("aria-expanded"), "true");
      assert.equal((await page.locator(".pulltergeist-group").boundingBox()).height, 33);
      await page.locator(".pulltergeist-toggle").click();
      await aligned(67);
      const header = await page.locator(".pulltergeist-group").elementHandle();
      await page.waitForTimeout(250);
      assert.equal(await header.evaluate(element => element.isConnected), true);
      assert.equal(calls.length, 4);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("native row resizing updates header height, including fully collapsed stack-only lists", async () => {
    for (const items of [pulls, chainPulls()]) {
      const { page, calls, errors } = await fixture(context, { nativeLayout: true, items, hints: true });
      try {
        await ready(page);
        assert.equal((await page.locator(".pulltergeist-group").boundingBox()).height, 67);
        const before = calls.length;
        const header = await page.locator(".pulltergeist-group").elementHandle();
        await page.locator("#list").evaluate(list => list.style.setProperty("--fixture-row-height", "83px"));
        await page.setViewportSize({ width: 390, height: 700 });
        await page.waitForFunction(() => document.querySelector(".pulltergeist-group").getBoundingClientRect().height === 83);
        if (items === pulls) assert.equal(await header.evaluate(element => element.isConnected), true);
        assert.equal(await page.locator(".pulltergeist-toggle").evaluate(button => button.scrollWidth <= button.clientWidth + 1), true);
        await page.locator(".pulltergeist-toggle").click();
        assert.equal((await page.locator(".pulltergeist-group").boundingBox()).height, 33);
        await page.locator(".pulltergeist-toggle").click();
        assert.equal((await page.locator(".pulltergeist-group").boundingBox()).height, 83);
        if (items !== pulls) {
          await page.locator("#list").evaluate(list => list.style.setProperty("--fixture-row-height", "91px"));
          await page.evaluate(() => document.fonts.dispatchEvent(new Event("loadingdone")));
          await page.waitForFunction(() => document.querySelector(".pulltergeist-group").getBoundingClientRect().height === 91);
        }
        assert.equal(calls.length, before);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  await t.test("native-style headers follow theme colors and truncate long titles", async () => {
    const { page, calls, errors } = await fixture(context);
    try {
      await ready(page);
      for (const theme of [
        { background: "#ffffff", foreground: "#1f2328", muted: "#59636e", hover: "#f6f8fa" },
        { background: "#0d1117", foreground: "#f0f6fc", muted: "#9198a1", hover: "#212830" },
      ]) {
        await page.evaluate(theme => {
          for (const [key, value] of Object.entries({
            "--bgColor-default": theme.background, "--fgColor-default": theme.foreground,
            "--fgColor-muted": theme.muted, "--control-transparent-bgColor-hover": theme.hover,
          })) document.documentElement.style.setProperty(key, value);
        }, theme);
        const colors = await page.locator(".pulltergeist-group").evaluate(element => ({
          background: getComputedStyle(element).backgroundColor,
          title: getComputedStyle(element.querySelector(".pulltergeist-title")).color,
          metadata: getComputedStyle(element.querySelector(".pulltergeist-meta")).color,
        }));
        const rgb = hex => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
        assert.deepEqual(colors, { background: rgb(theme.background), title: rgb(theme.foreground), metadata: rgb(theme.muted) });
        await page.locator(".pulltergeist-toggle").hover();
        assert.equal(await page.locator(".pulltergeist-toggle").evaluate(element => getComputedStyle(element).backgroundColor), rgb(theme.hover));
      }
      const title = `${"LongStackTitle".repeat(30)} <not-html>`;
      await page.locator('#issue_1 [data-testid="listitem-title-link"]').evaluate((element, title) => { element.textContent = title; }, title);
      await page.waitForFunction(title => document.querySelector(".pulltergeist-title")?.textContent === title, title);
      await page.setViewportSize({ width: 390, height: 700 });
      assert.equal(await page.locator(".pulltergeist-title").innerText(), title);
      assert.equal(await page.locator(".pulltergeist-title not-html").count(), 0);
      assert.equal(await page.locator(".pulltergeist-toggle").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "3 PRs");
      assert.equal(calls.length, 4);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("filters, pagination, busy states, and empty results reconcile without stale groups", async () => {
    const items = [...pulls];
    const { page, calls, errors } = await fixture(context, { items });
    try {
      await ready(page);
      await page.locator("#list").evaluate(element => element.setAttribute("aria-busy", "true"));
      await page.waitForFunction(() => !document.querySelector(".pulltergeist-toolbar"));
      assert.equal(await visible(page, "#list > *"), 4);
      assert.equal(calls.length, 4);
      const extra = { number: 5, title: "Filtered follow-up", base: "feature", head: "filtered" };
      items.push(extra);
      async function show(items, query) {
        await page.evaluate(({ html, query }) => {
          const next = new DOMParser().parseFromString(html, "text/html").querySelector("#list");
          document.querySelector("#list").replaceChildren(...next.childNodes);
          document.querySelector("#list").setAttribute("aria-busy", "false");
          history.pushState({}, "", `/pagecloud/pagecloud/pulls?${query}`);
        }, { html: listHtml({ items }), query });
      }
      await show([pulls[2], extra], "q=author%3Ame");
      await page.locator(".pulltergeist-count").waitFor();
      await ready(page);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "2 PRs");
      assert.equal(calls.length, 5);
      await show([pulls[1]], "q=author%3Ame&page=2");
      await page.waitForFunction(() => !document.querySelector(".pulltergeist-group") && document.querySelector(".pulltergeist-toolbar"));
      await ready(page);
      assert.equal(await page.locator(".pulltergeist-toolbar").count(), 1);
      assert.equal(calls.length, 5);
      await show([], "q=is%3Aclosed");
      await page.waitForFunction(() => !document.querySelector(".pulltergeist-toolbar"));
      await show([pulls[2], extra], "q=author%3Ame&page=1");
      await page.locator(".pulltergeist-count").waitFor();
      await ready(page);
      assert.equal(await page.locator(".pulltergeist-count").innerText(), "2 PRs");
      assert.equal(calls.length, 5);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("GitHub density changes repair React-owned row classes without refetching", async () => {
    const { page, calls, errors } = await fixture(context);
    try {
      await ready(page);
      const changeDensity = async density => {
        await page.evaluate(density => {
          const list = document.querySelector("#list");
          for (const row of list.querySelectorAll(":scope > :not(.pulltergeist-group)")) {
            row.className = "native-row";
            row.style.removeProperty("--pulltergeist-order");
          }
          list.setAttribute("data-density", density);
        }, density);
        await page.waitForFunction(() => document.querySelectorAll(".pulltergeist-row").length === 4, null, { timeout: 1500 });
      };
      await changeDensity("compact");
      assert.equal(await page.locator(".pulltergeist-collapsed").count(), 3);
      assert.equal(await page.locator(".native-row").count(), 4);
      assert.equal(await page.locator(".pulltergeist-title").evaluate(element => getComputedStyle(element).fontSize), "14px");
      assert.equal(await page.locator(".pulltergeist-meta").isVisible(), true);
      await page.locator(".pulltergeist-toggle").click();
      await changeDensity("default");
      assert.equal(await page.locator(".pulltergeist-toggle").getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator(".pulltergeist-collapsed").count(), 0);
      assert.equal(await page.locator(".pulltergeist-title").evaluate(element => getComputedStyle(element).fontSize), "14px");
      assert.equal(await page.locator(".pulltergeist-meta").isVisible(), false);
      assert.equal(calls.length, 4);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("filter navigation, React replacement, and Turbo cache cleanup", async () => {
    const { page, calls, errors } = await fixture(context);
    try {
      await ready(page);
      await page.evaluate(() => {
        history.pushState({}, "", "/pagecloud/pagecloud/pulls?q=author%3Ame");
        const list = document.querySelector("#list");
        const replacement = list.cloneNode(true);
        replacement.querySelectorAll(".pulltergeist-group, #issue_4").forEach(element => element.remove());
        replacement.className = "";
        for (const row of replacement.children) { row.className = ""; row.removeAttribute("style"); }
        list.replaceWith(replacement);
      });
      await page.waitForTimeout(200);
      await ready(page);
      assert.equal(await page.locator(".pulltergeist-group").count(), 1);
      assert.equal(await page.locator(".pulltergeist-collapsed").count(), 2);
      assert.equal(calls.length, 4);
      await page.evaluate(() => document.dispatchEvent(new Event("turbo:before-cache")));
      assert.equal(await page.locator(".pulltergeist-toolbar, .pulltergeist-group, .pulltergeist-collapsed, .pulltergeist-list").count(), 0);
      await page.evaluate(() => {
        history.pushState({}, "", "/pagecloud/pagecloud/issues");
        document.dispatchEvent(new Event("turbo:load"));
      });
      await page.waitForTimeout(150);
      assert.equal(await page.locator(".pulltergeist-toolbar").count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test("navigation during metadata loading cannot decorate the next page", async () => {
    const { page, errors } = await fixture(context, { delay: 200 });
    try {
      await page.waitForSelector(".pulltergeist-toolbar");
      await page.evaluate(() => {
        history.pushState({}, "", "/pagecloud/pagecloud/issues");
        document.querySelector("main").innerHTML = "<h1>Issues</h1>";
      });
      await page.waitForTimeout(400);
      assert.equal(await page.locator(".pulltergeist-toolbar, .pulltergeist-group").count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});
