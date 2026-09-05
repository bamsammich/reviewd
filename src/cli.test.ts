import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram, type Handlers } from './cli.js'

/**
 * Handlers that record instead of doing, so a test can assert what a command
 * was asked for without a daemon, a repository, or a Claude Code on the box.
 */
function spies() {
  return {
    init: vi.fn(async () => {}),
    serve: vi.fn(async () => {}),
    mcp: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    fingerprint: vi.fn(async () => {}),
    gate: vi.fn(async () => {}),
    observe: vi.fn(async () => {}),
    doctor: vi.fn(async () => {}),
  } as unknown as Handlers & Record<keyof Handlers, ReturnType<typeof vi.fn>>
}

let handlers: ReturnType<typeof spies>

beforeEach(() => {
  handlers = spies()
})

/**
 * Runs one invocation and returns what came out.
 *
 * `exitOverride` turns commander's `process.exit` into a throw, and the output
 * is captured rather than written, so a failing parse is a value to assert on
 * instead of a dead test process.
 */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''

  const program = buildProgram(handlers)

  // Applied to every subcommand as well as the program. Commander copies
  // inherited settings when a subcommand is created, and buildProgram creates
  // its subcommands first, so a subcommand left alone still calls the real
  // process.exit and ends the whole run rather than failing one test.
  for (const command of [program, ...program.commands]) {
    command.exitOverride().configureOutput({
      writeOut: (s) => (out += s),
      writeErr: (s) => (err += s),
    })
  }

  try {
    await program.parseAsync(argv, { from: 'user' })
    return { code: 0, out, err }
  } catch (error) {
    return { code: (error as { exitCode?: number }).exitCode ?? 1, out, err }
  }
}

/**
 * The reason this file exists.
 *
 * parseArgs held one flag table for the whole binary, so every flag parsed for
 * every command and the wrong ones were silently dropped: `reviewd gate --yes`
 * ran the gate and ignored `--yes`. Nothing failed, so nothing said so. Each
 * case below is a flag that used to be accepted by a command that never read
 * it.
 */
describe('flags are scoped to the command that reads them', () => {
  // `wait` carries --review because it is required, and commander reports a
  // missing required option before it reaches an unknown one — which would
  // pass this test for the wrong reason.
  it.each([
    ['init', '--bind-public', []],
    ['init', '--config', []],
    ['init', '--json', []],
    ['init', '--review', []],
    ['gate', '--yes', []],
    ['gate', '--dry-run', []],
    ['serve', '--review', []],
    ['serve', '--json', []],
    ['wait', '--json', ['--review', 'r1']],
    ['wait', '--yes', ['--review', 'r1']],
    ['doctor', '--json', []],
    ['fingerprint', '--yes', []],
    ['mcp', '--dry-run', []],
    ['observe', '--json', []],
  ])('%s rejects %s', async (command, flag, extra) => {
    const { code, err } = await run([command, ...extra, flag, 'x'])

    expect(code).not.toBe(0)
    expect(err).toContain(`unknown option '${flag}'`)
  })

  it.each([
    ['init', ['--dry-run', '--yes']],
    ['serve', ['--bind-public']],
    ['gate', ['--json']],
    ['fingerprint', ['--json']],
  ])('%s accepts its own %s', async (command, flags) => {
    expect((await run([command, ...flags])).code).toBe(0)
  })
})

describe('each command reaches its handler with what it was given', () => {
  it('init passes both flags through', async () => {
    await run(['init', '--dry-run', '--yes'])
    expect(handlers.init).toHaveBeenCalledWith({ dryRun: true, yes: true })
  })

  it('init defaults both to false', async () => {
    await run(['init'])
    expect(handlers.init).toHaveBeenCalledWith({ dryRun: false, yes: false })
  })

  /**
   * Omitted rather than passed as undefined: `serve` reads configPath to decide
   * whether to look for a config at all, and the repository compiles with
   * exactOptionalPropertyTypes.
   */
  it('serve omits configPath when --config is absent', async () => {
    await run(['serve'])
    expect(handlers.serve).toHaveBeenCalledWith({ bindPublic: false })
  })

  it('serve passes a config path when given one', async () => {
    await run(['serve', '--config', '/tmp/c.json', '--bind-public'])
    expect(handlers.serve).toHaveBeenCalledWith({ configPath: '/tmp/c.json', bindPublic: true })
  })

  it('gate defaults its path to the working directory, and asks about a commit', async () => {
    await run(['gate'])
    expect(handlers.gate).toHaveBeenCalledWith(process.cwd(), false, ['commit'], undefined)
  })

  // Defaulting to commit is what lets a hook from an older plugin keep working
  // against a newer binary.
  it('gate takes the verb the hook saw', async () => {
    await run(['gate', '/repo', '--for', 'push'])
    expect(handlers.gate).toHaveBeenCalledWith('/repo', false, ['push'], undefined)
  })

  // `git commit -m x && git push` reaches the hook as one string, so both
  // verbs have to travel or one of them goes ungated.
  it('gate takes both verbs from one command', async () => {
    await run(['gate', '/repo', '--for', 'commit,push'])
    expect(handlers.gate).toHaveBeenCalledWith('/repo', false, ['commit', 'push'], undefined)
  })

  it('gate refuses a verb it does not gate', async () => {
    const { code, err } = await run(['gate', '/repo', '--for', 'rebase'])

    expect(code).not.toBe(0)
    expect(err).toContain('commit or push')
    expect(handlers.gate).not.toHaveBeenCalled()
  })

  // The remote a push named, when the command named one. Without it the range
  // is measured against the branch's own remote, which answers a bare push and
  // gets `git push other` wrong.
  it('gate carries the remote a push named', async () => {
    await run(['gate', '/repo', '--for', 'push', '--remote', 'upstream'])
    expect(handlers.gate).toHaveBeenCalledWith('/repo', false, ['push'], 'upstream')
  })

  it('gate takes a path and --json', async () => {
    await run(['gate', '/repo', '--json'])
    expect(handlers.gate).toHaveBeenCalledWith('/repo', true, ['commit'], undefined)
  })

  it('fingerprint takes a path and --json', async () => {
    await run(['fingerprint', '/repo', '--json'])
    expect(handlers.fingerprint).toHaveBeenCalledWith('/repo', true)
  })

  it('observe defaults its path to the working directory', async () => {
    await run(['observe'])
    expect(handlers.observe).toHaveBeenCalledWith(process.cwd())
  })

  it('observe takes a path', async () => {
    await run(['observe', '/repo'])
    expect(handlers.observe).toHaveBeenCalledWith('/repo')
  })

  it('wait defaults the timeout to an hour', async () => {
    await run(['wait', '--review', 'r1'])
    expect(handlers.wait).toHaveBeenCalledWith('r1', 3600)
  })
})

describe('wait --timeout', () => {
  /**
   * `Number('30s')` is NaN and `Date.now() < NaN` is false, so the wait loop
   * never runs and the command is gone in milliseconds. The documented workflow
   * backgrounds `reviewd wait` and reads the verdict off the first line, so a
   * typo used to arrive as "the reviewer sat on the review for an hour".
   */
  it.each(['30s', 'soon', '0', '-5', 'NaN', ''])('refuses %o out loud', async (value) => {
    const { code, err } = await run(['wait', '--review', 'r1', '--timeout', value])

    expect(code).not.toBe(0)
    expect(err).toMatch(/positive number of seconds/)
    expect(handlers.wait).not.toHaveBeenCalled()
  })

  it('accepts a plain number', async () => {
    await run(['wait', '--review', 'r1', '--timeout', '30'])
    expect(handlers.wait).toHaveBeenCalledWith('r1', 30)
  })
})

describe('wait --review', () => {
  it('is required, rather than waiting on nothing', async () => {
    const { code, err } = await run(['wait'])

    expect(code).not.toBe(0)
    expect(err).toContain("required option '--review <id>'")
    expect(handlers.wait).not.toHaveBeenCalled()
  })
})

describe('unknown input', () => {
  /**
   * A typo should say it is a typo. An earlier shape of this file gave the
   * program its own action handler, which made commander read a stray word as
   * an argument to that handler and answer "too many arguments" instead.
   */
  it('names an unknown command as unknown', async () => {
    const { code, err } = await run(['nonsense'])

    expect(code).not.toBe(0)
    expect(err).toContain("unknown command 'nonsense'")
  })

  it('runs nothing when the command is not recognised', async () => {
    await run(['nonsense'])
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()
  })
})

describe('help', () => {
  it('lists every command', async () => {
    const { out } = await run(['--help'])

    for (const command of ['init', 'serve', 'mcp', 'wait', 'gate', 'fingerprint', 'doctor']) {
      expect(out).toContain(command)
    }
  })

  /** The exit-code contract was in the old hand-written USAGE and has to survive. */
  it('keeps the exit-code contract and the bind warning', async () => {
    const { out } = await run(['--help'])

    expect(out).toMatch(/gate: 0 allowed, 1 denied/)
    expect(out).toMatch(/wait: 0 answered, 124 timeout/)
    expect(out).toMatch(/--bind-public is required/)
  })

  it('gives each command its own help', async () => {
    const { out } = await run(['init', '--help'])

    expect(out).toContain('--dry-run')
    expect(out).not.toContain('--bind-public')
  })
})
