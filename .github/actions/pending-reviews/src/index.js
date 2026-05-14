const core = require("@actions/core");
const github = require("@actions/github");

// Minimum approvals required per role. All thresholds must be satisfied.
const REQUIRED = { maintainer: 1, teamLead: 1, member: 0 };

async function run() {
  const token = core.getInput("github-token", { required: true });
  const prNumber = parseInt(core.getInput("pr-number", { required: true }), 10);
  const headSha = core.getInput("head-sha");
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const reviewerTeams = {
    maintainer: core.getInput("maintainers-github-team", { required: true }),
    teamLead: core.getInput("team-leads-github-team", { required: true }),
    member: core.getInput("members-github-team", { required: true }),
  };

  // Keep only the latest review per user.
  const { data: rawReviews } = await octokit.rest.pulls.listReviews({
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

  // Count approvals per role
  const approvalCounts = { maintainer: 0, teamLead: 0, member: 0 };
  for (const {
    user: { login },
  } of Object.values(latestByUser).filter((review) => review.state === "APPROVED")) {
    const activeSlugs = [];
    for (const teamSlug of Object.values(reviewerTeams)) {
      try {
        const { data: membership } = await octokit.rest.teams.getMembershipForUserInOrg({
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
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state: approved ? "success" : "pending",
      context: "Pending Reviews",
      description: approved
        ? "All approval requirements met"
        : `Needs: ${roleFormatter.format(pendingRoles)}`,
    });
  }

  const commentBody = [
    `## Review Status`,
    `**${approved ? "✅ APPROVED" : `❌ PENDING — requires approval from ${roleFormatter.format(pendingRoles)}`}**`,
    `Approvals so far: ${Object.entries(approvalCounts)
      .map(([role, count]) => `${role}: ${count}`)
      .join(" | ")}`,
  ].join("\n");

  const { data: prComments } = await octokit.rest.issues.listComments({
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
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body: commentBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody,
    });
  }
}

run().catch((error) => core.setFailed(error.message));
