# Pulltergeist

<img src="icons/logo.svg" width="128" height="128" alt="Pulltergeist ghost logo">

Stacked PRs, no unfinished business.

A local-only Chrome/Edge extension that groups related pull requests into collapsible stacks in GitHub repository PR lists. No backend, API token, GitHub app, or build step required.

## Install

1. Clone or download this repository:
   ```sh
   git clone https://github.com/pagecloud-inc/pulltergeist.git
   ```
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `pulltergeist` folder containing `manifest.json`.
5. Reload a GitHub repository's **Pull requests** page.

Keep the folder in place while installed. After updating with `git pull`, reload the extension from the extensions page, then refresh GitHub. Installing and using the extension does not require Node.js or npm.

## How it works

Pulltergeist connects PRs when one PR's base branch matches another PR's head branch in the same repository. It supports chains, branching stacks, and multiple independent stacks. Unrelated PRs remain standalone.

- Collapsed headers show a stack icon, title, PR count, and the **base PR's author and opening time**.
- Headers match the current native PR-row height and reserve GitHub's checkbox-column spacing without making stacks selectable.
- Expanded headers shrink to a single line. Their original GitHub PR rows appear underneath, base first.
- GitHub's comfortable/compact density, filters, sorting, pagination, and empty results are handled automatically. Expansion and density changes do not refetch metadata.
- Enter and Space toggle a focused header. Long titles truncate visually; full titles and opening details remain available through tooltips and accessible labels.

Only PRs on the **current filtered page** are grouped. Pulltergeist does not fetch other list pages. Fork identity and branch-name case matter; title similarity and shared default branches do not imply a stack.

The **Pulltergeist** bar above the list contains:

- **Show flat list / Group stacks:** disable or enable grouping and metadata requests.
- **Refresh:** discard cached metadata and reread branch relationships.
- **Settings:** change local preferences. Escape closes the settings panel.

## Settings

Preferences apply immediately across open GitHub tabs and stay in this browser, never browser sync.

| Toggle | Default | Effect |
| --- | --- | --- |
| Group stacked PRs | On | Group related PRs; stop metadata requests when off. |
| Open stacks by default | Off | Start with stack members visible. |
| Base PR first | On | Otherwise keep the list's original order within each stack. |
| Highlight stack members | On | Add a colored edge to grouped PR rows. |
| Show PR counts | On | Show an explicit **N PRs** badge. |
| Compact stack text | Off | Use smaller, inline text without changing native PR-row height. |
| Show stacks while loading | On | Display known relationships before all metadata arrives. |
| Lightweight GitHub requests | On | Prefer small branch-data responses, with an HTML fallback. |
| Cache metadata across reloads | On | Reuse local metadata for up to five minutes. Turning off deletes the saved cache. |

## Performance

Pulltergeist prefers GitHub's lightweight `/_layout` response instead of downloading every PR's full HTML. A verified native-stack response can resolve multiple visible PRs at once. Other PRs are read with at most three concurrent requests, and results appear progressively.

Author and opening-time details are reused from the list or cache. If GitHub omits a base PR's opening time, only that base PR needs an additional lookup. Cached reloads can require zero metadata requests.

Requests time out after 15 seconds. HTTP 429 stops the queue rather than continuing to hit a rate limit. Unreadable PRs remain visible and ungrouped.

## Privacy and permissions

No backend, telemetry, remote scripts, API tokens, or browser sync. Reads go to `github.com` using your existing session, including for private repositories. Pulltergeist never writes to GitHub.

The content script runs on GitHub pages to detect in-page navigation, but requests metadata only on repository `/pulls` views. The `storage` permission saves preferences and the optional cache in `chrome.storage.local`. No cookies, tabs, or background-service permissions are requested. Only the toolbar icon is exposed as a web-accessible resource, limited to GitHub.

The optional cache contains PR URLs, branch refs, head SHAs, author logins, opening times, and cache timestamps. This may include private-repository branch names and authors. No PR bodies, access tokens, or cookies are saved.

Cache entries are valid for five minutes and capped at 250 PRs. Expired entries are rejected when loaded and removed from disk on the next cache write. Disabling persistent caching deletes the disk cache; the current tab can still reuse temporary in-memory metadata until reload or close. Concurrent tabs may replace cache snapshots, causing extra reads rather than affecting GitHub data.

## Limitations

- Chrome/Edge only for now, not packaged for Firefox or Safari.
- GitHub's HTML and `/_layout` endpoint are internal, unstable interfaces. Unsupported lightweight responses fall back to HTML, but GitHub changes may require parser updates.
- Stacks described only in PR text or implicit commit ancestry are not detected.
- Retargeting without changing a head SHA can leave cached relationships stale for up to five minutes. Use **Refresh** after retargeting.
- Rows are visually ordered with CSS rather than moved out of GitHub's React tree. Native keyboard-list navigation follows its original DOM order.
- Missing opening dates are shown as **date unavailable**, never guessed.

## Development

Use Node.js 24 and npm:

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run check
npm test
```

Tests load the actual unpacked extension in isolated headless Chromium, using local GitHub fixtures rather than a real account. Coverage includes grouping, forks, cycles, metadata validation, settings, privacy/cache races, filters, pagination, density changes, native row sizing, checkbox alignment, resizing, keyboard/focus behavior, and navigation.

```sh
# Regenerate PNG icons after editing icons/logo.svg
npm run icons

# Run a controlled benchmark, optionally against an older extension folder
npm run benchmark
npm run benchmark -- /path/to/older-extension
```

Benchmark output goes to ignored `test-results/benchmark.json`. Fixture timings are not a guarantee of GitHub network latency. GitHub Actions runs syntax checks and browser/unit tests on pushes and pull requests.

## License

[MIT](LICENSE), copyright Pagecloud Inc.

The ghost logo is included under the same license. Disclosure and stack glyphs come from [GitHub Octicons](https://github.com/primer/octicons), also MIT licensed. Its notice is included in [icons/LICENSE.octicons](icons/LICENSE.octicons).
