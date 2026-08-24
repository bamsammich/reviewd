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
- **One SQLite file.** No database server, nothing to start first.
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

The plugin needs `reviewd` on `PATH`. It is not on npm yet, so until it is, that
means a checkout:

```sh
npm install && npm link
```

Then check it:

```sh
reviewd doctor
```

There is no service to install. The daemon starts on first use: whichever of the
commit gate, the MCP server, or a `reviewd` command needs it first brings it up, and it
stays up for the rest. It logs to `~/.local/state/reviewd/reviewd.log`.

To start it at login rather than on first use, `contrib/` has a launchd agent:

```sh
sed "s|__HOME__|$HOME|g" contrib/com.bamsammich.reviewd.plist \
  > ~/Library/LaunchAgents/com.bamsammich.reviewd.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bamsammich.reviewd.plist
```

That is a convenience, not a requirement. launchd expands neither `~` nor
`$HOME`, which is what the `sed` is for.

### Running the daemon in a container

Reach for this when you would rather not register a long-lived service, or want one command
to stop it and one volume to delete. The container holds everything durable: the database,
the blobs, the web UI you read reviews in, and the approvals the gate asks about. The client,
the gate, and the MCP server stay on the host, where they read your working tree to compute
a diff and upload it. All three are one-shot processes rather than services.

```sh
mkdir -p contrib/docker/config
cp contrib/docker/config.example.json contrib/docker/config/config.json
```

The copy needs no edit for a local container:

```json
{
  "host": "0.0.0.0",
  "port": 7777,
  "public_url": "http://127.0.0.1:7777"
}
```

Leave `host` as it arrives. A container's `127.0.0.1` belongs to the container, and Docker
forwards a published port to its external address, so a daemon bound there answers the host
with an empty reply. The entrypoint refuses that config. `0.0.0.0` widens nothing, since the
container's network namespace holds one process.

```sh
# 127.0.0.1 is the host interface the port is published on, not a bind address.
# It decides who can read and approve reviews.
REVIEWD_PUBLISH=127.0.0.1 docker compose up -d --build
```

Then point the client at it, in `~/.config/reviewd/client.json`:

```json
{ "base_url": "http://127.0.0.1:7777" }
```

That is the whole local setup. One trap: stop the container with `base_url` still on
loopback and the next command that needs a daemon starts one on the host. Name anything else
in `base_url` and the client refuses to start one.

Reviews live in a named volume rather than under `~/.local/state`, holding copies of the
code you review:

```sh
docker compose down          # keeps the volume
docker compose down -v       # deletes every review with it
```

To read reviews from another device, change three values together: publish the port on an
interface it can route to, set `public_url` to that address, and set `base_url` to the same
one.

```sh
REVIEWD_PUBLISH=192.0.2.10 docker compose up -d      # an interface, not a bind address
```

```json
{ "host": "0.0.0.0", "port": 7777, "public_url": "http://192.0.2.10:7777" }
```

The daemon answers to a loopback name, the `public_url` hostname, or `host`, and nothing
else. Point `base_url` outside that set and it answers 421, the gate fails closed, and
reviewd looks down. Docker also cannot publish on a VPN address before that interface
exists, so bring it up first.

To take one repository out of the gate:

```sh
touch "$(git rev-parse --absolute-git-dir)/reviewd-gate-off"
```

### On a harness that is not Claude Code

Nothing about reviewd is Claude-specific; the plugin is packaging. The two
pieces underneath it are ordinary:

- **The MCP server** is `reviewd mcp`, speaking stdio. Register it however
  your harness registers one. `plugin/.mcp.json` is the declaration to copy.
- **The commit gate** is `plugin/hooks/reviewd-gate.sh`. It reads a JSON payload
  on stdin carrying `.tool_input.command` and `.cwd`, and prints a Claude Code
  `PreToolUse` verdict on stdout. For a harness with a different verdict format,
  call `reviewd gate <root>` directly: exit 0 allows, 1 denies, and `--json`
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
