(() => {
  const fields = [
    { key: "enabled", label: "Group stacked PRs", description: "Turn off to leave the list flat and stop metadata requests.", default: true },
    { key: "autoExpand", label: "Open stacks by default", description: "Start with stack members visible.", default: false },
    { key: "baseFirst", label: "Base PR first", description: "Order stack members from base to tip instead of list order.", default: true },
    { key: "highlight", label: "Highlight stack members", description: "Add a colored edge to grouped rows.", default: true },
    { key: "showCounts", label: "Show PR counts", description: "Show the number of PRs in each stack header.", default: true },
    { key: "compact", label: "Compact stack text", description: "Use smaller, inline stack text. Row height still follows GitHub.", default: false },
    { key: "progressive", label: "Show stacks while loading", description: "Group known relationships without waiting for every PR.", default: true },
    { key: "fastMetadata", label: "Lightweight GitHub requests", description: "Read small branch-data responses, with an HTML fallback.", default: true },
    { key: "prewarm", label: "Prewarm PR lists", description: "After hovering or focusing a PR-list link, read that page and up to 6 PRs in the background. Requires grouping and local caching.", default: false },
    { key: "cacheMetadata", label: "Cache metadata across reloads", description: "Reuse locally saved PR metadata for 5 minutes. Turning off deletes this cache.", default: true },
  ];
  const defaults = Object.fromEntries(fields.map(field => [field.key, field.default]));

  function normalizeSettings(input) {
    return Object.fromEntries(fields.map(field => [
      field.key, typeof input?.[field.key] === "boolean" ? input[field.key] : field.default,
    ]));
  }

  const api = { settingsFields: fields, defaultSettings: defaults, normalizeSettings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(globalThis.Pulltergeist, api);
})();
