(() => {
  const { settingsFields } = globalThis.Pulltergeist;
  const iconPaths = {
    chevron: "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
    "stack-icon": "M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.251 1.251 0 0 1 0-2.162ZM8.125 1.69a.248.248 0 0 0-.25 0l-4.63 2.685 4.63 2.685a.248.248 0 0 0 .25 0l4.63-2.685ZM1.601 7.789a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0L1.874 8.814A.75.75 0 0 1 1.6 7.789Zm0 3.5a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0l-5.248-3.044a.75.75 0 0 1-.273-1.025Z",
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name, size = 16) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `pulltergeist-${name}`);
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", iconPaths[name]);
    svg.append(path);
    return svg;
  }

  class PullListView {
    constructor(list, pulls, onSetting, onRefresh, onLayoutChange) {
      this.list = list;
      this.pulls = pulls;
      this.groups = [];
      this.signature = null;
      this.referenceRow = null;
      this.metrics = null;
      this.events = new AbortController();
      const refreshLayout = () => {
        if (!this.metrics || !this.list.isConnected) return;
        this.signature = null;
        onLayoutChange();
      };
      window.addEventListener("load", refreshLayout, { once: true, signal: this.events.signal });
      document.fonts.addEventListener("loadingdone", refreshLayout, { signal: this.events.signal });
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.metrics || !this.list.isConnected) return;
        const width = this.list.getBoundingClientRect().width;
        const measured = this.referenceRow && this.measureRow(this.referenceRow);
        if (Math.abs(width - this.metrics.width) < 0.5 && (!measured
          || (Math.abs(measured.height - this.metrics.height) < 0.5 && Math.abs(measured.inset - this.metrics.inset) < 0.5))) return;
        if (measured) {
          this.applyMetrics({ ...measured, width });
        } else refreshLayout();
      });
      this.resizeObserver.observe(list);
      this.toolbar = element("div", "pulltergeist-toolbar");
      this.status = element("span");
      this.status.setAttribute("role", "status");
      this.toggle = element("button");
      this.toggle.type = "button";
      this.toggle.addEventListener("click", () => this.save(onSetting, "enabled", !this.settings.enabled));
      const refresh = element("button", "", "Refresh");
      refresh.type = "button";
      refresh.title = "Discard cached metadata and re-read branch relationships";
      refresh.addEventListener("click", () => onRefresh().catch(error => this.showError(error, "Could not refresh")));
      this.error = element("span", "pulltergeist-error");
      this.error.setAttribute("role", "alert");
      this.error.hidden = true;
      this.inputs = new Map();
      const details = element("details", "pulltergeist-settings");
      const panel = element("div", "pulltergeist-settings-panel");
      details.append(element("summary", "", "Settings"), panel);
      document.addEventListener("click", event => {
        if (details.open && !event.composedPath().includes(details)) details.open = false;
      }, { capture: true, signal: this.events.signal });
      document.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !details.open) return;
        details.open = false;
        details.querySelector("summary").focus({ preventScroll: true });
      }, { capture: true, signal: this.events.signal });
      for (const field of settingsFields) {
        const label = element("label", "pulltergeist-setting");
        const input = element("input");
        input.type = "checkbox";
        input.setAttribute("aria-label", field.label);
        input.addEventListener("change", () => this.save(onSetting, field.key, input.checked));
        const description = element("span");
        description.append(element("span", "pulltergeist-setting-title", field.label), element("small", "", field.description));
        label.append(input, description);
        panel.append(label);
        this.inputs.set(field.key, input);
      }
      panel.append(element("p", "", "Settings stay in this browser. Nothing is synced or sent to a backend."));
      const brand = element("strong", "pulltergeist-brand");
      const logo = element("img", "pulltergeist-logo");
      logo.src = chrome.runtime.getURL("icons/icon-32.png");
      logo.width = 20;
      logo.height = 20;
      logo.alt = "";
      brand.append(logo, document.createTextNode("Pulltergeist"));
      this.toolbar.append(brand, this.status, this.toggle, refresh, details, this.error);
      list.before(this.toolbar);
    }

    async save(onSetting, key, value) {
      this.error.hidden = true;
      try {
        await onSetting(key, value);
      } catch (error) {
        const input = this.inputs.get(key);
        if (input) input.checked = this.settings[key];
        this.showError(error, "Could not save setting");
      }
    }

    showError(error, context) {
      this.error.textContent = `${context}: ${error.message}`;
      this.error.hidden = false;
    }

    measureRow(row) {
      const bounds = row.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return null;
      const status = row.querySelector('svg[class*="octicon-git-"]');
      const title = row.querySelector('[data-testid="listitem-title-link"], .js-navigation-open');
      const inset = status?.getBoundingClientRect().width
        ? status.getBoundingClientRect().left - bounds.left
        : Math.max(16, (title?.getBoundingClientRect().left ?? bounds.left) - bounds.left - 24);
      return { height: bounds.height, inset };
    }

    applyMetrics(metrics) {
      this.metrics = metrics;
      this.list.style.setProperty("--pulltergeist-row-height", `${metrics.height}px`);
      this.list.style.setProperty("--pulltergeist-icon-inset", `${metrics.inset}px`);
    }

    matchNativeRows(stacks) {
      const members = new Set(stacks.flatMap(stack => stack.members.map(({ pull }) => pull.row)));
      const standalone = this.pulls.filter(({ row }) => !members.has(row));
      const candidates = (standalone.length ? standalone : this.pulls)
        .map(({ row }) => ({ row, metrics: this.measureRow(row) })).filter(item => item.metrics);
      if (!candidates.length) return;
      candidates.sort((a, b) => a.metrics.height - b.metrics.height);
      const reference = candidates.find(item => item.row === this.referenceRow) || candidates[Math.floor(candidates.length / 2)];
      if (reference.row !== this.referenceRow) {
        if (this.referenceRow) this.resizeObserver.unobserve(this.referenceRow);
        this.referenceRow = reference.row;
        this.resizeObserver.observe(this.referenceRow);
      }
      this.applyMetrics({ ...reference.metrics, width: this.list.getBoundingClientRect().width });
    }

    clearGroups() {
      for (const group of this.groups) group.remove();
      this.groups = [];
      this.list.classList.remove("pulltergeist-list", "pulltergeist-compact");
      this.list.style.removeProperty("--pulltergeist-row-height");
      this.list.style.removeProperty("--pulltergeist-icon-inset");
      for (const { row } of this.pulls) {
        row.classList.remove("pulltergeist-row", "pulltergeist-member", "pulltergeist-collapsed");
        row.style.removeProperty("--pulltergeist-order");
      }
    }

    rebind(list, pulls) {
      this.resizeObserver.disconnect();
      this.clearGroups();
      this.pulls.forEach((pull, index) => { pull.row = pulls[index].row; });
      this.list = list;
      this.referenceRow = null;
      this.metrics = null;
      this.signature = null;
      this.resizeObserver.observe(list);
      if (this.toolbar.nextElementSibling !== list) list.before(this.toolbar);
    }

    intact() {
      return this.toolbar.isConnected && this.groups.every(group => group.parentElement === this.list)
        && (!this.groups.length || (this.list.classList.contains("pulltergeist-list")
          && this.pulls.every(({ row }) => row.classList.contains("pulltergeist-row") && row.style.getPropertyValue("--pulltergeist-order"))));
    }

    dispose() {
      this.events.abort();
      this.resizeObserver.disconnect();
      this.clearGroups();
      this.toolbar.remove();
    }

    render(state, settings) {
      this.settings = settings;
      this.toggle.textContent = settings.enabled ? "Show flat list" : "Group stacks";
      this.toggle.setAttribute("aria-pressed", String(settings.enabled));
      for (const [key, input] of this.inputs) input.checked = settings[key];
      const resolved = this.pulls.filter(pull => pull.done).length;
      const failed = this.pulls.filter(pull => pull.error).length;
      const notes = [
        failed && `${failed} unreadable, left alone`,
        state.rateLimited ? "GitHub rate limit, retry Refresh later"
          : !this.pulls.some(pull => pull.defaultRef) && "default branch unknown, left flat",
      ].filter(Boolean);
      this.status.textContent = !settings.enabled ? "Flat list"
        : state.loading ? `Finding stacks… ${resolved}/${this.pulls.length}`
        : [`${state.stacks.length} ${state.stacks.length === 1 ? "stack" : "stacks"} on this page`, ...notes].join(" · ");
      const stacks = settings.enabled && (settings.progressive || !state.loading) ? state.stacks : [];
      const signature = JSON.stringify([settings, this.list.getAttribute("data-density"), stacks.map(stack => [
        stack.root.title, stack.root.author, stack.root.openedAt, stack.members.map(({ pull }) => pull.number),
      ])]);
      if (signature === this.signature && this.intact()) return;
      this.signature = signature;
      const focused = document.activeElement?.closest(".pulltergeist-group")?.dataset.stack.split(",") || [];
      this.clearGroups();
      this.list.classList.toggle("pulltergeist-compact", settings.compact);
      if (!stacks.length) return;
      this.matchNativeRows(stacks);
      this.list.classList.add("pulltergeist-list");
      const stride = this.pulls.length + 1;
      this.pulls.forEach(({ row }, index) => {
        row.classList.add("pulltergeist-row");
        row.style.setProperty("--pulltergeist-order", String(index * stride));
      });
      for (const stack of stacks) {
        const indices = stack.members.map(({ pull }) => this.pulls.indexOf(pull));
        const first = Math.min(...indices);
        const key = stack.members.map(({ pull }) => pull.number).sort().join(",");
        const group = element(this.list.tagName === "UL" ? "li" : "div", "pulltergeist-group");
        group.dataset.stack = key;
        group.style.setProperty("--pulltergeist-order", String(first * stride));
        const button = element("button", "pulltergeist-toggle");
        button.type = "button";
        const controls = stack.members.map(({ pull }) => pull.row.id).filter(Boolean);
        if (controls.length) button.setAttribute("aria-controls", controls.join(" "));
        const chevron = icon("chevron");
        const summary = element("span", "pulltergeist-summary");
        const heading = element("span", "pulltergeist-heading");
        const title = element("span", "pulltergeist-title", stack.root.title);
        title.title = stack.root.title;
        heading.append(title);
        if (settings.showCounts) heading.append(element("span", "pulltergeist-count Counter", `${stack.members.length} PRs`));
        const metadata = element("span", "pulltergeist-meta");
        metadata.append(document.createTextNode(`#${stack.root.number} · `),
          element("span", "pulltergeist-author", stack.root.author || "Unknown author"), document.createTextNode(" opened "));
        let openedLabel = "opening date unavailable";
        if (stack.root.openedAt) {
          const date = new Date(stack.root.openedAt);
          openedLabel = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
          const time = element("relative-time", "pulltergeist-opened", openedLabel);
          time.setAttribute("datetime", stack.root.openedAt);
          time.title = date.toLocaleString();
          metadata.append(time);
        } else metadata.append(element("span", "pulltergeist-opened", "date unavailable"));
        summary.append(heading, metadata);
        button.append(icon("stack-icon"), summary, chevron);
        const count = settings.showCounts ? ` of ${stack.members.length} PRs` : "";
        const author = stack.root.author ? ` by ${stack.root.author}` : "";
        button.setAttribute("aria-label",
          `${stack.root.title}, pull request stack${count}, base PR #${stack.root.number}${author}, ${openedLabel}`);
        button.title = `Pulltergeist stack, ${settings.baseFirst ? "base PR first" : "original list order"}. Only PRs on this page are included.`;
        const members = settings.baseFirst ? stack.members
          : [...stack.members].sort((a, b) => this.pulls.indexOf(a.pull) - this.pulls.indexOf(b.pull));
        members.forEach(({ pull }, index) => {
          pull.row.classList.toggle("pulltergeist-member", settings.highlight);
          pull.row.style.setProperty("--pulltergeist-order", String(first * stride + index + 1));
        });
        const expand = (open, remember = false) => {
          button.setAttribute("aria-expanded", String(open));
          for (const { pull } of members) {
            pull.row.classList.toggle("pulltergeist-collapsed", !open);
            if (remember) state.expanded.set(pull.number, open);
          }
        };
        const remembered = members.find(({ pull }) => state.expanded.has(pull.number));
        expand(remembered ? state.expanded.get(remembered.pull.number) : settings.autoExpand);
        button.addEventListener("click", () => expand(button.getAttribute("aria-expanded") !== "true", true));
        group.append(button);
        this.list.insertBefore(group, this.pulls[first].row);
        this.groups.push(group);
        if (members.some(({ pull }) => focused.includes(pull.number))) button.focus({ preventScroll: true });
      }
    }
  }

  Object.assign(globalThis.Pulltergeist, { PullListView });
})();
