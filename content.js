(() => {
  const { findStacks, listHints, rowOpeningDetails, defaultSettings, normalizeSettings, MetadataCache, readMetadata, PullListView } = globalThis.Pulltergeist;
  const cache = new MetadataCache(chrome.storage.local);
  let settings = { ...defaultSettings };
  let current = null;
  let timer = null;
  let initialized = false;

  function observe() {
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-density", "aria-busy"],
    });
  }

  function mutate(callback) {
    observer.disconnect();
    try {
      callback();
    } finally {
      observe();
    }
  }

  function dispose() {
    if (!current) return;
    current.controller.abort();
    current.view.dispose();
    current = null;
  }

  function listPulls(repo) {
    const hints = listHints(document, repo);
    const pulls = [];
    for (const row of document.querySelectorAll('.js-issue-row, [data-listview-component="items-list"] > li')) {
      const title = row.querySelector('[data-testid="listitem-title-link"], .js-navigation-open');
      for (const anchor of title ? [title] : row.querySelectorAll("a[href]")) {
        const url = new URL(anchor.href, location.href);
        const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
        if (url.origin !== location.origin || match?.[1].toLowerCase() !== repo.toLowerCase()) continue;
        url.hash = "";
        url.search = "";
        const hint = hints.get(match[2]);
        const pull = { row, url: url.href, number: match[2], title: anchor.textContent.trim(), ...hint };
        const details = rowOpeningDetails(row, hint);
        const cached = cache.get(pull);
        Object.assign(pull, { author: details.author || cached?.author || null, openedAt: details.openedAt || cached?.openedAt || null });
        pulls.push(pull);
        break;
      }
    }
    const parents = new Map();
    for (const pull of pulls) parents.set(pull.row.parentElement, (parents.get(pull.row.parentElement) || 0) + 1);
    const list = [...parents].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { list, pulls: pulls.filter(pull => pull.row.parentElement === list) };
  }

  function valid(state) {
    return current === state && !state.controller.signal.aborted && location.href === state.url && state.list.isConnected
      && state.pulls.every(pull => pull.row.parentElement === state.list);
  }

  function paint(state) {
    if (!valid(state)) return;
    state.stacks = findStacks(state.pulls);
    mutate(() => state.view.render(state, settings));
  }

  function hydrate(pull, refs) {
    Object.assign(pull, {
      base: refs.base, head: refs.head, done: true, error: false,
      author: pull.author || refs.author || null, openedAt: pull.openedAt || refs.openedAt || null,
    });
  }

  function pendingPulls(state, requested) {
    const missingDetails = new Set(findStacks(state.pulls)
      .filter(({ root }) => !root.author || !root.openedAt).map(({ root }) => root));
    return state.pulls.filter(pull => !requested.has(pull) && (!pull.done || missingDetails.has(pull)))
      .sort((a, b) => (b.stackSize || 0) - (a.stackSize || 0));
  }

  async function load(state) {
    const requested = new Set();
    const active = new Set();
    let probingStack = false;
    async function read(pull) {
      try {
        const entries = await readMetadata(pull, state);
        if (!valid(state)) return;
        for (const entry of entries) {
          const target = state.pulls.find(candidate => candidate.number === entry.number);
          if (!target) continue;
          cache.set(target, entry);
          hydrate(target, entry);
        }
      } catch (error) {
        if (!valid(state)) return;
        if (!pull.done) Object.assign(pull, { done: true, error: true });
        if (error.status === 429) {
          state.rateLimited = true;
          for (const queued of state.pulls) {
            if (!queued.done) Object.assign(queued, { done: true, error: true });
          }
        }
      }
      paint(state);
    }
    while (valid(state)) {
      const pending = state.rateLimited ? [] : pendingPulls(state, requested);
      while (active.size < 3 && pending.length) {
        // One native-stack probe can fill many queued PRs. Use other slots for unrelated PRs.
        const index = pending.findIndex(pull => !probingStack || !(pull.stackSize > 1));
        if (index === -1) break;
        const [pull] = pending.splice(index, 1);
        requested.add(pull);
        const probe = pull.stackSize > 1;
        if (probe) probingStack = true;
        const task = read(pull).finally(() => {
          active.delete(task);
          if (probe) probingStack = false;
        });
        active.add(task);
      }
      if (!active.size) break;
      await Promise.race(active);
    }
    if (!valid(state)) return;
    try {
      await cache.save();
    } catch (error) {
      state.view.showError(error);
    }
    state.loading = false;
    paint(state);
  }

  async function setPreference(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  async function refresh() {
    mutate(dispose);
    await cache.clear();
    scan(true);
  }

  function scan(force = false) {
    if (!initialized) return;
    const match = location.pathname.match(/^\/([^/]+\/[^/]+)\/pulls\/?$/);
    const { list, pulls } = match ? listPulls(match[1]) : { pulls: [] };
    if (list?.getAttribute("aria-busy") === "true") {
      mutate(dispose);
      return;
    }
    if (!force && current?.url === location.href && current.view.toolbar.isConnected
      && list === current.list && pulls.length === current.pulls.length
      && pulls.every((pull, i) => pull.row === current.pulls[i].row && pull.url === current.pulls[i].url
        && pull.title === current.pulls[i].title && pull.sha === current.pulls[i].sha
        && pull.author === current.pulls[i].author && pull.openedAt === current.pulls[i].openedAt)) {
      paint(current);
      return;
    }
    const expanded = current?.url === location.href ? current.expanded : new Map();
    mutate(dispose);
    if (!list || !pulls.length) return;
    for (const pull of pulls) {
      const hit = cache.get(pull);
      if (hit) hydrate(pull, hit);
    }
    const state = {
      list, pulls, repo: match[1], url: location.href, controller: new AbortController(),
      stacks: [], expanded, loading: false,
      fastAvailable: settings.fastMetadata && list.matches('[data-listview-component="items-list"]'),
    };
    state.loading = settings.enabled && pendingPulls(state, new Set()).length > 0;
    current = state;
    mutate(() => { state.view = new PullListView(list, pulls, setPreference, refresh, schedule); });
    paint(state);
    if (state.loading) void load(state);
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, 80);
  }

  const observer = new MutationObserver(records => {
    if (current && current.url !== location.href) {
      schedule();
      return;
    }
    const relevant = records.filter(record => record.type !== "attributes" || record.target === current?.list
      || (current && record.target.parentElement === current.list)
      || record.target.matches?.('[data-listview-component="items-list"]'));
    if (!relevant.length) return;
    if (current && current.list.isConnected && current.view.toolbar.isConnected
      && !relevant.some(record => current.list.contains(record.target) || record.target.contains(current.list))) return;
    schedule();
  });
  document.addEventListener("turbo:load", schedule);
  document.addEventListener("turbo:render", schedule);
  window.addEventListener("popstate", schedule);
  document.addEventListener("turbo:before-cache", () => {
    clearTimeout(timer);
    timer = null;
    mutate(dispose);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some(key => key in defaultSettings)) return;
    const previous = settings;
    const updates = Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue]));
    settings = normalizeSettings({ ...settings, ...updates });
    if (previous.cacheMetadata !== settings.cacheMetadata) {
      void cache.configure(settings.cacheMetadata).catch(error => current?.view.showError(error));
    }
    if (current && previous.autoExpand !== settings.autoExpand) current.expanded.clear();
    if (previous.enabled !== settings.enabled || previous.fastMetadata !== settings.fastMetadata) scan(true);
    else if (current) paint(current);
  });

  async function initialize() {
    try {
      settings = normalizeSettings(await chrome.storage.local.get(defaultSettings));
      await cache.configure(settings.cacheMetadata);
    } catch {
      cache.persistent = false;
    }
    initialized = true;
    observe();
    scan();
  }
  void initialize();
})();
