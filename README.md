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

## Status

Pre-implementation. See [docs/spec.md](docs/spec.md) for the phase 1 design.
