(() => {
  const core = typeof module !== "undefined" && module.exports ? require("./stacks.js") : globalThis.Pulltergeist;
  const ttl = 5 * 60 * 1000;
  const limit = 250;

  function validEntry(entry, now = Date.now()) {
    if (!entry || !Number.isFinite(entry.time) || now - entry.time < 0 || now - entry.time >= ttl) return false;
    for (const value of [entry.base, entry.head]) {
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
    constructor(storage) {
      this.storage = storage;
      this.entries = new Map();
      this.persistent = false;
      this.generation = 0;
    }

    prune() {
      for (const [url, entry] of this.entries) {
        if (!validEntry(entry)) this.entries.delete(url);
      }
      while (this.entries.size > limit) this.entries.delete(this.entries.keys().next().value);
    }

    async configure(persistent) {
      this.persistent = persistent;
      this.generation++;
      if (!persistent) {
        await this.storage.remove("metadata");
        return;
      }
      const generation = this.generation;
      const { metadata } = await this.storage.get("metadata");
      if (generation !== this.generation) return;
      for (const [url, entry] of Object.entries(metadata || {})) {
        if (validEntry(entry) && !this.entries.has(url)) this.entries.set(url, entry);
      }
      this.prune();
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
        ...core.openingDetails(pull.author || refs.author, pull.openedAt || refs.openedAt),
      });
      this.prune();
    }

    async save() {
      if (!this.persistent) return;
      const generation = this.generation;
      const { cacheMetadata = true } = await this.storage.get("cacheMetadata");
      if (!cacheMetadata || !this.persistent || generation !== this.generation) return;
      this.prune();
      await this.storage.set({ metadata: Object.fromEntries(this.entries) });
      const { cacheMetadata: stillEnabled = true } = await this.storage.get("cacheMetadata");
      if (!stillEnabled) await this.storage.remove("metadata");
    }

    async clear() {
      this.generation++;
      this.entries.clear();
      await this.storage.remove("metadata");
    }
  }

  class GitHubError extends Error {
    constructor(status) {
      super(`GitHub returned ${status}`);
      this.status = status;
    }
  }

  async function readMetadata(pull, state) {
    const options = {
      credentials: "same-origin", redirect: "error",
      signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(15000)]),
    };
    if (state.fastAvailable) {
      const response = await fetch(`${pull.url}/_layout`, { ...options, headers: { Accept: "application/json" } });
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
    const response = await fetch(pull.url, options);
    if (!response.ok) throw new GitHubError(response.status);
    const document = new DOMParser().parseFromString(await response.text(), "text/html");
    const entries = core.metadataFromPage(document, state.repo, pull.number);
    if (!entries.length) throw new Error("GitHub branch metadata unavailable");
    return entries;
  }

  const api = { MetadataCache, readMetadata };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(globalThis.Pulltergeist, api);
})();
