const core   = require('@actions/core');
const github = require('@actions/github');

// Returns the team slugs (from teamsToCheck) that username is an active member of.
async function getUserTeams(octokit, org, username, teamsToCheck) {
  const userTeams = [];
  for (const teamSlug of teamsToCheck) {
    try {
      const { data } = await octokit.rest.teams.getMembershipForUserInOrg({
        org, team_slug: teamSlug, username,
      });
      if (data.state === 'active') userTeams.push(teamSlug);
    } catch {
      // 404 = user not in team; skip silently
    }
  }
  return userTeams;
}

// Formats ['a', 'b', 'c'] -> 'a, b or c'
function formatOrList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

async function run() {
  const token      = core.getInput('github-token', { required: true });
  const prNumber   = parseInt(core.getInput('pr-number',   { required: true }), 10);
  const prSha      = core.getInput('pr-sha',      { required: true });
  const mgmtTeam   = core.getInput('mgmt-team',   { required: true });
  const tlTeam     = core.getInput('tl-team',     { required: true });
  const memberTeam = core.getInput('member-team', { required: true });

  const octokit         = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  // Fetch reviews, keeping only the latest submission per reviewer
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner, repo, pull_number: prNumber, per_page: 100,
  });

  const latestByUser = {};
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    if (!latestByUser[login] || review.submitted_at > latestByUser[login].submitted_at) {
      latestByUser[login] = review;
    }
  }

  // Count approvals by role
  const counts = { mgmt: 0, tl: 0, member: 0 };
  for (const { user: { login } } of Object.values(latestByUser).filter(r => r.state === 'APPROVED')) {
    const userTeams = await getUserTeams(octokit, owner, login, [mgmtTeam, tlTeam, memberTeam]);
    if      (userTeams.includes(mgmtTeam))   counts.mgmt++;
    else if (userTeams.includes(tlTeam))     counts.tl++;
    else if (userTeams.includes(memberTeam)) counts.member++;
  }

  core.info(`Approvals — Mgmt: ${counts.mgmt}, TL: ${counts.tl}, Member: ${counts.member}`);

  // Valid approval paths: 2 Mgmt | 1 Mgmt + 1 TL | 2 TL | 1 TL + 1 Member
  const twoMgmt        = counts.mgmt >= 2;
  const oneMgmtOneTl   = counts.mgmt >= 1 && counts.tl >= 1;
  const twoTl          = counts.tl >= 2;
  const oneTlOneMember = counts.tl >= 1 && counts.member >= 1;

  const success = twoMgmt || oneMgmtOneTl || twoTl || oneTlOneMember;

  // Roles still needed across every unsatisfied path
  const needsMgmt   = (!twoMgmt   && counts.mgmt   < 2) || (!oneMgmtOneTl  && counts.mgmt   < 1);
  const needsTl     = (!twoTl     && counts.tl     < 2) || (!oneMgmtOneTl  && counts.tl     < 1) || (!oneTlOneMember && counts.tl < 1);
  const needsMember = !oneTlOneMember && counts.member < 1;

  const neededRoles = [
    needsMgmt   && 'management',
    needsTl     && 'team lead',
    needsMember && 'team member',
  ].filter(Boolean);

  const reviewLine = success
    ? '**Reviews:** All approval requirements are met.'
    : `**Pending reviews:** Requires approval from ${formatOrList(neededRoles)}.`;

  // Post commit status to the PR head SHA (makes this check visible in rulesets)
  await octokit.rest.repos.createCommitStatus({
    owner, repo,
    sha:         prSha,
    state:       success ? 'success' : 'pending',
    context:     'Pending Reviews',
    description: success ? 'All approval requirements met' : `Needs: ${formatOrList(neededRoles)}`,
  });

  // Create or update the informational PR comment
  const commentBody = [
    '## Review Status',
    '',
    `**Current Status:** ${success ? '✅ APPROVED' : '❌ PENDING'}`,
    `**Approvals so far:** Mgmt ${counts.mgmt}, TL ${counts.tl}, Member ${counts.member}`,
    '',
    reviewLine,
    '',
  ].join('\n');

  const { data: comments } = await octokit.rest.issues.listComments({
    owner, repo, issue_number: prNumber, per_page: 100,
  });

  const existing = comments.find(
    c => c.user?.login === 'github-actions[bot]' && c.body?.includes('## Review Status'),
  );

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: commentBody });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: commentBody });
  }

  core.info(`Review status posted — ${owner}/${repo} PR #${prNumber}`);
}

run().catch(err => core.setFailed(err.message));
