const core = require("@actions/core");
const github = require("@actions/github");

const DISPLAY = { maintainer: "Management", teamLead: "Team Lead", member: "Member" };

// Rules mirror GitHub branch protection: 1 codeowner approval + 2 total approvals.
const CODEOWNER_ROLES = ["maintainer", "teamLead"];
const MIN_CODEOWNER   = 1;
const MIN_TOTAL       = 2;

async function run() {
  // PAT — needs read:org for team membership lookups.
  const orgOctokit     = github.getOctokit(core.getInput("pat-token", { required: true }));
  // Built-in GITHUB_TOKEN — comments and statuses posted from github-actions[bot].
  const commentOctokit = github.getOctokit(core.getInput("github-token", { required: true }));

  const prNumber = parseInt(core.getInput("pr-number", { required: true }), 10);
  const { owner, repo } = github.context.repo;

  // head-sha may be absent on issue_comment triggers — fall back to fetching from the PR.
  let headSha = core.getInput("head-sha");
  if (!headSha) {
    const { data: pr } = await commentOctokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    headSha = pr.head.sha;
  }

  const reviewerTeams = {
    maintainer: core.getInput("maintainers-github-team", { required: true }),
    teamLead:   core.getInput("team-leads-github-team",  { required: true }),
    member:     core.getInput("members-github-team",     { required: true }),
  };

  // Keep only the latest review per user.
  const { data: rawReviews } = await orgOctokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const latestByUser = rawReviews.reduce((byUser, review) => {
    const username = review.user?.login;
    if (username && (!byUser[username] || review.submitted_at > byUser[username].submitted_at)) byUser[username] = review;
    return byUser;
  }, {});

  // Count approvals per role (highest-priority role wins for dual-role members).
  const approvalCounts = { maintainer: 0, teamLead: 0, member: 0 };
  for (const {
    user: { login },
  } of Object.values(latestByUser).filter((review) => review.state === "APPROVED")) {
    const activeSlugs = [];
    for (const teamSlug of Object.values(reviewerTeams)) {
      try {
        const { data: membership } = await orgOctokit.rest.teams.getMembershipForUserInOrg({
          org: owner,
          team_slug: teamSlug,
          username: login,
        });
        if (membership.state === "active") activeSlugs.push(teamSlug);
      } catch {
        /* 404 = not in team */
      }
    }
    for (const [role, teamSlug] of Object.entries(reviewerTeams)) {
      if (activeSlugs.includes(teamSlug)) {
        approvalCounts[role]++;
        break;
      }
    }
  }

  const total              = Object.values(approvalCounts).reduce((sum, n) => sum + n, 0);
  const codeownerApprovals = CODEOWNER_ROLES.reduce((sum, role) => sum + approvalCounts[role], 0);
  const approved           = codeownerApprovals >= MIN_CODEOWNER && total >= MIN_TOTAL;

  const pendingRoles = approved ? [] : (
    codeownerApprovals < MIN_CODEOWNER
      ? CODEOWNER_ROLES.filter((role) => approvalCounts[role] === 0)
      : Object.keys(approvalCounts).filter((role) => approvalCounts[role] === 0)
  );
  const pendingMessage = pendingRoles.map((role) => DISPLAY[role]).join(" or ");

  if (headSha) {
    await commentOctokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state: "success",
      context: "Pending Reviews",
      description: approved ? "All approval requirements met" : `Informational — ${pendingMessage} approval pending`,
    });
  }

  const approvalSummary = Object.entries(approvalCounts)
    .map(([role, count]) => `${DISPLAY[role]} ${count}`)
    .join(", ");

  const commentLines = [
    `## Review Status`,
    `**Current Status: ${approved ? "✅ APPROVED" : "❌ PENDING"}**`,
    `Approvals so far: ${approvalSummary}`,
  ];
  if (!approved) {
    commentLines.push(`\nPending reviews: Requires approval from ${pendingMessage}.`);
  }
  const commentBody = commentLines.join("\n");

  const { data: prComments } = await commentOctokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const existingComment = prComments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      comment.body?.includes("## Review Status"),
  );

  if (existingComment) {
    await commentOctokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body: commentBody,
    });
  } else {
    await commentOctokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody,
    });
  }
}

run().catch((error) => core.setFailed(error.message));
