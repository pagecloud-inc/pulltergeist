(() => {
  const core = typeof module !== "undefined" && module.exports ? require("./stacks.js") : globalThis.Pulltergeist;
  const ttl = 5 * 60 * 1000;
  const limit = 250;

  function validEntry(entry, now = Date.now()) {
    if (!entry || !Number.isFinite(entry.time) || now - entry.time < 0 || now - entry.time >= ttl) return false;
    const refs = [entry.base, entry.head];
    if (entry.defaultRef != null) refs.push(entry.defaultRef);
    for (const value of refs) {
      try {
        const pair = JSON.parse(value);
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(part => typeof part === "string" && part.length)) return false;
      } catch {
        return false;
      }
    }
    return entry.sha === null || typeof entry.sha === "string";
  }

  class MetadataCache {
    constructor(storage, locks = globalThis.navigator?.locks) {
      this.storage = storage;
      this.locks = locks;
      this.epoch = null;
      this.entries = new Map();
      this.persistent = false;
      this.generation = 0;
      this.pendingSave = Promise.resolve();
    }

    prune() {
      for (const [url, entry] of this.entries) {
        if (!validEntry(entry)) this.entries.delete(url);
      }
      while (this.entries.size > limit) this.entries.delete(this.entries.keys().next().value);
    }

    exclusive(callback) {
      return this.locks ? this.locks.request("pulltergeist:metadata", callback) : callback();
    }

    adoptEpoch(epoch = null) {
      if (this.epoch === epoch) return false;
      this.epoch = epoch;
      this.generation++;
      this.entries.clear();
      return true;
    }

    merge(metadata) {
      const changed = new Set();
      for (const [url, entry] of Object.entries(metadata || {})) {
        if (!validEntry(entry)) continue;
        const existing = this.entries.get(url);
        if (existing && existing.time >= entry.time) continue;
        this.entries.set(url, { ...entry, ...core.openingDetails(entry.author || existing?.author, entry.openedAt || existing?.openedAt) });
        changed.add(url);
      }
      this.prune();
      return changed;
    }

    async configure(persistent, snapshot = null) {
      this.persistent = persistent;
      this.generation++;
      const generation = this.generation;
      if (!persistent) {
        await this.pendingSave.catch(() => {});
        await this.exclusive(async () => {
          if (generation === this.generation && !this.persistent) await this.storage.remove("metadata");
        });
        return;
      }
      const stored = snapshot ?? await this.storage.get({ metadata: null, metadataEpoch: null });
      if (generation !== this.generation) return;
      this.adoptEpoch(stored.metadataEpoch);
      this.merge(stored.metadata);
    }

    get(pull) {
      const entry = this.entries.get(pull.url);
      if (!validEntry(entry) || (pull.sha && pull.sha !== entry.sha)) return null;
      return { ...entry, ...core.openingDetails(entry.author, entry.openedAt) };
    }

    set(pull, refs) {
      this.entries.delete(pull.url);
      this.entries.set(pull.url, {
        base: refs.base, head: refs.head, sha: refs.sha || null, time: Date.now(),
        defaultRef: pull.defaultRef || refs.defaultRef || null,
        ...core.openingDetails(pull.author || refs.author, pull.openedAt || refs.openedAt),
      });
      this.prune();
    }

    save() {
      const generation = this.generation;
      const epoch = this.epoch;
      const write = async () => {
        if (!this.persistent || generation !== this.generation) return;
        const stored = await this.storage.get({ cacheMetadata: true, metadata: null, metadataEpoch: null });
        if (!stored.cacheMetadata || !this.persistent || generation !== this.generation || stored.metadataEpoch !== epoch) return;
        this.merge(stored.metadata);
        this.prune();
        await this.storage.set({ metadata: Object.fromEntries(this.entries) });
        const { cacheMetadata: stillEnabled = true } = await this.storage.get("cacheMetadata");
        if (!stillEnabled) await this.storage.remove("metadata");
      };
      this.pendingSave = this.pendingSave.catch(() => {}).then(() => this.exclusive(write));
      return this.pendingSave;
    }

    async clear() {
      this.generation++;
      this.entries.clear();
      await this.pendingSave.catch(() => {});
      await this.exclusive(async () => {
        this.adoptEpoch(crypto.randomUUID());
        await this.storage.set({ metadataEpoch: this.epoch, metadata: {} });
      });
    }
  }

  class GitHubError extends Error {
    constructor(status) {
      super(`GitHub returned ${status}`);
      this.status = status;
    }
  }

  const htmlRequests = new WeakMap();

  async function readHtml(pull, state, options) {
    if (!htmlRequests.has(state)) htmlRequests.set(state, new Set());
    const pending = htmlRequests.get(state);
    while (pending.size >= 3) await Promise.race([...pending].map(task => task.catch(() => {})));
    options.signal.throwIfAborted();
    if (state.rateLimited) throw new GitHubError(429);
    const task = (async () => {
      const response = await fetch(pull.url, options);
      if (response.status === 429) state.rateLimited = true;
      if (!response.ok) throw new GitHubError(response.status);
      const document = new DOMParser().parseFromString(await response.text(), "text/html");
      const entries = core.metadataFromPage(document, state.repo, pull.number);
      if (!entries.length) throw new Error("GitHub branch metadata unavailable");
      return entries;
    })();
    pending.add(task);
    try {
      return await task;
    } finally {
      pending.delete(task);
    }
  }

  async function readMetadata(pull, state) {
    const options = {
      credentials: "same-origin", redirect: "error", priority: state.priority || "auto",
      signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(15000)]),
    };
    if (state.fastAvailable) {
      const response = await fetch(`${pull.url}/_layout`, { ...options, headers: { Accept: "application/json" } });
      if (response.status === 429) state.rateLimited = true;
      if ([401, 403, 429].includes(response.status) || response.status >= 500) throw new GitHubError(response.status);
      if (response.ok) {
        try {
          const entries = core.metadataFromPayload(await response.json(), state.repo, pull.number);
          if (entries.length) return entries;
        } catch (error) {
          if (options.signal.aborted) throw error;
        }
      }
      state.fastAvailable = false;
    }
    return readHtml(pull, state, options);
  }

  const api = { MetadataCache, readMetadata };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(globalThis.Pulltergeist, api);
})();
