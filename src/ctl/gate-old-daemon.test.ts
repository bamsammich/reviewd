import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, ClientError } from './client.js'
import { checkGate } from './commands.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * A gate whose daemon predates push gating.
 *
 * `reviewd gate` asks which scope a repository is on before it asks anything
 * else, and a daemon older than that question answers 404. The whole command
 * used to fail, and the hook reads a failed command as an empty answer and
 * denies with "reviewd is not answering", which sends a reader to a log with
 * nothing in it.
 *
 * Upgrading the binary while a container keeps serving the old image is how
 * anybody arrives here, and the README's own upgrade path leads through it.
 */
let repo: TempRepo
let scope: ReturnType<typeof vi.spyOn>
let gate: ReturnType<typeof vi.spyOn>
let started: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  repo = tempRepo()
  repo.write('a.ts', 'const a = 1\n')
  repo.commit('base')
  repo.write('a.ts', 'const a = 2\n')

  scope = vi
    .spyOn(Client.prototype, 'gateScope')
    .mockRejectedValue(new ClientError('no route for POST /api/gate/scope', 404))

  gate = vi.spyOn(Client.prototype, 'gate').mockResolvedValue({
    decision: 'deny',
    reason: 'stubbed',
    reviewUrl: null,
    warnings: [],
    openThreads: [],
    scope: 'commit',
  })

  // The command brings a daemon up before asking it anything, and this suite
  // runs none.
  started = vi.spyOn(Client.prototype, 'health').mockResolvedValue(true)
})

afterEach(() => {
  scope.mockRestore()
  gate.mockRestore()
  started.mockRestore()
  repo.cleanup()
})

describe('a daemon that cannot say which scope applies', () => {
  it('reads as commit gating rather than failing the command', async () => {
    await expect(checkGate(repo.root, true, ['commit'])).resolves.toBeUndefined()

    // Asked anyway, which is the point: the command carried on and produced a
    // verdict instead of dying on the question before it.
    expect(gate).toHaveBeenCalled()
  })

  /**
   * Guessing can only tighten. Every daemon without the scope route gated
   * every commit, so falling back to `commit` is both the older behaviour and
   * the stricter of the two readings.
   */
  it('reports the scope it fell back to, rather than inventing one', async () => {
    const written: string[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })

    await checkGate(repo.root, true, ['commit'])
    out.mockRestore()

    expect(written.join('')).toContain('"scope":"commit"')
  })

  it('leaves a push alone, the way a commit-gated repository does', async () => {
    // Under commit gating a push carries nothing for the gate to hold, so the
    // command allows without asking the daemon for a verdict.
    await checkGate(repo.root, true, ['push'])

    expect(gate).not.toHaveBeenCalled()
  })
})
