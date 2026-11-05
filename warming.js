(() => {
  const core = typeof module !== "undefined" && module.exports ? require("./stacks.js") : globalThis.Pulltergeist;

  class PageMetadataLearner {
    constructor(cache) {
      this.cache = cache;
      this.observed = new Map();
    }

    collect(document, href, enabled = true) {
      const url = new URL(href);
      const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/);
      if (url.origin !== "https://github.com" || !match || document.documentElement.hasAttribute("data-turbo-preview")) {
        this.last = null;
        return false;
      }
      const scripts = [...document.querySelectorAll('script[data-target="react-app.embeddedData"]')];
      const texts = scripts.map(script => script.textContent);
      if (this.last?.href === href && this.last.enabled === enabled && scripts.length === this.last.scripts.length
        && scripts.every((script, i) => script === this.last.scripts[i] && texts[i] === this.last.texts[i])) return false;
      this.last = { href, enabled, scripts, texts };
      const entries = core.metadataFromPage(document, match[1], match[2], { embeddedOnly: true });
      if (!entries.length) return false;
      const key = `https://github.com/${match[1]}/pull/${match[2]}`;
      const fingerprint = JSON.stringify(entries);
      let observed = this.observed.get(key);
      if (!observed || observed.fingerprint !== fingerprint) {
        observed = { fingerprint, time: Date.now(), epoch: this.cache.epoch };
        this.observed.delete(key);
        this.observed.set(key, observed);
        if (this.observed.size > 250) this.observed.delete(this.observed.keys().next().value);
      }
      if (!enabled || observed.epoch !== this.cache.epoch) return false;
      return this.cache.merge(Object.fromEntries(entries.map(entry => [
        `https://github.com/${match[1]}/pull/${entry.number}`, { ...entry, time: observed.time },
      ]))).size > 0;
    }
  }

  class ListPrewarmer {
    constructor(cache, readMetadata, canWarm = () => true) {
      this.cache = cache;
      this.readMetadata = readMetadata;
      this.canWarm = canWarm;
      this.events = null;
      this.controller = null;
      this.timer = null;
      this.anchor = null;
      this.source = null;
      this.warmed = new Map();
      this.cooldown = 0;
    }

    update(settings) {
      if (this.settings && this.settings.fastMetadata !== settings.fastMetadata) this.cancel();
      this.settings = settings;
      if (!settings.enabled || !settings.cacheMetadata || !this.cache.persistent || !settings.prewarm) {
        this.dispose();
        return;
      }
      if (this.events) return;
      this.events = new AbortController();
      const options = { capture: true, signal: this.events.signal };
      document.addEventListener("pointerover", event => {
        if (event.pointerType !== "touch") this.intent(event.target);
      }, options);
      document.addEventListener("focusin", event => this.intent(event.target), options);
      document.addEventListener("pointerout", event => {
        if (this.anchor?.contains(event.target) && !this.anchor.contains(event.relatedTarget)
          && !this.anchor.contains(document.activeElement)) this.cancel();
      }, options);
      document.addEventListener("focusout", event => {
        if (this.anchor?.contains(event.target) && !this.anchor.contains(event.relatedTarget) && !this.anchor.matches(":hover")) this.cancel();
      }, options);
      document.addEventListener("visibilitychange", () => { if (document.hidden) this.cancel(); }, options);
      document.addEventListener("turbo:before-visit", () => this.cancel(), options);
      window.addEventListener("pagehide", () => this.cancel(), options);
      const focused = document.activeElement?.closest("a[href]");
      const hovered = document.querySelector("a[href]:hover");
      if (focused || hovered) this.intent(focused || hovered);
    }

    intent(target) {
      const anchor = target.closest?.("a[href]");
      if (!anchor || anchor === this.anchor || document.hidden || !this.canWarm() || Date.now() < this.cooldown) return;
      const url = new URL(anchor.href, location.href);
      const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/pulls(?:\/[^/]+)?\/?$/);
      url.hash = "";
      url.pathname = url.pathname.replace(/\/$/, "");
      if (url.origin !== location.origin || url.username || url.password || !match || url.href === location.href
        || Date.now() - (this.warmed.get(url.href) || 0) < 5 * 60 * 1000) return;
      this.cancel();
      this.anchor = anchor;
      this.source = location.href;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.run(url, match[1]);
      }, 200);
    }

    async run(url, repo) {
      if (!this.canWarm() || !this.anchor?.isConnected) return;
      const controller = new AbortController();
      this.controller = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
      const epoch = this.cache.epoch;
      const source = this.source;
      const active = () => !signal.aborted && this.cache.epoch === epoch && this.source === source && location.href === source;
      try {
        const response = await fetch(url, { credentials: "same-origin", redirect: "error", priority: "low", signal });
        if (response.status === 429) this.cooldown = Date.now() + 60000;
        if (!response.ok || !active()) return;
        const document = new DOMParser().parseFromString(await response.text(), "text/html");
        const { list, pulls } = core.pullList(document, repo, url.href);
        if (!active() || !list || list.getAttribute("aria-busy") === "true" || !pulls.length) return;
        const state = { pulls, repo, controller: { signal }, fastAvailable: this.settings.fastMetadata
          && list.matches('[data-listview-component="items-list"]'), priority: "low" };
        let requests = 0;
        for (const pull of core.prioritizePulls(pulls)) {
          if (!active() || requests >= 6) break;
          if (pull.done || this.cache.get(pull)) continue;
          requests++;
          const entries = await this.readMetadata(pull, state);
          if (!active()) return;
          for (const entry of entries) {
            const target = pulls.find(candidate => candidate.number === entry.number);
            if (!target) continue;
            this.cache.set(target, entry);
            target.done = true;
          }
          await this.cache.save();
        }
        if (active()) {
          this.warmed.set(url.href, Date.now());
          if (this.warmed.size > 20) this.warmed.delete(this.warmed.keys().next().value);
        }
      } catch (error) {
        if (error.status === 429) this.cooldown = Date.now() + 60000;
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    }

    cancel() {
      clearTimeout(this.timer);
      this.timer = null;
      this.controller?.abort();
      this.controller = null;
      this.anchor = null;
      this.source = null;
    }

    invalidate() {
      this.warmed.clear();
      this.cancel();
    }

    dispose() {
      this.events?.abort();
      this.events = null;
      this.invalidate();
    }
  }

  const api = { PageMetadataLearner, ListPrewarmer };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(globalThis.Pulltergeist, api);
})();
