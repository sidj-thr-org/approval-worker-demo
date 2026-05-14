const core = require("@actions/core");
const github = require("@actions/github");

// Minimum approvals required per role. All thresholds must be satisfied.
const REQUIRED = { maintainer: 1, teamLead: 1, member: 0 };

const DISPLAY = { maintainer: "Management", teamLead: "Team Lead", member: "Member" };

async function run() {
  // PAT — needs read:org for team membership lookups.
  const orgOctokit     = github.getOctokit(core.getInput("pat-token", { required: true }));
  // Built-in GITHUB_TOKEN — comments and statuses posted from github-actions[bot].
  const commentOctokit = github.getOctokit(core.getInput("github-token", { required: true }));

  const prNumber = parseInt(core.getInput("pr-number", { required: true }), 10);
  const headSha  = core.getInput("head-sha");
  const { owner, repo } = github.context.repo;

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

  const approved = Object.entries(REQUIRED).every(
    ([role, minRequired]) => approvalCounts[role] >= minRequired,
  );
  const pendingRoles = Object.entries(REQUIRED)
    .filter(([role, minRequired]) => approvalCounts[role] < minRequired)
    .map(([role]) => role);
  const roleFormatter = new Intl.ListFormat("en", { type: "disjunction" });

  if (headSha) {
    await commentOctokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state: approved ? "success" : "pending",
      context: "Pending Reviews",
      description: approved
        ? "All approval requirements met"
        : `Needs: ${roleFormatter.format(pendingRoles.map((role) => DISPLAY[role]))}`,
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
    const pendingNames = roleFormatter.format(pendingRoles.map((role) => DISPLAY[role]));
    commentLines.push(`\nPending reviews: Requires approval from ${pendingNames}.`);
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
