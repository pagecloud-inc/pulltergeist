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
  assert.equal(settingsFields.length, 10);
  assert.equal(defaultSettings.prewarm, false);
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
  assert.deepEqual(listHints(dom, repository).get("8"), { sha: items[0].sha, stackSize: 8, stackPosition: 8, author: items[0].author, openedAt: items[0].openedAt });
  assert.equal(listHints(dom, "other/repo").size, 0);
  assert.equal(listHints(document("<p>No payload</p>"), repository).size, 0);
});

test("native positions used for scheduling reject out-of-range and malformed hints", () => {
  for (const stackPosition of [0, -1, 9, 1.5, "1", null]) {
    const items = chainPulls().map(pull => ({ ...pull, stackPosition }));
    assert.equal(listHints(document(listHtml({ items, hints: true })), repository).get("8").stackPosition, 0);
  }
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

test("startup can reuse the settings/cache snapshot without a second storage read", async () => {
  const local = storage();
  let reads = 0;
  const get = local.get;
  local.get = async keys => { reads++; return get(keys); };
  const cache = new MetadataCache(local);
  await cache.configure(true, { metadata: { [url(1)]: { ...refs, time: Date.now() } } });
  assert.equal(reads, 0);
  assert.equal(cache.get({ url: url(1) }).head, refs.head);
});

test("cache clear and opt-out wait for an in-flight early write, discarding queued old writes", async () => {
  for (const operation of ["clear", "disable"]) {
    const local = storage();
    const set = local.set;
    let started;
    let release;
    const ready = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let writes = 0;
    local.set = async patch => {
      if (patch.metadata && Object.keys(patch.metadata).length) { writes++; started(); await gate; }
      await set(patch);
    };
    const cache = new MetadataCache(local);
    await cache.configure(true);
    cache.set({ url: url(1) }, refs);
    const saving = cache.save();
    await ready;
    const queued = cache.save();
    const removal = operation === "clear" ? cache.clear() : cache.configure(false);
    release();
    await Promise.all([saving, queued, removal]);
    assert.equal(writes, 1);
    assert.deepEqual((await local.get("metadata")).metadata, operation === "clear" ? {} : undefined);
    assert.equal(cache.entries.size, operation === "clear" ? 0 : 1);
  }
});

test("a failed early cache write does not prevent a later save", async () => {
  const local = storage();
  const set = local.set;
  let fail = true;
  local.set = async patch => {
    if (fail) { fail = false; throw new Error("write failed"); }
    await set(patch);
  };
  const cache = new MetadataCache(local);
  await cache.configure(true);
  cache.set({ url: url(1) }, refs);
  await assert.rejects(cache.save(), /write failed/);
  await cache.save();
  assert.equal((await local.get("metadata")).metadata[url(1)].head, refs.head);
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

test("cross-tab saves merge under one lock instead of overwriting unrelated PRs", async () => {
  const local = storage();
  let pending = Promise.resolve();
  const locks = { request(name, callback) {
    assert.equal(name, "pulltergeist:metadata");
    const task = pending.then(callback);
    pending = task.catch(() => {});
    return task;
  } };
  const first = new MetadataCache(local, locks);
  const second = new MetadataCache(local, locks);
  await Promise.all([first.configure(true), second.configure(true)]);
  first.set({ url: url(1) }, refs);
  second.set({ url: url(2) }, refs);
  await Promise.all([first.save(), second.save()]);
  assert.deepEqual(Object.keys((await local.get("metadata")).metadata).sort(), [url(1), url(2)]);
});

test("imported cache records preserve age, reject older observations, and still check SHA", () => {
  const cache = new MetadataCache(storage());
  const time = Date.now() - 1000;
  const record = { ...refs, time };
  assert.equal(cache.merge({ [url(1)]: record }).size, 1);
  assert.equal(cache.entries.get(url(1)).time, time);
  assert.equal(cache.merge({ [url(1)]: { ...record, time: time - 1, head: ref(repository, "old") } }).size, 0);
  assert.equal(cache.get({ url: url(1), sha: refs.sha }).head, refs.head);
  assert.equal(cache.get({ url: url(1), sha: "changed" }), null);
  assert.equal(cache.merge({ [url(2)]: { ...record, time: Date.now() - 300001 } }).size, 0);
});

test("a remote clear prevents an old tab from restoring its pre-clear snapshot", async () => {
  const local = storage();
  const first = new MetadataCache(local);
  const second = new MetadataCache(local);
  await Promise.all([first.configure(true), second.configure(true)]);
  second.set({ url: url(2) }, refs);
  await first.clear();
  await second.save();
  assert.deepEqual((await local.get("metadata")).metadata, {});
  const { metadataEpoch } = await local.get("metadataEpoch");
  assert.equal(second.adoptEpoch(metadataEpoch), true);
  assert.equal(second.get({ url: url(2) }), null);
  second.set({ url: url(2) }, refs);
  await second.save();
  assert.equal((await local.get("metadata")).metadata[url(2)].head, refs.head);
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
  assert.deepEqual((await local.get("metadata")).metadata, {});
});
