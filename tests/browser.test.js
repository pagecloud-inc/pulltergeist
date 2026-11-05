const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { chromium } = require("playwright");
const { repo, origin, pulls, chainPulls, listHtml, pullPayload, pullHtml } = require("./fixtures.js");

async function fixture(context, options = {}) {
  const items = options.items || pulls;
  const page = await context.newPage();
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
  const calls = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let active = 0;
  let maxActive = 0;
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/\/pull\/(\d+)(\/_layout)?$/);
    if (!match) {
      await route.fulfill({ contentType: "text/html", body: listHtml({ ...options, items }) });
      return;
    }
    calls.push(url.pathname);
    active++;
    maxActive = Math.max(maxActive, active);
    const item = items.find(pull => pull.number === Number(match[1]));
    await new Promise(resolve => setTimeout(resolve, typeof options.delay === "function" ? options.delay(item) : options.delay || 20));
    active--;
    const layout = !!match[2];
    const status = options.fail === item.number ? options.status || 404 : layout && options.noLayout ? 404 : 200;
    await route.fulfill({
      status, contentType: layout ? "application/json" : "text/html",
      body: layout ? JSON.stringify(pullPayload(item, items)) : pullHtml(item, items),
    }).catch(() => {});
  });
  await page.goto(origin);
  await worldReady;
  if (options.reset !== false) await storage("clear");
  if (options.settings) await storage("set", options.settings);
  await page.goto(`${origin}${repo}/pulls`);
  return { page, calls, errors, storage, maxActive: () => maxActive };
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
        assert.ok(maxActive() <= 3);
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

  await t.test("compact stack summaries reuse opening details and fetch only a missing base date", async () => {
    for (const hintDates of [true, false]) {
      const items = chainPulls();
      const { page, calls, errors } = await fixture(context, {
        items, hints: true, density: "compact", timestamps: false, hintDates,
      });
      try {
        await ready(page);
        assert.equal(calls.length, hintDates ? 1 : 2);
        if (!hintDates) assert.ok(calls[1].endsWith("/pull/1/_layout"));
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
      assert.equal(calls.length, 2);
      assert.equal(await page.locator(".pulltergeist-opened").innerText(), "date unavailable");
      await page.waitForTimeout(200);
      assert.equal(calls.length, 2);
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
      assert.equal(await page.getByRole("checkbox").count(), 13);
      const stored = await storage("get", null);
      assert.equal(stored.autoExpand, true);
      assert.equal(stored.baseFirst, false);
      assert.equal(stored.highlight, false);
      assert.equal(stored.showCounts, false);
      assert.equal(stored.compact, true);
      calls.length = 0;
      await page.reload();
      await ready(page);
      assert.equal(calls.length, 0);
      assert.equal(await page.locator('.pulltergeist-toggle[aria-expanded="true"]').count(), 1);
      assert.equal(await page.locator(".pulltergeist-member, .pulltergeist-count").count(), 0);
      assert.equal(await page.locator(".pulltergeist-compact").count(), 1);
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
        assert.equal(calls.filter(url => url.endsWith("/_layout")).length, fastMetadata ? 3 : 0);
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
      assert.ok(calls.length <= 3);
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
    const { page, calls, storage, errors } = await fixture(context, { delay: 250 });
    try {
      await page.getByRole("button", { name: "Show flat list" }).click();
      await page.getByRole("button", { name: "Group stacks" }).waitFor();
      await page.waitForTimeout(350);
      assert.ok(calls.length <= 3);
      assert.equal(await page.locator(".pulltergeist-group").count(), 0);
      assert.equal(await visible(page, "#list > *"), 4);
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
        await page.locator("#list").evaluate(list => list.style.setProperty("--fixture-row-height", "83px"));
        await page.setViewportSize({ width: 390, height: 700 });
        await page.waitForFunction(() => document.querySelector(".pulltergeist-group").getBoundingClientRect().height === 83);
        assert.equal(await page.locator(".pulltergeist-toggle").evaluate(button => button.scrollWidth <= button.clientWidth + 1), true);
        await page.locator(".pulltergeist-toggle").click();
        assert.equal((await page.locator(".pulltergeist-group").boundingBox()).height, 33);
        await page.locator(".pulltergeist-toggle").click();
        assert.equal((await page.locator(".pulltergeist-group").boundingBox()).height, 83);
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
