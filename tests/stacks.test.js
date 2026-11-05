const assert = require("node:assert/strict");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { ref, parseRefs, findStacks } = require("../stacks.js");

const repo = "pagecloud/pagecloud";
const branch = name => ref(repo, name);
const pull = (number, base, head) => ({ number, base: branch(base), head: branch(head) });
const parse = html => parseRefs(new JSDOM(html).window.document, repo);

function payload(overrides = {}) {
  return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
    payload: {
      pullRequestsLayoutRoute: {
        repository: { ownerLogin: "pagecloud", name: "pagecloud" },
        pullRequest: {
          baseBranch: "staging", headBranch: "mg/feature",
          headRepositoryOwnerLogin: "pagecloud", headRepositoryName: "pagecloud", ...overrides,
        },
      },
    },
  })}</script>`;
}

test("reads the current GitHub React branch payload", () => {
  assert.deepEqual(parse(payload()), { base: branch("staging"), head: branch("mg/feature") });
});

test("preserves fork identity and case-sensitive branch names", () => {
  assert.deepEqual(parse(payload({ headRepositoryOwnerLogin: "Someone", headBranch: "Feature" })), {
    base: branch("staging"), head: ref("someone/pagecloud", "Feature"),
  });
  assert.notEqual(branch("Feature"), branch("feature"));
  assert.equal(ref("PAGECLOUD/PAGECLOUD", "Feature"), branch("Feature"));
});

test("reads legacy branch links with escaped slashes and HTML entities", () => {
  assert.deepEqual(parse(`<div id="partial-discussion-header">
    <span class="base-ref"><a href="/pagecloud/pagecloud/tree/mg%2Fbase">base</a></span>
    <a class="head-ref" href="/someone/pagecloud/tree/mg/feature%26fix">head</a>
  </div>`), { base: branch("mg/base"), head: ref("someone/pagecloud", "mg/feature&fix") });
});

test("does not read lookalike refs from PR body content", () => {
  assert.equal(parse(`<div class="markdown-body">${payload()}</div>`), null);
  assert.equal(parse('<div class="markdown-body"><a class="base-ref" href="/pagecloud/pagecloud/tree/main">main</a></div>'), null);
});

test("leaves missing, deleted, malformed, and wrong-repository metadata unreadable", () => {
  assert.equal(parse("<h1>Sign in</h1>"), null);
  assert.equal(parse(payload({ headRepositoryOwnerLogin: null })), null);
  assert.equal(parse(payload().replace('"ownerLogin":"pagecloud"', '"ownerLogin":"other"')), null);
  assert.equal(parse('<script data-target="react-app.embeddedData">not json</script>'), null);
  assert.equal(parse('<div class="gh-header"><a class="base-ref" href="https://evil.example/pagecloud/pagecloud/tree/main">main</a></div>'), null);
});

test("orders a reversed chain from base to tip", () => {
  const root = pull(1, "staging", "first");
  const middle = pull(2, "first", "second");
  const tip = pull(3, "second", "third");
  const stacks = findStacks([tip, middle, root]);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].root, root);
  assert.deepEqual(stacks[0].members.map(({ pull, depth }) => [pull.number, depth]), [[1, 0], [2, 1], [3, 2]]);
});

test("collects branching stacks without grouping unrelated PRs sharing a base", () => {
  const root = pull(1, "staging", "feature");
  const a = pull(2, "feature", "a");
  const b = pull(3, "feature", "b");
  const unrelated = pull(4, "staging", "other");
  assert.deepEqual(findStacks([b, unrelated, root, a])[0].members.map(({ pull }) => pull.number), [1, 3, 2]);
  assert.deepEqual(findStacks([root, unrelated]), []);
});

test("does not connect identical branch names in different forks", () => {
  const root = pull(1, "staging", "feature");
  root.head = ref("fork/pagecloud", "feature");
  assert.deepEqual(findStacks([root, pull(2, "feature", "next")]), []);
});

test("does not guess across missing parents, unreadable PRs, or duplicate heads", () => {
  assert.deepEqual(findStacks([pull(2, "missing", "next"), { number: 3 }]), []);
  assert.deepEqual(findStacks([pull(1, "staging", "a"), pull(2, "staging", "a"), pull(3, "a", "b")]), []);
});

test("leaves self-links and cycles untouched", () => {
  assert.deepEqual(findStacks([pull(1, "a", "a")]), []);
  assert.deepEqual(findStacks([pull(1, "a", "b"), pull(2, "b", "a"), pull(3, "b", "c")]), []);
});

test("supports multiple independent stacks", () => {
  assert.equal(findStacks([pull(1, "main", "a"), pull(2, "a", "b"), pull(3, "main", "c"), pull(4, "c", "d")]).length, 2);
});
