import { installLocations, type InitPlan, type InitResult } from './init.js'

/**
 * What `reviewd init` says before it does anything.
 *
 * Split from the command so it is a pure function of the plan and can be
 * asserted on. `reviewd init` used to print "marketplace added, plugin
 * installed" after the fact and nothing before it, which left the reader with
 * no way to know what had changed on their machine — Travis ran it on
 * 2026-08-25 and could not tell.
 */
export function renderPlan(plan: InitPlan): string {
  const where = installLocations()
  const lines: string[] = ['reviewd init will:', '']

  lines.push(marketplaceLine(plan), `    checkout   ${where.marketplace}`, '')

  const version =
    plan.plugin.installed && plan.plugin.installed !== plan.plugin.version
      ? `${plan.plugin.installed} -> ${plan.plugin.version}`
      : plan.plugin.version

  lines.push(
    `  install plugin ${plan.plugin.name} ${version}`,
    `    cache      ${where.plugin}`,
    '',
    '  back up, timestamped, before touching anything:',
    ...plan.paths.map((path) => `    ${path}`),
    '',
    // The gate is the whole point of the tool and was the one thing init never
    // mentioned. Installing a commit blocker without saying so is the kind of
    // surprise that gets a tool uninstalled.
    '  The plugin installs a hook that refuses `git commit` until a review is',
    '  approved. To turn it off in one repository:',
    '    touch "$(git rev-parse --absolute-git-dir)/reviewd-gate-off"',
    '',
  )

  return lines.join('\n')
}

function marketplaceLine(plan: InitPlan): string {
  const { name, source, action, current } = plan.marketplace

  if (action === 'repoint') {
    return `  REPOINT marketplace ${name}: ${current} -> ${source}`
  }

  return `  ${action === 'add' ? 'add' : 'update'} marketplace ${name} (${source})`
}

/** What it says afterwards: every path it touched, and nothing it did not. */
export function renderResult(result: InitResult): string {
  const where = installLocations()
  const lines = [
    `reviewd init: marketplace ${result.marketplace}, plugin installed.`,
    '',
    'Touched:',
    ...result.paths.map((path) => `  ${path}`),
    `  ${where.marketplace}`,
    `  ${where.plugin}`,
  ]

  if (result.backups.length > 0) {
    lines.push('', 'Backed up:', ...result.backups.map(([, to]) => `  ${to}`))
  } else {
    lines.push('', 'Backed up: nothing — none of those files existed yet.')
  }

  lines.push('', 'Restart Claude Code to load it.', '')
  return lines.join('\n')
}
