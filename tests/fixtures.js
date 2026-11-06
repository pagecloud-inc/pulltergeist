const repo = "/pagecloud/pagecloud";
const origin = "https://github.com";
const pulls = [
  { number: 2, title: "Feature follow-up", base: "feature", head: "follow-up", author: "tip-author", openedAt: "2026-02-02T12:00:00Z" },
  { number: 3, title: "Unrelated change", base: "staging", head: "other" },
  { number: 1, title: "Feature foundation", base: "staging", head: "feature", author: "base-author", openedAt: "2026-01-01T12:00:00Z" },
  { number: 4, title: "Feature tests", base: "feature", head: "tests" },
];

function chainPulls(length = 8, standalone = 0) {
  const chain = Array.from({ length }, (_, i) => ({
    number: i + 1, title: `Stack step ${i + 1}`, base: i ? `step-${i}` : "staging", head: `step-${i + 1}`,
    stackSize: length, stackPosition: i + 1, sha: String(i + 1).padStart(40, "0"),
    author: `author-${i + 1}`, openedAt: new Date(Date.UTC(2026, 0, i + 1, 12)).toISOString(),
  })).reverse();
  return chain.concat(Array.from({ length: standalone }, (_, i) => ({
    number: length + i + 1, title: `Standalone ${i + 1}`, base: "staging", head: `standalone-${i + 1}`,
    sha: String(length + i + 1).padStart(40, "0"),
  })));
}

function multipleStackPulls() {
  return [0, 8, 16].flatMap(offset => chainPulls().map(pull => ({
    ...pull, number: pull.number + offset, stackId: offset,
    base: pull.base === "staging" ? pull.base : `${offset}-${pull.base}`, head: `${offset}-${pull.head}`,
    sha: String(pull.number + offset).padStart(40, "0"),
  }))).concat({ number: 25, title: "Unrelated", base: "staging", head: "unrelated" });
}

function manualStackPulls() {
  return Array.from({ length: 25 }, (_, index) => {
    const number = 25 - index;
    return {
      number, title: `Manual PR ${number}`, base: number === 25 || number === 22 ? "manual-base" : "staging",
      head: number === 1 ? "manual-base" : `manual-${number}`, author: `author-${number}`,
      openedAt: new Date(Date.UTC(2026, 0, number, 12)).toISOString(), sha: String(number).padStart(40, "0"),
    };
  });
}

function listHtml({ legacy = false, items = pulls, hints = false, density = "default", timestamps = true, hintDates = true, nativeLayout = false, defaultBranch = "staging" } = {}) {
  const rows = items.map(pull => {
    const author = pull.author ? `<a data-testid="author-filter-link" href="${repo}/pulls?q=author%3A${pull.author}">${pull.author}</a>` : "";
    const time = timestamps && pull.openedAt ? `<relative-time datetime="${pull.openedAt}">${pull.openedAt}</relative-time>` : "";
    const metadata = `<span data-testid="timestamp-container">${author} opened ${time}</span>`;
    const title = `<h3><a data-testid="listitem-title-link" href="${repo}/pull/${pull.number}">${pull.title}</a></h3>`;
    const checkbox = `<input type="checkbox" aria-label="Select PR ${pull.number}">`;
    const content = nativeLayout ? `${checkbox}<svg class="octicon octicon-git-pull-request" width="16" height="16" aria-hidden="true"></svg><div class="fixture-content">${title}${metadata}</div>`
      : `${checkbox}${title}${metadata}`;
    const className = nativeLayout ? "fixture-pr-row" : "";
    return legacy ? `<div class="js-issue-row ${className}" id="issue_${pull.number}">${content}</div>`
      : `<li class="${className}" id="issue_${pull.number}">${content}</li>`;
  }).join("");
  const data = hints ? `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
    payload: { repoPullsDashboardLayoutRoute: { repository: { ownerLogin: "pagecloud", name: "pagecloud", defaultBranch } }, repoPullsDashboardContentRoute: { results: items.map(pull => ({
      number: pull.number, repoNameWithOwner: repo.slice(1), headSha: pull.sha || null, stackSize: pull.stackSize || null, stackPosition: pull.stackPosition || null,
      author: { displayLogin: pull.author || null }, createdAt: hintDates ? pull.openedAt || null : null,
    })) } },
  })}</script>` : "";
  const styles = nativeLayout ? `<style>
    #list { padding: 0; margin: 0; list-style: none; }
    #list > .fixture-pr-row { box-sizing: border-box; display: grid; grid-template-columns: 16px 16px minmax(0, 1fr); gap: 8px; height: var(--fixture-row-height, 67px); padding: 12px 16px; border-bottom: 1px solid #d1d9e0; }
    .fixture-pr-row > input { width: 16px; height: 16px; margin: 4px 0 0; }
    .fixture-pr-row > svg { margin-top: 4px; }
    .fixture-content h3 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 16px/24px sans-serif; }
    .fixture-content [data-testid="timestamp-container"] { display: block; overflow: hidden; white-space: nowrap; font: 12px/18px sans-serif; }
    #list[data-density="compact"] > .fixture-pr-row { height: var(--fixture-row-height, 38px); padding-block: 8px; }
    #list[data-density="compact"] .fixture-content h3 { font-size: 14px; line-height: 21px; }
    #list[data-density="compact"] .fixture-content [data-testid="timestamp-container"] { display: none; }
    #list[data-density="compact"] > .fixture-pr-row > :is(input, svg) { margin-top: 2px; }
  </style>` : "";
  return `<!doctype html><html><head><title>Pull requests</title>${styles}</head><body><main>${data}
    <a id="nav" href="${repo}/pulls?q=is%3Apr+author%3Ame">Filter</a>
    ${legacy ? `<div id="list">${rows}</div>` : `<ul id="list" data-listview-component="items-list" data-density="${density}">${rows}</ul>`}
    </main></body></html>`;
}

function pullPayload(pull, items = pulls, defaultBranch = "staging") {
  const route = {
    repository: { ownerLogin: "pagecloud", name: "pagecloud", defaultBranch },
    pullRequest: {
      number: pull.number, baseBranch: pull.base, headBranch: pull.head, headSha: pull.sha || null,
      headRepositoryOwnerLogin: "pagecloud", headRepositoryName: "pagecloud",
      author: { login: pull.author || null }, createdTime: pull.openedAt || null,
    },
  };
  if (pull.stackSize) {
    const members = items.filter(item => item.stackSize && item.stackId === pull.stackId).sort((a, b) => b.number - a.number);
    route.stack = {
      repositoryOwnerLogin: "pagecloud", repositoryName: "pagecloud", baseBranch: "staging", size: members.length,
      pulls: members.map(item => ({ number: item.number, state: "OPEN", url: `${repo}/pull/${item.number}`, headBranch: item.head, headOid: item.sha || null })),
    };
  }
  return { payload: { pullRequestsLayoutRoute: route } };
}

function pullHtml(pull, items = pulls, padding = 0, defaultBranch) {
  return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(pullPayload(pull, items, defaultBranch))}</script><!--${"x".repeat(padding)}-->`;
}

module.exports = { repo, origin, pulls, chainPulls, multipleStackPulls, manualStackPulls, listHtml, pullPayload, pullHtml };
