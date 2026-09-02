import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { Client } from './client.js'
import { commitInfo, diffCommitRange, patchIds, pushRange } from './diff.js'
import { pushSnapshot } from './push.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * Whether a push carries a commit nobody read.
 *
 * A fingerprint over the whole range answered that question badly in both
 * directions. It refused a branch stacked on an open review, because the range
 * moves whenever either branch gains a commit and the reviewer of the branch
 * below had approved a different range. And its one number said nothing about
 * which commit was the problem, so a denial named the range and left the
 * reader to work out what was in it.
 *
 * The gate asks per commit instead. Every commit `git rev-list HEAD --not
 * --remotes` reports has to have been approved by somebody, which is what lets
 * a base narrow the review without narrowing the check.
 */

let ctx: TempDatabase
let app: App
let repo: TempRepo

beforeEach(async () => {
  ctx = await tempDatabase()

  repo = tempRepo()
  repo.write('src/a.ts', 'const a = 1\n')
  repo.commit('already pushed')
  repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')
})

afterEach(async () => {
  repo.cleanup()
  await ctx.close()
})

/** A daemon gating this repository on push, and a client aimed at it. */
function daemon(approval_follows: 'change' | 'commit' = 'change'): Client {
  const config = resolve(
    configSchema.parse({
      public_url: 'https://mac.tailnet-name.ts.net',
      gate: { scope: 'push', roots: {}, approval_follows },
    }),
    { configPath: '/tmp/reviewd-push-approval.json', bindPublic: false },
  )

  app = createApp({ config, db: ctx.db, local: true })

  return new Client('http://127.0.0.1:7777', (input, init) =>
    app.request(String(input).replace('http://127.0.0.1:7777', ''), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7777' },
    }),
  )
}

/**
 * The reviewer approves through the page, because a verdict has no other
 * door: the agent's own API cannot write one.
 */
async function approve(reviewId: string): Promise<void> {
  const page = await app.request(`/r/${reviewId}`, { headers: { host: '127.0.0.1:7777' } })
  const match = /name="token" value="([^"]+)"/.exec(await page.text())
  if (!match) throw new Error('no page token on the review page')

  await app.request(`/r/${reviewId}/submit`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:7777',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({ verdict: 'approved', token: match[1] as string }).toString(),
  })
}

/** Opens a review of this repository, optionally from a base. */
async function open(client: Client, title: string, base?: string) {
  const review = await client.createReview({
    title,
    sources: [{ path: repo.root, base: base ?? 'HEAD' }],
    createdBy: 'test',
    notify: false,
  })

  await pushSnapshot(client, review.reviewId, [
    {
      id: review.sources[0]!.id,
      rootPath: repo.root,
      ...(base !== undefined ? { baseRef: base } : {}),
    },
  ])

  return review
}

/** Asks the gate what it asks: the push range, named commit by commit. */
async function gatePush(client: Client) {
  const range = (await pushRange(repo.root))!
  const reading = await diffCommitRange({ id: '', rootPath: repo.root }, range)
  const infos = (await commitInfo(repo.root, range.commits)).reverse()
  const ids = await patchIds(repo.root, range.commits)

  return client.gate(
    repo.root,
    reading.fingerprint,
    reading.tree,
    range.head,
    infos.map((info) => ({
      sha: info.sha,
      patchId: ids.get(info.sha) ?? null,
      parentSha: info.parentSha,
      subject: info.subject,
    })),
  )
}

function commit(name: string): string {
  repo.write(`src/${name}.ts`, `export const ${name} = 1\n`)
  repo.commit(name)
  return repo.run('rev-parse', 'HEAD').trim()
}

describe('a push carrying a commit nobody approved', () => {
  it('is refused, and the denial names the commit', async () => {
    const client = daemon()

    commit('reviewed')
    await approve((await open(client, 'the first commit')).reviewId)

    // Written after the approval, so no review covers it.
    commit('unreviewed')

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('unreviewed')
    expect(verdict.reason).toContain('no approval')
  })

  /**
   * The reason the base had to stop meaning "compare the working tree against
   * this". A caller choosing where the review starts chooses what a reviewer
   * is asked to read, and if that also chose what the gate checks, an agent
   * could approve one commit and push ten.
   */
  it('is refused even when the review was opened from a base that hides it', async () => {
    const client = daemon()

    const hidden = commit('hidden')
    commit('shown')

    // A base one commit back, so the review lists `shown` and nothing else.
    await approve((await open(client, 'only the last commit', hidden)).reviewId)

    const listed = await ctx.db.selectFrom('commit').select('subject').execute()
    expect(listed.map((row) => row.subject)).toEqual(['shown'])

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('hidden')
  })
})

describe('a branch stacked on a review that is still open', () => {
  /**
   * The case a range fingerprint could never allow. Two reviews cover the push
   * between them, and neither covers it alone, so the only reading that lets
   * the push through is the one that asks about commits.
   */
  it('pushes on the two reviews together, without re-reading the branch below', async () => {
    const client = daemon()

    const below = commit('below')
    await approve((await open(client, 'the pull request below')).reviewId)

    commit('above')
    await approve((await open(client, 'the pull request above', below)).reviewId)

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('allow')
  })

  it('holds the lower review to its own commits, not to whatever lands later', async () => {
    const client = daemon()

    const below = commit('below')
    await approve((await open(client, 'the pull request below')).reviewId)

    commit('above')
    // Opened against the same base and approved, then a commit lands after it.
    await approve((await open(client, 'the pull request above', below)).reviewId)
    commit('afterwards')

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('afterwards')
  })
})

describe('a rebase after the approval', () => {
  /**
   * A stack that has been rebased is where matching on a patch id earns its
   * keep. Neither review's fingerprint describes this push, because each
   * covers one commit and the push carries both, so the verdict rests on
   * coverage per commit; and a rebase has rewritten both shas, so it rests on
   * the patch ids rather than on the shas that were approved.
   */
  /** Somebody else's work lands upstream and the approved stack moves onto it. */
  async function rebaseOntoUpstream(client: Client): Promise<void> {
    const below = commit('below')
    await approve((await open(client, 'the pull request below')).reviewId)

    commit('above')
    await approve((await open(client, 'the pull request above', below)).reviewId)

    const before = repo.run('rev-list', 'HEAD', '--not', '--remotes').trim().split('\n')

    const wasPushed = repo.run('rev-parse', 'origin/main').trim()
    repo.run('checkout', '-q', '-b', 'upstream', wasPushed)
    repo.write('src/theirs.ts', 'export const theirs = 1\n')
    repo.commit('somebody else')
    repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')
    repo.run('checkout', '-q', 'main')

    // Rewrites every sha above the old base and changes none of the patches.
    repo.run('rebase', '--onto', 'origin/main', wasPushed)

    const after = repo.run('rev-list', 'HEAD', '--not', '--remotes').trim().split('\n')
    expect(after).not.toEqual(before)
    expect(after).toHaveLength(2)
  }

  it('keeps the approvals, because the changes are the ones that were read', async () => {
    const client = daemon()
    await rebaseOntoUpstream(client)

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('allow')
    expect(verdict.warnings.join(' ')).toContain('rebase')
  })

  /**
   * `gate.approval_follows: commit` is for a repository where a review is
   * about a state rather than a change. The same patch on a different parent
   * can behave differently and nobody read it sitting there, so every rewrite
   * costs a fresh approval.
   */
  it('withdraws them where the repository ties an approval to the commit', async () => {
    const client = daemon('commit')
    await rebaseOntoUpstream(client)

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('no approval')
  })

  it('refuses a rewrite that changed what the commit does', async () => {
    const client = daemon()

    commit('work')
    await approve((await open(client, 'a branch about to be edited')).reviewId)

    // Same commit, different content, which is the case a patch id exists to
    // tell apart from a reword.
    repo.write('src/work.ts', 'export const work = 2\n')
    repo.run('add', '-A')
    repo.run('commit', '--amend', '--no-edit')

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('deny')
  })
})

/**
 * Rebase is not the only thing that gives a commit a new sha, which is why the
 * setting is named for what an approval follows rather than for one command.
 * Measured against git: a rebase, a reword and a cherry-pick all keep a
 * commit's patch id, and squashing two commits into one changes it.
 */
describe('a commit carried to another branch', () => {
  /**
   * Approves one commit, then puts the same change on a branch that has moved
   * on, so the copy lands under a sha nobody approved.
   *
   * Two things the arrangement has to get right. The branch has to diverge, or
   * a cherry-pick onto the same parent within the same second reproduces the
   * original commit exactly, sha included. And it needs a commit of its own,
   * or the push adds up to the same file set the approved review covered and
   * the range fingerprint clears it before any commit is looked at.
   */
  async function cherryPickElsewhere(client: Client): Promise<void> {
    const start = repo.run('rev-parse', 'HEAD').trim()

    commit('work')
    const approved = repo.run('rev-parse', 'HEAD').trim()
    await approve((await open(client, 'work on its first branch')).reviewId)

    repo.run('checkout', '-q', '-b', 'elsewhere', start)
    commit('groundwork')
    await approve((await open(client, 'the other branch, on its own')).reviewId)

    repo.run('cherry-pick', approved)
    expect(repo.run('rev-parse', 'HEAD').trim()).not.toBe(approved)
  }

  it('takes its approval with it, because the change is the one that was read', async () => {
    const client = daemon()
    await cherryPickElsewhere(client)

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('allow')
    expect(verdict.warnings.join(' ')).toContain('cherry-pick')
  })

  it('leaves it behind where an approval is tied to the commit', async () => {
    const client = daemon('commit')
    await cherryPickElsewhere(client)

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('deny')
  })
})

/**
 * A daemon holding approvals written before commits were the unit of one.
 *
 * Those rows have no per-commit coverage behind them, and denying on that
 * would refuse a reviewer's yes because the schema moved underneath it.
 */
describe('an approval from before this was how the gate asked', () => {
  it('still allows the push it covers', async () => {
    const client = daemon()

    commit('reviewed')
    const review = await open(client, 'approved the old way')
    await approve(review.reviewId)

    // The state a database upgraded into per-commit approval arrives in: the
    // fingerprint stands, and nothing was recorded per commit.
    await ctx.db.deleteFrom('approved_commit').execute()

    const verdict = await gatePush(client)

    expect(verdict.decision).toBe('allow')
  })
})
