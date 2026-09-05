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

Needs Node 24 or newer, git, and `jq`.

```sh
npm install -g reviewd && reviewd init
```

The first command puts `reviewd` on your `PATH`. The second registers the plugin
with Claude Code, which is what installs the commit gate hook, the MCP server,
and the skill that drives a review. Restart Claude Code afterwards to load it.

`init` prints what it is about to do — which marketplace and plugin, which files
it will rewrite, and that one of them is a hook refusing `git commit` — and waits
for a yes. It copies every file it names, timestamped, before touching any, and
reports each path afterwards.

```sh
reviewd init --dry-run   # print the plan, change nothing
reviewd init --yes       # skip the question, for scripts
```

A pipe is not asked: run from something that is not a terminal, `init` proceeds
and still prints the plan and the paths.

Check it with `reviewd doctor`, which reports where the daemon answers and
whether the plugin matches the binary.

### Upgrading

```sh
npm install -g reviewd@latest
```

The plugin is a separate artifact that Claude Code holds a copy of, so it would
otherwise need a second command: the MCP server notices the mismatch on its next
start and updates, and the new copy loads the session after. `reviewd init` does
the same thing on demand, and `reviewd doctor` says whether the two are lined
up. Nothing here asks you to run `claude plugin` yourself.

`reviewd init` also turns on auto-update for the marketplace it adds, which it
names in the plan before asking. Claude Code then refreshes the plugin on its
own, so an upgrade no longer waits for the next session to notice. Turning it
back off is a job for the `/plugin` UI, and init writes Claude Code's own state
rather than a declaration that would override that choice later.

A daemon in a container is the one piece npm cannot reach, because the image
carries its own copy of reviewd:

```sh
docker compose up -d --build
```

Everything a reviewer looks at is served by the daemon, so a container left on
the old image keeps showing the old review page however current the binary is.
`reviewd doctor` reports where the daemon answers and not which version
answered, so it will not catch this for you.

### Configuring it

Nothing here is required. The daemon writes `~/.config/reviewd/config.json` with
defaults on first start, and every setting below is optional.

```json
{
  "port": 7777,
  "public_url": "http://127.0.0.1:7777",
  "ui": { "font_scale": 1 },
  "gate": { "scope": "commit" }
}
```

| key | decides |
| --- | --- |
| `host`, `port` | where the daemon listens, and so who can reach it |
| `public_url` | the address every review link opens, which a tunnel has to say |
| `ui.font_scale` | how large the pages draw, between `0.75` and `1.5` |
| `gate.scope` | whether the gate holds every commit or every push |
| `gate.approval_follows` | whether an approval is attached to what a commit does or to the commit itself |
| `limits` | the largest file uploaded, and the most files one revision may carry |
| `sweep.review_idle_days` | how long an untouched review lives |
| `notify.webhook_url` | where to POST when a review is waiting for you |

Clients find the daemon through `~/.config/reviewd/client.json`, and a missing
file means loopback:

```json
{ "base_url": "http://127.0.0.1:7777" }
```

Every key, every environment variable, and the reasoning behind the defaults are
in [docs/configuration.md](docs/configuration.md).

### Running the daemon

There is no service to install. The daemon starts on first use: whichever of the
commit gate, the MCP server, or a `reviewd` command needs it first brings it up,
and it stays up for the rest. It logs to `~/.local/state/reviewd/reviewd.log`.

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

Use compose rather than `docker run`. The image does not carry `--bind-public`; compose
passes it on the line next to `ports:`, so the permission to bind widely and the decision
about who can reach it are read together. A bare `docker run -p 7777:7777` would otherwise
publish an unauthenticated review server on every interface, which is exactly the accident
that flag exists to prevent.

Two things worth knowing on Linux. A published port is DNAT'd ahead of `INPUT`, so `ufw` and
`firewalld` do not filter it — a default-deny policy will not save a wide `REVIEWD_PUBLISH`.
And `--network host` makes `host: "0.0.0.0"` bind the machine's real interfaces, so the note
below about it widening nothing stops being true.

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

### What the gate holds

Every commit, which is the default and what a fresh install does. A branch built
out of five small commits therefore takes five approvals.

The daemon's `config.json` decides, per repository:

```json
{
  "gate": {
    "scope": "commit",
    "roots": { "/Users/you/code/scratch": "push" }
  }
}
```

`scope` is what a repository gets when it has no entry of its own, and `roots`
names the exceptions by absolute path. Matching is exact: a repository nested
inside a named one keeps the default rather than inheriting a setting nobody
chose for it.

The setting lives with the daemon rather than beside the code, because the hook
already sends the repository root and already waits for an answer, so the scope
rides back on a call that was happening anyway. A committed file would put a
gate setting into a pull request, and an environment variable would let a gate
loosen because of something exported in one shell.

Under `push`, a commit runs free and the gate holds the push instead. What a
push carries is every commit no remote has yet, so a branch of five commits is
one approval rather than five, and the working tree is not part of it: an
uncommitted edit is not being pushed.

A rebase that changed no file keeps its approval, because what is approved is
the change set rather than the commit ids. A rebase that resolved a conflict
changed a file, so the gate asks again.

One gap worth knowing: any remote counts as published, so a branch pushed to a
fork and then to upstream produces an empty range the second time and sails
through.

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

### What the gate cannot see

The gate reads the text of a command before it runs, so a commit recorded from
inside another program is invisible to it. `npm version patch` is named in the
hook because the release path here goes through it, but `cargo release`, a
Makefile target, and a script written moments earlier all pass the same way.
Nothing that runs before a command can see a commit that has not happened yet.

`reviewd observe` covers that afterwards. It runs on every Bash command,
compares what a commit recorded against what an approval cleared, and reports a
commit that got past. It reports nothing once a review is released, because
releasing deletes the review and observe speaks only about a repository some
review covers. So release last, after anything else that writes commits.

## Developing on reviewd

Load the plugin from a checkout without installing it:

```sh
npm install && npm link
export REVIEWD_NO_PLUGIN_SYNC=1
claude --plugin-dir ./plugin
```

`npm link` puts the checkout's `reviewd` on `PATH`, which the hook and the MCP
declaration both call. A local plugin wins over an installed one of the same
name for that session. `/reload-plugins` picks up edits.

`REVIEWD_NO_PLUGIN_SYNC` is not optional here. The MCP server reinstalls the
plugin whenever its version differs from the binary's, and in a checkout they
always differ, so without it a dev session upgrades the installed plugin on
startup.

| Variable                        | Effect                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `REVIEWD_NO_PLUGIN_SYNC=1`      | Stops the MCP server reinstalling the plugin on version drift.                            |
| `REVIEWD_BIN=<path>`            | Binary the gate hook and the MCP server run. The gate prints the redirect on every commit. |
| `REVIEWD_MARKETPLACE_SOURCE=<path>` | Where `reviewd init` installs from. A persistent `--plugin-dir`.                      |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Config and database roots. Repoint both for a dev daemon on its own port.             |

Only an explicit `reviewd init` repoints a marketplace. The automatic sync
leaves an unexpected one alone and says so on stderr.

```sh
npm test                              # the daemon and client suites
./plugin/hooks/reviewd-gate.test.sh   # the commit gate, which is shell
claude plugin validate ./plugin
npm run icons                         # after upgrading @phosphor-icons/core
npm run languages                     # after upgrading shiki
```

`npm run languages` rewrites the diff's extension map from the grammars shiki
bundles, and prints the extensions two grammars both claim. Those are left out
of the map; deciding one means adding it to `DECIDED_BY_EXTENSION` in
`highlight.ts`, which overrides anything generated.

### Cutting a release

```sh
npm version patch && git push --follow-tags
```

That is the whole release. `npm version` writes the new number into
`plugin/.claude-plugin/plugin.json` as well, and pushing the tag starts
`.github/workflows/release.yml`, which runs the full CI suite, publishes to
npm, and creates the GitHub Release with generated notes.

The Release comes after `npm publish`, since npm is the half that cannot be
taken back. A re-run skips a Release that already exists rather than failing on
it.

Three things it refuses to publish through: an npm older than 11.5.1, a tag that
disagrees with `package.json`, and a `plugin.json` left on the old version. Each
fails before `npm publish` runs, so a bad tag costs a re-tag rather than a
deprecation.

There is no npm token anywhere. The workflow authenticates with npm's trusted
publishing over OIDC, which also attaches provenance. Setting that up is a
one-time step on npmjs.com: on the `reviewd` package, add a trusted publisher
for the `bamsammich/reviewd` repository with workflow `release.yml`.

## Status

Working. The daemon, the CLI, the web UI, the MCP interface, and the commit gate
all run. See [docs/spec.md](docs/spec.md) for the phase 1 design.
