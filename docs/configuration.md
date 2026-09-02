# Configuration

The daemon writes `~/.config/reviewd/config.json` the first time it starts,
filled with the defaults described here. Every key in it is optional.

Clients read `~/.config/reviewd/client.json` to find the daemon. That file is
optional too, and a missing one means loopback.

`XDG_CONFIG_HOME` moves both.

A malformed file is an error rather than a silent fallback. A typo in
`public_url` would otherwise send every review link to a dead address, with the
rest of reviewd looking healthy.

## Where the files live

| file | holds | default when absent |
| --- | --- | --- |
| `~/.config/reviewd/config.json` | everything the daemon decides | written on first start |
| `~/.config/reviewd/client.json` | where the daemon is | `http://127.0.0.1:7777` |
| `$XDG_STATE_HOME/reviewd/reviews.db` | reviews, comments, uploaded code | created on first use |
| `$XDG_STATE_HOME/reviewd/reviewd.log` | the daemon's own log | created on first use |

Neither file holds a credential, because reviewd has none. Reachability is the
access boundary: whoever can open the daemon's address can read the reviews on
it and approve them. Everything about `host`, `port` and `public_url` is
therefore a decision about who that is.

## The daemon's config.json

Every key below is optional. What follows each is what the daemon uses when the
key is absent.

### Where it listens, and who can reach it

```json
{
  "host": "127.0.0.1",
  "port": 7777,
  "public_url": null
}
```

**`host`** is the interface the daemon binds. Loopback by default, which is one
machine and no network. Binding anything wider needs `reviewd serve
--bind-public` as well, so widening the reach of an unauthenticated review
server takes saying so twice, in two places.

**`port`** is the port it binds.

**`public_url`** goes into every link the daemon writes: the URL an agent hands
you, and the one a push notification opens. A daemon knows what it bound and
cannot know what address your phone should open, so a tunnel has to say. Null
falls back to `http://host:port`.

Setting it also decides what the daemon answers to. It accepts a loopback name,
the `public_url` hostname, or `host`, and refuses everything else with 421,
which is what stops a rebinding attack against a daemon reachable from a
network. Point a client somewhere outside that set and the gate fails closed
while reviewd looks down.

### Where reviews are kept

```json
{ "database": { "path": "" } }
```

An empty path means `$XDG_STATE_HOME/reviewd/reviews.db`. The file holds every
review, every comment, and a copy of the code each review covers.

### How large the pages draw

```json
{ "ui": { "font_scale": 1 } }
```

A multiplier on the browser's own text size, between `0.75` and `1.5`. How much
of a diff fits on one screen is a matter of eyesight and monitor rather than
something the daemon can pick: `0.9` fits about a tenth more of a file, and
`1.15` is the same page for someone who would otherwise lean in.

Touch targets stay 44px at any scale, so shrinking the text never shrinks a
control below what a thumb can hit.

### What the commit gate holds

```json
{
  "gate": {
    "scope": "commit",
    "roots": { "/Users/you/code/scratch": "push" },
    "approval_follows": "change"
  }
}
```

**`scope`** is `commit` or `push`, and applies to any repository without an
entry of its own. Under `commit`, every commit needs an approval covering the
bytes it records. Under `push`, a commit runs free and the push is held
instead, so a branch of five commits is one approval rather than five.

**`roots`** names exceptions by absolute path. Matching is exact: a repository
nested inside a named one keeps the default rather than inheriting a setting
nobody chose for it.

**`approval_follows`** is `change` or `commit`, and decides whether an approval
is attached to what a commit does or to the commit itself. A push is approved
commit by commit, and plenty of ordinary git gives a commit a new sha while
leaving its change alone.

Under `change`, the default, a commit whose sha has moved is recognised by `git
patch-id --stable`, so an approved stack stays approved through the rewrites
that stacked work runs on. The gate reports the move in a warning rather than
refusing it. The claim is deliberately weaker than a sha: it says somebody read
this change, not that they read it sitting where it now sits.

Rebase is the common case and not the only one. Measured against git:

| operation | patch id |
| --- | --- |
| rebase onto new upstream work | unchanged |
| `commit --amend` that only rewords | unchanged |
| `cherry-pick` onto another branch | unchanged |
| two commits squashed into one | changes |

So an approved commit cherry-picked to another branch arrives approved, and a
squash needs reading again.

Under `commit`, any rewrite throws away the approval it rewrites. Choose it
where a review is about a state rather than a change, since the same patch
applied to a different parent can behave differently and nobody read it there.
Every rewrite then costs a fresh approval, which is the point.

The setting lives here rather than beside the code because the hook sends the
repository root and waits for an answer anyway, so the scope rides back on a
call that was happening regardless. A committed file would put a gate setting
into a pull request, and an environment variable would let a gate loosen
because of something exported in one shell.

Nothing here will change `commit` into anything else on your behalf. An upgrade
that quietly stopped denying commits would be the failure reviewd exists to
prevent, arriving through its own release.

### What a review may carry

```json
{
  "limits": {
    "max_blob_bytes": 2097152,
    "max_files_per_snapshot": 2000
  }
}
```

**`max_blob_bytes`** is the largest file whose content is uploaded. Anything
above it is described rather than stored, so the review page says the file
changed and cannot show it. The hash still travels, so a file nobody could read
still moves the approval when it changes.

**`max_files_per_snapshot`** caps one revision. A push carrying more is refused
rather than truncated, because a review missing files nobody was told about is
worse than a review that did not open.

### When an idle review is swept

```json
{ "sweep": { "review_idle_days": 14 } }
```

A review nothing has touched for this long is deleted, along with the code it
held. Opening a review counts as touching it, so reading one keeps it.

### Telling you a review is waiting

```json
{
  "notify": {
    "webhook_url": null,
    "template": null
  }
}
```

**`webhook_url`** receives a POST when a review wants you. Null sends nothing.

**`template`** is the body to send. Null sends JSON:

```json
{ "title": "...", "url": "...", "threads_awaiting_you": 0 }
```

A template may use `{{title}}`, `{{url}}` and `{{threads}}`. A template that
parses as JSON gets JSON-escaped values, because a review title is whatever an
agent typed and a title carrying a quote would otherwise close the string and
add fields of its own to the outgoing request.

Telegram, as an example:

```json
{
  "notify": {
    "webhook_url": "https://api.telegram.org/bot<token>/sendMessage",
    "template": "{\"chat_id\":\"<id>\",\"text\":\"{{title}} ({{url}})\"}"
  }
}
```

## The client's client.json

```json
{ "base_url": "http://127.0.0.1:7777" }
```

Where the CLI, the MCP server and the commit gate look for a daemon. A missing
file means loopback, which is the whole setup for a daemon on the same machine.

One trap worth knowing: with `base_url` on loopback, a command that needs a
daemon starts one. Name anything else and the client refuses to, since a daemon
somewhere else is not one this machine can bring up.

## Environment variables

| variable | read by | does |
| --- | --- | --- |
| `REVIEWD_URL` | every client | overrides `base_url` for one command |
| `REVIEWD_SKIP=1` | the commit gate | lets one commit through, and says so |
| `XDG_CONFIG_HOME` | daemon and clients | moves both config files |
| `XDG_STATE_HOME` | the daemon | moves the database and the log |
| `REVIEWD_PUBLISH` | `contrib/docker` compose | the host interface the container's port is published on |
| `REVIEWD_NO_PLUGIN_SYNC=1` | `reviewd init` | skips the plugin catch-up |
| `REVIEWD_MARKETPLACE_SOURCE` | `reviewd init` | the marketplace to install the plugin from |

`REVIEWD_SKIP=1` is a deliberate escape and the gate names it in every denial,
because a gate with no way past teaches people to work around it in ways nobody
can see. It is read from the command text, so it is visible in the transcript
of whoever used it.

`REVIEWD_URL` does not reach the commit gate. Claude Code spawns the hook, so an
env prefix on a git command never arrives; the gate asks whichever daemon
`client.json` names.

## Turning the gate off for one repository

```sh
touch "$(git rev-parse --absolute-git-dir)/reviewd-gate-off"
```

The marker sits inside the git directory rather than the working tree, which
puts it beyond reach of a commit, a pull request, or a clone. Delete the file
to turn the gate back on.

## Command-line flags that override config

| flag | on | does |
| --- | --- | --- |
| `--config <path>` | `reviewd serve` | reads a config file from somewhere else |
| `--bind-public` | `reviewd serve` | permits binding an address beyond this machine |

`--bind-public` is a second decision on purpose. `host` names an interface,
while the flag states an intention: that reaching this review server from a
network is wanted. A config alone cannot widen it.
