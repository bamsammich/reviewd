# reviewd

A local-first code review service for working with coding agents.

The agent writes code and opens a review. You read the diff in a GitHub-PR-style web UI,
leave comments on specific lines, and go back and forth in threads until you're satisfied.
Nothing gets committed until the review covering that repo is clean.

## Why this exists

Existing local diff viewers assume one process, one repo, one ephemeral session. That
breaks down fast:

- Two agent sessions collide on a port, and the second one silently reads the first one's
  comments.
- A change spanning two directories only gets reviewed in one of them.
- Comments go one way. The agent replies, you can't answer.
- Everything lives in memory, so restarting loses the review.
- The review is on `127.0.0.1`, so you can't look at it from your phone.

`reviewd` treats a review as a durable object with an identity, not a running process.

## Shape

- **One daemon, one port, many reviews.** Reviews live at `/r/<id>`, so concurrent
  sessions never collide.
- **A review spans several roots.** Multiple directories and repos render as one file tree.
- **Threads carry history.** Human and agent both post; the agent can also open threads on
  its own work to flag judgment calls.
- **Snapshots.** When the agent revises, comments re-anchor to the moved code instead of
  vanishing.
- **The daemon never touches git.** The client computes and uploads, so the daemon runs
  anywhere.
- **One SQLite file.** No database server, no container, nothing to start first.
- **MCP interface.** The agent drives reviews through tools, not shell commands.
- **Commit gate.** A `PreToolUse` hook asks the daemon whether this diff is approved.

Remote access is a documented recipe, not a dependency. Loopback works out of the box; LAN,
VPN, reverse proxy, and Tailscale each get a config block in the docs.

## Install

Two commands. Needs Node 26, git, and `jq`.

```sh
claude plugin marketplace add bamsammich/reviewd
claude plugin install reviewd@bamsammich
```

That installs the commit gate hook, the MCP server, and the skill that drives a
review.

The plugin needs `reviewd` and `reviewctl` on `PATH`. They are not on npm yet,
so until they are, that means a checkout:

```sh
npm install && npm run build && npm link -ws
```

Then check it:

```sh
reviewctl doctor
```

There is no service to install. The daemon starts on first use: whichever of the
commit gate, the MCP server, or `reviewctl` needs it first brings it up, and it
stays up for the rest. It logs to `~/.local/state/reviewd/reviewd.log`.

To start it at login rather than on first use, `contrib/` has a launchd agent:

```sh
sed "s|__HOME__|$HOME|g" contrib/com.bamsammich.reviewd.plist \
  > ~/Library/LaunchAgents/com.bamsammich.reviewd.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bamsammich.reviewd.plist
```

That is a convenience, not a requirement. launchd expands neither `~` nor
`$HOME`, which is what the `sed` is for.

To take one repository out of the gate:

```sh
touch "$(git rev-parse --absolute-git-dir)/reviewd-gate-off"
```

### On a harness that is not Claude Code

Nothing about reviewd is Claude-specific; the plugin is packaging. The two
pieces underneath it are ordinary:

- **The MCP server** is `reviewctl mcp`, speaking stdio. Register it however
  your harness registers one. `plugin/.mcp.json` is the declaration to copy.
- **The commit gate** is `plugin/hooks/reviewd-gate.sh`. It reads a JSON payload
  on stdin carrying `.tool_input.command` and `.cwd`, and prints a Claude Code
  `PreToolUse` verdict on stdout. For a harness with a different verdict format,
  call `reviewctl gate <root>` directly: exit 0 allows, 1 denies, and `--json`
  gives the reason, the review URL, and any open threads.

## Developing on reviewd

Load the plugin from a checkout without installing it:

```sh
claude --plugin-dir ./plugin
```

A local copy takes precedence over an installed one of the same name for that
session, so this works without uninstalling first. `/reload-plugins` picks up
edits.

```sh
npm test                          # the daemon and client suites
./plugin/hooks/reviewd-gate.test.sh   # the commit gate, which is shell
claude plugin validate ./plugin
```

## Status

Working. The daemon, the CLI, the web UI, the MCP interface, and the commit gate
all run. See [docs/spec.md](docs/spec.md) for the phase 1 design.
