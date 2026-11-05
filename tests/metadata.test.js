const assert = require("node:assert/strict");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { ref, openingDetails, rowOpeningDetails, metadataFromPayload, metadataFromPage, listHints } = require("../stacks.js");
const { MetadataCache } = require("../metadata.js");
const { normalizeSettings, defaultSettings, settingsFields } = require("../settings.js");
const { repo, origin, chainPulls, listHtml, pullPayload } = require("./fixtures.js");

const repository = repo.slice(1);
const url = number => `${origin}${repo}/pull/${number}`;
const refs = { base: ref(repository, "staging"), head: ref(repository, "feature"), sha: "a".repeat(40) };

function storage(initial = {}) {
  let values = structuredClone(initial);
  return {
    async get(keys) {
      if (keys === null) return structuredClone(values);
      if (typeof keys === "string") return { [keys]: structuredClone(values[keys]) };
      return Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, structuredClone(values[key] ?? value)]));
    },
    async set(patch) { Object.assign(values, structuredClone(patch)); },
    async remove(key) { delete values[key]; },
  };
}

function document(html) {
  return new JSDOM(html).window.document;
}

test("opening details normalize dates and reject missing or malformed values", () => {
  assert.deepEqual(openingDetails(" author ", "2026-01-01T12:00:00Z"), { author: "author", openedAt: "2026-01-01T12:00:00.000Z" });
  assert.deepEqual(openingDetails({}, "not a date"), { author: null, openedAt: null });
});

test("opening details read native and legacy row metadata, not closed timestamps", () => {
  for (const container of ['data-testid="timestamp-container"', 'class="opened-by"']) {
    const row = document(`<div ${container}>#1 opened <relative-time datetime="2026-01-01T12:00:00Z"></relative-time> by <a class="author">base-author</a></div>`).body;
    assert.deepEqual(rowOpeningDetails(row), { author: "base-author", openedAt: "2026-01-01T12:00:00.000Z" });
  }
  const closed = document('<span data-testid="timestamp-container">closed <relative-time datetime="2026-03-01T00:00:00Z"></relative-time></span>').body;
  assert.equal(rowOpeningDetails(closed).openedAt, null);
  assert.equal(rowOpeningDetails(closed, { openedAt: "2026-01-01T12:00:00Z" }).openedAt, "2026-01-01T12:00:00.000Z");
});

test("settings accept only known booleans, preserving all defaults", () => {
  assert.equal(settingsFields.length, 9);
  assert.deepEqual(normalizeSettings(null), defaultSettings);
  assert.deepEqual(normalizeSettings({ enabled: "false", autoExpand: true, unknown: true }), { ...defaultSettings, autoExpand: true });
});

test("lightweight payload expands a verified native stack from base to tip", () => {
  const items = chainPulls();
  const entries = metadataFromPayload(pullPayload(items[0], items), repository, 8);
  assert.equal(entries.length, 8);
  assert.deepEqual(entries.map(entry => entry.number), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(entries[0].base, ref(repository, "staging"));
  assert.equal(entries[7].base, entries[6].head);
  assert.equal(entries[7].sha, items[0].sha);
  assert.equal(entries[7].author, items[0].author);
  assert.equal(entries[7].openedAt, items[0].openedAt);
  assert.equal(entries[0].author, undefined);
});

test("payload identity must match the requested PR and repository", () => {
  const items = chainPulls();
  const payload = pullPayload(items[0], items);
  assert.deepEqual(metadataFromPayload(payload, repository, 99), []);
  assert.deepEqual(metadataFromPayload(payload, "other/repo", 8), []);
  assert.deepEqual(metadataFromPayload(null, repository, 8), []);
});

test("partial, forked, cyclic, and reordered native-stack shapes fall back to explicit PR refs", () => {
  const items = chainPulls();
  for (const modify of [
    route => { route.stack.size++; },
    route => { route.stack.pulls[1].url = "/other/repo/pull/7"; },
    route => { route.stack.pulls[1].number = 8; },
    route => { route.stack.pulls[1].headBranch = route.stack.pulls[2].headBranch; },
    route => { route.stack.pulls.reverse(); },
    route => { route.pullRequest.headRepositoryOwnerLogin = "fork"; },
    route => { route.stack.pulls[1].state = "MERGED"; },
  ]) {
    const payload = pullPayload(items[0], items);
    modify(payload.payload.pullRequestsLayoutRoute);
    assert.equal(metadataFromPayload(payload, repository, 8).length, 1);
  }
});

test("HTML metadata reuses the same native-stack decoder and rejects wrong PRs", () => {
  const items = chainPulls();
  const html = `<script data-target="react-app.embeddedData">${JSON.stringify(pullPayload(items[0], items))}</script>`;
  assert.equal(metadataFromPage(document(html), repository, 8).length, 8);
  assert.deepEqual(metadataFromPage(document(html), repository, 7), []);
});

test("list hints preserve SHA fingerprints without trusting another repository", () => {
  const items = chainPulls();
  const dom = document(listHtml({ items, hints: true }));
  assert.deepEqual(listHints(dom, repository).get("8"), { sha: items[0].sha, stackSize: 8, author: items[0].author, openedAt: items[0].openedAt });
  assert.equal(listHints(dom, "other/repo").size, 0);
  assert.equal(listHints(document("<p>No payload</p>"), repository).size, 0);
});

test("cache persists and reloads valid metadata, but rejects changed head SHAs", async () => {
  const local = storage();
  const cache = new MetadataCache(local);
  await cache.configure(true);
  cache.set({ url: url(1) }, refs);
  await cache.save();
  const reloaded = new MetadataCache(local);
  await reloaded.configure(true);
  assert.equal(reloaded.get({ url: url(1), sha: refs.sha }).head, refs.head);
  assert.equal(reloaded.get({ url: url(1), sha: "b".repeat(40) }), null);
});

test("cache preserves opening details across reloads without breaking old cache records", async () => {
  const local = storage();
  const cache = new MetadataCache(local);
  await cache.configure(true);
  cache.set({ url: url(1), author: "base-author", openedAt: "2026-01-01T12:00:00Z" }, refs);
  await cache.save();
  const reloaded = new MetadataCache(local);
  await reloaded.configure(true);
  assert.equal(reloaded.get({ url: url(1) }).author, "base-author");
  assert.equal(reloaded.get({ url: url(1) }).openedAt, "2026-01-01T12:00:00.000Z");
  await local.set({ metadata: { [url(2)]: { ...refs, time: Date.now() } } });
  const old = new MetadataCache(local);
  await old.configure(true);
  assert.equal(old.get({ url: url(2) }).head, refs.head);
  assert.equal(old.get({ url: url(2) }).openedAt, null);
});

test("cache rejects expired, future-dated, and malformed stored records", async () => {
  const now = Date.now();
  const local = storage({ metadata: {
    [url(1)]: { ...refs, time: now - 300001 },
    [url(2)]: { ...refs, time: now + 60000 },
    [url(3)]: { ...refs, time: now, base: "not json" },
    [url(4)]: { ...refs, time: now, head: '["repo", null]' },
  } });
  const cache = new MetadataCache(local);
  await cache.configure(true);
  assert.equal(cache.entries.size, 0);
});

test("disabling persistence removes disk metadata but keeps the in-tab cache", async () => {
  const local = storage();
  const cache = new MetadataCache(local);
  await cache.configure(true);
  cache.set({ url: url(1) }, refs);
  await cache.save();
  await local.set({ cacheMetadata: false });
  await cache.configure(false);
  assert.equal(cache.get({ url: url(1) }).head, refs.head);
  await cache.save();
  assert.equal((await local.get("metadata")).metadata, undefined);
});

test("cache does not write after another tab disables persistence", async () => {
  const local = storage();
  const cache = new MetadataCache(local);
  await cache.configure(true);
  cache.set({ url: url(1) }, refs);
  await local.set({ cacheMetadata: false });
  await cache.save();
  assert.equal((await local.get("metadata")).metadata, undefined);
});

test("a cache write racing with another tab's opt-out removes the saved metadata", async () => {
  const local = storage();
  const originalSet = local.set;
  local.set = async patch => {
    if (patch.metadata) await originalSet({ cacheMetadata: false });
    await originalSet(patch);
  };
  const cache = new MetadataCache(local);
  await cache.configure(true);
  cache.set({ url: url(1) }, refs);
  await cache.save();
  assert.equal((await local.get("metadata")).metadata, undefined);
});

test("cache is bounded and refresh removes both persistent and memory records", async () => {
  const local = storage();
  const cache = new MetadataCache(local);
  await cache.configure(true);
  for (let i = 1; i <= 260; i++) cache.set({ url: url(i) }, refs);
  assert.equal(cache.entries.size, 250);
  assert.equal(cache.get({ url: url(1) }), null);
  assert.ok(cache.get({ url: url(260) }));
  await cache.save();
  assert.equal(Object.keys((await local.get("metadata")).metadata).length, 250);
  await cache.clear();
  assert.equal(cache.entries.size, 0);
  assert.equal((await local.get("metadata")).metadata, undefined);
});
