(() => {
  function ref(repo, branch) {
    if (typeof repo !== "string" || typeof branch !== "string" || !repo || !branch) return null;
    return JSON.stringify([repo.toLowerCase(), branch]);
  }

  function openingDetails(author, openedAt) {
    return {
      author: typeof author === "string" && author.trim() ? author.trim() : null,
      openedAt: typeof openedAt === "string" && Number.isFinite(Date.parse(openedAt)) ? new Date(openedAt).toISOString() : null,
    };
  }

  function rowOpeningDetails(row, hint = {}) {
    const author = row.querySelector('[data-testid="author-filter-link"], .opened-by a, a.author');
    const timestamp = row.querySelector('[data-testid="timestamp-container"], .opened-by');
    const time = timestamp && /\bopened\b/i.test(timestamp.textContent)
      ? timestamp.querySelector('relative-time[datetime], time[datetime]') : null;
    return openingDetails(author?.textContent || hint.author, hint.openedAt || time?.getAttribute("datetime"));
  }

  function refsFromRoute(route, repo) {
    const pr = route?.pullRequest;
    const baseRepo = route?.repository;
    if (`${baseRepo?.ownerLogin}/${baseRepo?.name}`.toLowerCase() !== repo.toLowerCase()) return null;
    const headRepo = pr?.headRepositoryOwnerLogin && pr?.headRepositoryName
      ? `${pr.headRepositoryOwnerLogin}/${pr.headRepositoryName}` : null;
    const base = ref(repo, pr?.baseBranch);
    const head = ref(headRepo, pr?.headBranch);
    return base && head ? { base, head } : null;
  }

  function defaultBranchRef(repository, repo) {
    return `${repository?.ownerLogin}/${repository?.name}`.toLowerCase() === repo.toLowerCase()
      ? ref(repo, repository.defaultBranch) : null;
  }

  function metadataFromPayload(payload, repo, number) {
    const route = payload?.payload?.pullRequestsLayoutRoute;
    const refs = refsFromRoute(route, repo);
    if (!refs || String(route.pullRequest.number) !== String(number)) return [];
    const details = openingDetails(route.pullRequest.author?.login, route.pullRequest.createdTime);
    const defaultRef = defaultBranchRef(route.repository, repo);
    const result = [{ number: String(number), ...refs, sha: route.pullRequest.headSha || null, defaultRef, ...details }];
    const stack = route.stack;
    if (!stack || `${stack.repositoryOwnerLogin}/${stack.repositoryName}`.toLowerCase() !== repo.toLowerCase()
      || !Array.isArray(stack.pulls) || stack.size !== stack.pulls.length
      || !stack.pulls.length || !stack.baseBranch) return result;
    const members = [...stack.pulls].reverse();
    const derived = [];
    const seen = new Set();
    const heads = new Set();
    let base = ref(repo, stack.baseBranch);
    for (const member of members) {
      const head = ref(repo, member.headBranch);
      const id = String(member.number);
      if (!head || !/^\d+$/.test(id) || seen.has(id) || heads.has(head) || !["OPEN", "DRAFT"].includes(member.state)
        || member.url?.toLowerCase() !== `/${repo}/pull/${id}`.toLowerCase()) return result;
      seen.add(id);
      heads.add(head);
      derived.push({ number: id, base, head, sha: member.headOid || null, defaultRef });
      base = head;
    }
    const requested = derived.find(member => member.number === String(number));
    // Only trust inferred neighbors when the explicit PR refs verify GitHub's stack ordering.
    if (!requested || requested.base !== refs.base || requested.head !== refs.head) return result;
    Object.assign(requested, details);
    return derived;
  }

  function pagePayloads(document) {
    const payloads = [];
    for (const script of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
      if (script.closest(".markdown-body")) continue;
      try {
        const payload = JSON.parse(script.textContent);
        if (payload && typeof payload === "object") payloads.push(payload);
      } catch {
        // A malformed or unrelated payload is not branch metadata.
      }
    }
    return payloads;
  }

  function parseRefs(document, repo) {
    for (const payload of pagePayloads(document)) {
      const refs = refsFromRoute(payload.payload?.pullRequestsLayoutRoute, repo);
      if (refs) return refs;
    }

    const header = document.querySelector("#partial-discussion-header, .gh-header");
    function branch(selector) {
      const element = header?.querySelector(selector);
      const anchor = element?.matches("a[href]") ? element : element?.querySelector("a[href]");
      if (!anchor) return null;
      try {
        const url = new URL(anchor.getAttribute("href"), "https://github.com");
        if (url.origin !== "https://github.com") return null;
        const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/tree\/(.+)$/);
        return match ? ref(match[1], decodeURIComponent(match[2])) : null;
      } catch {
        return null;
      }
    }
    const base = branch(".base-ref");
    const head = branch(".head-ref");
    return base && head ? { base, head } : null;
  }

  function metadataFromPage(document, repo, number, { embeddedOnly = false } = {}) {
    for (const payload of pagePayloads(document)) {
      if (!payload.payload?.pullRequestsLayoutRoute) continue;
      return metadataFromPayload(payload, repo, number);
    }
    if (embeddedOnly) return [];
    const refs = parseRefs(document, repo);
    return refs ? [{ number: String(number), ...refs, sha: null }] : [];
  }

  function listHints(document, repo, payloads = pagePayloads(document)) {
    for (const payload of payloads) {
      const results = payload.payload?.repoPullsDashboardContentRoute?.results;
      if (!Array.isArray(results)) continue;
      return new Map(results.filter(item => item.repoNameWithOwner?.toLowerCase() === repo.toLowerCase())
        .map(item => [String(item.number), {
          sha: item.headSha || null, stackSize: item.stackSize || 0,
          stackPosition: Number.isInteger(item.stackPosition) && item.stackPosition > 0 && item.stackPosition <= item.stackSize ? item.stackPosition : 0,
          ...openingDetails(item.author?.displayLogin, item.createdAt),
        }]));
    }
    return new Map();
  }

  function pullList(document, repo, baseUrl) {
    const payloads = pagePayloads(document);
    const hints = listHints(document, repo, payloads);
    let defaultRef = null;
    for (const payload of payloads) {
      defaultRef = defaultBranchRef(payload.payload?.repoPullsDashboardLayoutRoute?.repository, repo);
      if (defaultRef) break;
    }
    const pulls = [];
    for (const row of document.querySelectorAll('.js-issue-row, [data-listview-component="items-list"] > li')) {
      const title = row.querySelector('[data-testid="listitem-title-link"], .js-navigation-open');
      for (const anchor of title ? [title] : row.querySelectorAll("a[href]")) {
        let url;
        try { url = new URL(anchor.getAttribute("href"), baseUrl); } catch { continue; }
        const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
        if (url.origin !== "https://github.com" || match?.[1].toLowerCase() !== repo.toLowerCase()) continue;
        url.hash = "";
        url.search = "";
        const hint = hints.get(match[2]);
        pulls.push({ row, url: url.href, number: match[2], title: anchor.textContent.trim(), defaultRef, ...hint, ...rowOpeningDetails(row, hint) });
        break;
      }
    }
    const parents = new Map();
    for (const pull of pulls) parents.set(pull.row.parentElement, (parents.get(pull.row.parentElement) || 0) + 1);
    const list = [...parents].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { list, pulls: pulls.filter(pull => pull.row.parentElement === list) };
  }

  function prioritizePulls(pulls) {
    const native = pulls.filter(pull => pull.stackSize > 1).sort((a, b) =>
      (a.stackPosition || Infinity) - (b.stackPosition || Infinity) || b.stackSize - a.stackSize);
    const remaining = pulls.filter(pull => !(pull.stackSize > 1));
    for (let first = 0, last = remaining.length - 1; first <= last;) {
      native.push(remaining[first++]);
      if (first <= last) native.push(remaining[last--]);
    }
    return native;
  }

  function findStacks(pulls) {
    const defaults = new Set(pulls.map(pull => pull.defaultRef).filter(Boolean));
    if (!defaults.size) return [];
    const heads = new Map();
    for (const pull of pulls) {
      if (!pull.head || defaults.has(pull.head)) continue;
      const matches = heads.get(pull.head) || [];
      matches.push(pull);
      heads.set(pull.head, matches);
    }
    const parent = new Map();
    const children = new Map(pulls.map(pull => [pull, []]));
    for (const pull of pulls) {
      if (defaults.has(pull.head)) continue;
      const candidates = heads.get(pull.base) || [];
      if (candidates.length !== 1 || candidates[0] === pull) continue;
      parent.set(pull, candidates[0]);
      children.get(candidates[0]).push(pull);
    }

    const visited = new Set();
    const stacks = [];
    for (const pull of pulls) {
      if (visited.has(pull)) continue;
      const component = new Set();
      const pending = [pull];
      while (pending.length) {
        const next = pending.pop();
        if (component.has(next)) continue;
        component.add(next);
        if (parent.has(next)) pending.push(parent.get(next));
        pending.push(...children.get(next));
      }
      for (const item of component) visited.add(item);
      if (component.size < 2) continue;
      const roots = [...component].filter(item => !parent.has(item));
      // Cyclic or ambiguous branch relationships should remain untouched.
      if (roots.length !== 1) continue;
      const members = [];
      function walk(item, depth) {
        members.push({ pull: item, depth });
        for (const child of children.get(item)) walk(child, depth + 1);
      }
      walk(roots[0], 0);
      stacks.push({ root: roots[0], members });
    }
    return stacks;
  }

  const api = { ref, openingDetails, rowOpeningDetails, parseRefs, metadataFromPayload, metadataFromPage, listHints, pullList, prioritizePulls, findStacks };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.Pulltergeist = api;
})();
