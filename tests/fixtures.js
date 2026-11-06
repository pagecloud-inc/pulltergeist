const repo = "/pagecloud/pagecloud";
const origin = "https://github.com";

function chainPulls(length = 8) {
  return Array.from({ length }, (_, i) => ({
    number: i + 1, title: `Stack step ${i + 1}`, base: i ? `step-${i}` : "staging", head: `step-${i + 1}`,
    stackSize: length, stackPosition: i + 1, sha: String(i + 1).padStart(40, "0"),
    author: `author-${i + 1}`, openedAt: new Date(Date.UTC(2026, 0, i + 1, 12)).toISOString(),
  })).reverse();
}

function listHtml({ items, hints = false, defaultBranch = "staging" }) {
  const rows = items.map(pull => {
    const author = pull.author ? `<a data-testid="author-filter-link" href="${repo}/pulls?q=author%3A${pull.author}">${pull.author}</a>` : "";
    const time = pull.openedAt ? `<relative-time datetime="${pull.openedAt}">${pull.openedAt}</relative-time>` : "";
    const title = `<h3><a data-testid="listitem-title-link" href="${repo}/pull/${pull.number}">${pull.title}</a></h3>`;
    return `<li id="issue_${pull.number}">${title}<span data-testid="timestamp-container">${author} opened ${time}</span></li>`;
  }).join("");
  const data = hints ? `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
    payload: {
      repoPullsDashboardLayoutRoute: { repository: { ownerLogin: "pagecloud", name: "pagecloud", defaultBranch } },
      repoPullsDashboardContentRoute: { results: items.map(pull => ({
        number: pull.number, repoNameWithOwner: repo.slice(1), headSha: pull.sha || null,
        stackSize: pull.stackSize || null, stackPosition: pull.stackPosition || null,
        author: { displayLogin: pull.author || null }, createdAt: pull.openedAt || null,
      })) },
    },
  })}</script>` : "";
  return `<!doctype html><html><body><main>${data}<ul id="list" data-listview-component="items-list">${rows}</ul></main></body></html>`;
}

function pullPayload(pull, items) {
  const route = {
    repository: { ownerLogin: "pagecloud", name: "pagecloud", defaultBranch: "staging" },
    pullRequest: {
      number: pull.number, baseBranch: pull.base, headBranch: pull.head, headSha: pull.sha || null,
      headRepositoryOwnerLogin: "pagecloud", headRepositoryName: "pagecloud",
      author: { login: pull.author || null }, createdTime: pull.openedAt || null,
    },
  };
  if (pull.stackSize) {
    const members = items.filter(item => item.stackSize).sort((a, b) => b.number - a.number);
    route.stack = {
      repositoryOwnerLogin: "pagecloud", repositoryName: "pagecloud", baseBranch: "staging", size: members.length,
      pulls: members.map(item => ({ number: item.number, state: "OPEN", url: `${repo}/pull/${item.number}`, headBranch: item.head, headOid: item.sha || null })),
    };
  }
  return { payload: { pullRequestsLayoutRoute: route } };
}

function pullHtml(pull, items) {
  return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(pullPayload(pull, items))}</script>`;
}

module.exports = { repo, origin, chainPulls, listHtml, pullPayload, pullHtml };
