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

Only PRs on the **current filtered page** are grouped. Pulltergeist does not crawl other list pages; optional prewarming can read a linked target page before you navigate there. Fork identity and branch-name case matter; title similarity and shared default branches do not imply a stack. A PR whose head is the repository's default branch, such as a deployment promoting it to production, remains standalone. It cannot become the parent of every feature PR targeting that default branch.

The **Pulltergeist** bar above the list contains:

- **Show flat list / Group stacks:** disable or enable grouping and metadata requests.
- **Refresh:** discard cached metadata and reread branch relationships.
- **Settings:** change local preferences. Click outside to dismiss, or press Escape to close and return focus to Settings.

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
| Cache metadata across reloads | On | Reuse local metadata for up to five minutes and share fresh results between tabs. Turning off deletes the saved cache. |
| Prewarm PR lists | Off | After hovering or focusing a list link, read its target page and up to six PRs in the background. Requires grouping and local caching. |

## Performance

Pulltergeist starts at DOM-ready, without waiting for unrelated page assets. It prefers GitHub's lightweight `/_layout` response instead of downloading every PR's full HTML. A verified native-stack response can resolve multiple visible PRs at once. It allows up to six concurrent JSON reads immediately; HTML fallback remains capped at three, including requests waiting for a slot when a rate limit arrives.

Native size/position hints prioritize the lowest visible PR in each stack and allow independent stack probes to run in parallel. Other requests sample both ends of the list so older base PRs are not stuck behind every newer, unrelated PR. Branch metadata still determines grouping, never scheduling hints or title guesses. Client-side list changes reconcile before the next animation frame instead of waiting for a fixed delay. When GitHub recreates unchanged list rows during hydration, the existing lookups and settings panel are reused instead of aborting and restarting them.

Author and opening-time details are reused from the list or cache. Base-first native probes can supply missing opening details in the same request. If details are still absent, only the base PR needs an additional lookup. The first useful stack is saved before the rest of the list finishes, so interrupted reloads retain useful progress. Fully cached reloads can require zero metadata requests. Settings and cache are read together at startup, and visible native-row resizing updates layout variables without rebuilding stack headers.

Opening a PR page passively learns verified metadata already embedded in that page, including validated native-stack neighbors, without extra network requests. Fresh cache updates are shared between open GitHub tabs, allowing a loading list to group immediately and skip queued reads. Imports keep their original observation time and still check head SHAs. Cache writes merge under a same-origin Web Lock; a refresh revision prevents another tab from restoring pre-refresh snapshots.

Optional prewarming waits for 200ms of hover or keyboard focus on a same-origin `/pulls` link, including canonical `/pulls/<author>` shortcuts. It preserves that link's filters/page, fetches only its target list, and runs at most six metadata jobs sequentially at low priority. It does not run during foreground loading and stops on navigation, visibility loss, leaving the link, opt-out, disabling grouping, or a five-second deadline. A 429 pauses further prewarming for one minute. No automatic crawling or periodic refresh occurs.

Requests time out after 15 seconds. HTTP 429 stops the queue and starts a one-minute cooldown for the tab, so new filters, pages, and prewarming do not immediately hit the limit again. Unreadable PRs remain visible and ungrouped.

Initial controlled optimization pass, median of three runs with 25 PRs and 120ms metadata latency:

| Scenario | Before | After |
| --- | --- | --- |
| Manual stack with an older base: first stack | 1,144ms | 155ms |
| Native stack: all metadata resolved | 804ms | 534ms |
| React row replacement: metadata requests | 21 | 18 |
| Slow page assets: first stack | 354ms | 147ms |
| Slow page assets: cached reload | 215ms | 9ms |

Further improvements against the preceding optimization pass, using the same three-run, 25-PR benchmark:

| Scenario | Before | After |
| --- | --- | --- |
| Native stack: all metadata resolved | 545ms | 408ms |
| Three native stacks: all metadata resolved | 414ms | 163ms |
| Cached client-side navigation: list-ready to grouping | 86ms | 7ms |

Manual-stack first render stayed about 158ms. Fresh discovery still needs a GitHub response; fully cached reloads remain about 9ms with no metadata reads.

With the complete performance batch versus commit `965204e`, additional three-run, eight-PR native-stack fixtures measured first list grouping at **154ms to 22ms** after opening a PR, and **148ms to 25ms** with prewarming enabled. Both required **zero metadata reads during navigation**. Prewarming performed one metadata read earlier; its 750ms preparation window and target-list fetch are excluded from navigation timing. A two-tab browser regression also reduced the slower tab's metadata reads from 25 to 6 by reusing the faster tab's results. Already in-flight reads are not cancelled just because another tab supplies results.

These are controlled fixtures, not promises about GitHub's own page/network latency. Live public GitHub also verified unique metadata reads, zero reads on a fully cached reload, and no hydration errors. Cache validity stays at five minutes; speed improvements do not rely on hiding PRs with expired metadata.

## Privacy and permissions

No backend, telemetry, remote scripts, API tokens, or browser sync. Reads go to `github.com` using your existing session, including for private repositories. Pulltergeist never writes to GitHub.

The content script runs on GitHub pages to detect in-page navigation and passively learn embedded metadata on opened PR pages. With prewarming off, metadata requests occur only on repository `/pulls` views. Canonical `/pulls/<author>` filters are supported alongside query-string filters. Redirecting prewarm links are skipped rather than followed to an unchecked destination. Opt-in prewarming can also request the target of a deliberately hovered/focused PR-list link and metadata for PRs on that target page. The `storage` permission saves preferences and the optional cache in `chrome.storage.local`. No cookies, tabs, or background-service permissions are requested. Only the toolbar icon is exposed as a web-accessible resource, limited to GitHub.

The optional cache contains PR URLs, branch refs, head SHAs, author logins, opening times, and cache timestamps. This may include private-repository branch names and authors. No PR bodies, access tokens, or cookies are saved.

Cache entries are valid for five minutes and capped at 250 PRs. Expired entries are rejected when loaded and removed from disk on the next cache write. Disabling persistent caching deletes the disk cache, stops prewarming and cross-tab metadata imports, and leaves only temporary in-tab metadata until reload or close. Repeated DOM scans, cloned page snapshots, and tab imports do not renew metadata age. Concurrent writes merge rather than overwrite unrelated entries. A non-sensitive refresh revision remains alongside preferences to invalidate old writers.

## Limitations

- Chrome/Edge 116 or newer only for now, not packaged for Firefox or Safari.
- GitHub's HTML and `/_layout` endpoint are internal, unstable interfaces. Unsupported lightweight responses fall back to HTML, but GitHub changes may require parser updates.
- Stacks described only in PR text or implicit commit ancestry are not detected.
- Retargeting without changing a head SHA can leave cached relationships stale for up to five minutes. Use **Refresh** after retargeting.
- Rows are visually ordered with CSS rather than moved out of GitHub's React tree. Native keyboard-list navigation follows its original DOM order.
- Missing opening dates are shown as **date unavailable**, never guessed.
- Grouping requires verified repository default-branch metadata. If it is unavailable, rows stay flat and the status says **default branch unknown, left flat**. Old cache records can reuse the current list's repository metadata; legacy views may need one metadata read to recover that context.

## Development

Use Node.js 24 and npm:

```sh
npm ci --ignore-scripts
npm run check
npm run lint
npm test
```

Unit tests run in Node with jsdom fixtures and cover grouping, forks, cycles, default-branch boundaries, metadata validation, settings, cache/privacy races, passive learning, and packaging. There are no automated browser tests. Verify UI, layout, density, and navigation behavior manually by loading the unpacked extension in Chrome on real GitHub PR lists.

```sh
# Regenerate PNG icons after editing icons/logo.svg
npm run icons

# Build dist/pulltergeist-<version>.zip from the files manifest.json references
npm run package
```

GitHub Actions runs syntax checks, lint, unit tests, and packaging on pull requests and pushes to `main`.

## License

[MIT](LICENSE), copyright Pagecloud Inc.

The ghost logo is included under the same license. Disclosure and stack glyphs come from [GitHub Octicons](https://github.com/primer/octicons), also MIT licensed. Its notice is included in [icons/LICENSE.octicons](icons/LICENSE.octicons).
