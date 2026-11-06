(() => {
  const { findStacks, pullList, prioritizePulls, defaultSettings, normalizeSettings, MetadataCache, readMetadata, PageMetadataLearner, ListPrewarmer, PullListView } = globalThis.Pulltergeist;
  const cache = new MetadataCache(chrome.storage.local);
  const learner = new PageMetadataLearner(cache);
  const prewarmer = new ListPrewarmer(cache, readMetadata, () => !current?.loading && !current?.rateLimited);
  let settings = { ...defaultSettings };
  let current = null;
  let frame = null;
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
    const result = pullList(document, repo, location.href);
    for (const pull of result.pulls) {
      const cached = cache.get(pull);
      pull.defaultRef ||= cached?.defaultRef || null;
      pull.author ||= cached?.author || null;
      pull.openedAt ||= cached?.openedAt || null;
    }
    return result;
  }

  function active(state) {
    return current === state && !state.controller.signal.aborted && location.href === state.url;
  }

  function valid(state) {
    return active(state) && state.list.isConnected && state.pulls.every(pull => pull.row.parentElement === state.list);
  }

  function paint(state) {
    if (!valid(state)) return;
    state.stacks = findStacks(state.pulls);
    mutate(() => state.view.render(state, settings));
  }

  function hydrate(pull, refs) {
    Object.assign(pull, {
      base: refs.base, head: refs.head, done: true, error: false,
      defaultRef: pull.defaultRef || refs.defaultRef || null,
      author: pull.author || refs.author || null, openedAt: pull.openedAt || refs.openedAt || null,
    });
  }

  function pendingPulls(state, requested) {
    const missingDetails = new Set(findStacks(state.pulls)
      .filter(({ root }) => !root.author || !root.openedAt).map(({ root }) => root));
    const pending = state.pulls.filter(pull => !requested.has(pull) && (!pull.done || missingDetails.has(pull)));
    if (!pending.length && !requested.size && !state.pulls.some(pull => pull.defaultRef)) {
      return prioritizePulls(state.pulls).slice(0, 1);
    }
    return prioritizePulls(pending);
  }

  async function load(state) {
    const requested = new Set();
    const inFlight = new Set();
    const probes = new Set();
    let firstStackSaved = null;
    async function read(pull) {
      const epoch = cache.epoch;
      try {
        const entries = await readMetadata(pull, state);
        if (!active(state)) return;
        for (const entry of entries) {
          const target = state.pulls.find(candidate => candidate.number === entry.number);
          if (!target) continue;
          if (cache.epoch === epoch) cache.set(target, entry);
          hydrate(target, entry);
        }
      } catch (error) {
        if (!active(state)) return;
        if (!pull.done) Object.assign(pull, { done: true, error: true });
        if (error.status === 429) {
          state.rateLimited = true;
          for (const queued of state.pulls) {
            if (!queued.done) Object.assign(queued, { done: true, error: true });
          }
        }
      }
      paint(state);
      if (!firstStackSaved && state.stacks.length) {
        firstStackSaved = cache.save().catch(error => {
          if (valid(state)) state.view.showError(error);
        });
      }
    }
    while (active(state)) {
      const pending = state.rateLimited ? [] : pendingPulls(state, requested);
      const concurrency = state.fastAvailable ? 6 : 3;
      while (inFlight.size < concurrency && pending.length) {
        // Different sizes or the same position identify independent probes, not grouping relationships.
        const index = pending.findIndex(pull => !(pull.stackSize > 1) || [...probes].every(probe =>
          probe.stackSize !== pull.stackSize || (pull.stackPosition > 0 && pull.stackPosition === probe.stackPosition)));
        if (index === -1) break;
        const [pull] = pending.splice(index, 1);
        requested.add(pull);
        const probe = pull.stackSize > 1;
        if (probe) probes.add(pull);
        const task = read(pull).finally(() => {
          inFlight.delete(task);
          probes.delete(pull);
        });
        inFlight.add(task);
      }
      if (!inFlight.size) break;
      await Promise.race(inFlight);
    }
    if (!active(state)) return;
    try {
      if (firstStackSaved) await firstStackSaved;
      if (!active(state)) return;
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
    prewarmer.invalidate();
    mutate(dispose);
    await cache.clear();
    scan(true);
  }

  function scan(force = false) {
    if (!initialized) return;
    if (prewarmer.source && prewarmer.source !== location.href) prewarmer.cancel();
    if (learner.collect(document, location.href, settings.enabled)) void cache.save().catch(error => current?.view.showError(error));
    const match = location.pathname.match(/^\/([^/]+\/[^/]+)\/pulls(?:\/[^/]+)?\/?$/);
    const { list, pulls } = match ? listPulls(match[1]) : { pulls: [] };
    if (list?.getAttribute("aria-busy") === "true") {
      mutate(dispose);
      return;
    }
    if (!force && current?.url === location.href && pulls.length === current.pulls.length
      && pulls.every((pull, i) => pull.url === current.pulls[i].url && pull.title === current.pulls[i].title
        && pull.sha === current.pulls[i].sha && pull.defaultRef === current.pulls[i].defaultRef && pull.author === current.pulls[i].author && pull.openedAt === current.pulls[i].openedAt)) {
      if (list !== current.list || !current.view.toolbar.isConnected || pulls.some((pull, i) => pull.row !== current.pulls[i].row)) {
        mutate(() => {
          current.view.rebind(list, pulls);
          current.list = list;
        });
      }
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
      rateLimited: false,
    };
    state.loading = settings.enabled && pendingPulls(state, new Set()).length > 0;
    current = state;
    mutate(() => { state.view = new PullListView(list, pulls, setPreference, refresh, schedule); });
    paint(state);
    if (state.loading) {
      prewarmer.cancel();
      void load(state);
    }
  }

  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      scan();
    });
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
    prewarmer.cancel();
    cancelAnimationFrame(frame);
    frame = null;
    mutate(dispose);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("metadataEpoch" in changes && cache.adoptEpoch(changes.metadataEpoch.newValue)) prewarmer.invalidate();
    if (changes.metadata && settings.cacheMetadata && cache.persistent) {
      cache.merge(changes.metadata.newValue);
      if (current && active(current)) {
        let changed = false;
        for (const pull of current.pulls) {
          const hit = cache.get(pull);
          if (hit && (!pull.done || pull.error || pull.base !== hit.base || pull.head !== hit.head
            || (!pull.defaultRef && hit.defaultRef) || (!pull.author && hit.author) || (!pull.openedAt && hit.openedAt))) {
            hydrate(pull, hit);
            changed = true;
          }
        }
        if (changed) paint(current);
      }
    }
    if (!Object.keys(changes).some(key => key in defaultSettings)) return;
    const previous = settings;
    const updates = Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue]));
    settings = normalizeSettings({ ...settings, ...updates });
    if (previous.cacheMetadata !== settings.cacheMetadata) {
      void cache.configure(settings.cacheMetadata).then(() => {
        if (settings.cacheMetadata) return cache.save();
      }).catch(error => current?.view.showError(error));
    }
    prewarmer.update(settings);
    if (current && previous.autoExpand !== settings.autoExpand) current.expanded.clear();
    if (previous.enabled !== settings.enabled || previous.fastMetadata !== settings.fastMetadata) scan(true);
    else if (current) paint(current);
  });

  async function initialize() {
    try {
      const stored = await chrome.storage.local.get({ ...defaultSettings, metadata: null, metadataEpoch: null });
      settings = normalizeSettings(stored);
      await cache.configure(settings.cacheMetadata, stored);
    } catch {
      cache.persistent = false;
    }
    initialized = true;
    prewarmer.update(settings);
    observe();
    scan();
  }
  void initialize();
})();
