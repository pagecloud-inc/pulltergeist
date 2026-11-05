const assert = require("node:assert/strict");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { MetadataCache } = require("../metadata.js");
const { PageMetadataLearner } = require("../warming.js");
const { repo, origin, chainPulls, pullHtml } = require("./fixtures.js");

const url = number => `${origin}${repo}/pull/${number}`;
const page = html => new JSDOM(html).window.document;

test("passive learning reuses verified embedded native metadata without storage or fetch", async () => {
  const cache = new MetadataCache({});
  const learner = new PageMetadataLearner(cache);
  const items = chainPulls();
  assert.equal(learner.collect(page(pullHtml(items[0], items)), url(8)), true);
  assert.equal(cache.entries.size, 8);
  assert.equal(cache.get({ url: url(1), sha: items[7].sha }).head, JSON.stringify([repo.slice(1), "step-1"]));
  await cache.save();
  assert.equal(cache.persistent, false);
});

test("repeated scans and cloned PR snapshots never extend observed metadata age", t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const cache = new MetadataCache({});
  const learner = new PageMetadataLearner(cache);
  const items = chainPulls();
  const html = pullHtml(items[0], items);
  const document = page(html);
  assert.equal(learner.collect(document, url(8)), true);
  const observedAt = cache.entries.get(url(8)).time;
  now += 10000;
  assert.equal(learner.collect(document, url(8)), false);
  assert.equal(learner.collect(page(html), url(8)), false);
  assert.equal(cache.entries.get(url(8)).time, observedAt);
  now += 5 * 60 * 1000;
  assert.equal(learner.collect(page(html), url(8)), false);
  assert.equal(cache.get({ url: url(8) }), null);
});

test("passive learning rejects wrong identity, legacy refs, previews, and markdown payloads", () => {
  const items = chainPulls();
  const html = pullHtml(items[0], items);
  for (const [document, href] of [
    [page(html), url(1)],
    [page(html), `${origin}/other/repo/pull/8`],
    [page(html), `https://other.example${repo}/pull/8`],
    [page(`<div class="markdown-body">${html}</div>`), url(8)],
    [page(`<html data-turbo-preview><body>${html}</body></html>`), url(8)],
    [page('<div class="gh-header"><a class="base-ref" href="/pagecloud/pagecloud/tree/staging">base</a><a class="head-ref" href="/pagecloud/pagecloud/tree/step-8">head</a></div>'), url(8)],
  ]) {
    const cache = new MetadataCache({});
    assert.equal(new PageMetadataLearner(cache).collect(document, href), false);
    assert.equal(cache.entries.size, 0);
  }
});

test("disabled learning records age and clear cannot republish an old PR snapshot", t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const cache = new MetadataCache({});
  const learner = new PageMetadataLearner(cache);
  const items = chainPulls();
  const html = pullHtml(items[0], items);
  const document = page(html);
  assert.equal(learner.collect(document, url(8), false), false);
  const observedAt = now;
  now += 10000;
  assert.equal(learner.collect(document, url(8), true), true);
  assert.equal(cache.entries.get(url(8)).time, observedAt);
  cache.adoptEpoch("cleared");
  assert.equal(learner.collect(page(html), url(8)), false);
  assert.equal(cache.entries.size, 0);
});
