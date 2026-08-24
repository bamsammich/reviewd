# reviewd: Phase 1 Spec

A local-first code review service. A human reviewer reads an agent's changes in a
GitHub-PR-style web UI, holds threaded conversations on specific lines, and no commit lands
until the review is approved. The agent drives the service through MCP.

One binary, `reviewd`, with two roles behind subcommands. `reviewd serve` is the daemon.
The client subcommands — `mcp`, `gate`, `wait`, `fingerprint`, `doctor` — compute diffs,
speak MCP to the coding agent, and answer the commit hook. The daemon still never touches
git; the split described throughout is between processes, not between programs.

Two roles appear throughout: **the reviewer**, a human, and **the agent**, a coding agent
holding a session on the reviewer's machine.

---

## 1. Goals and non-goals

### Goals

1. Concurrent reviews that never collide. A review is addressed by identity, not by port.
2. One review spans any number of directories and git repositories, rendered as one file
   tree.
3. Threads carry a message history and both roles post into them.
4. Threads, approvals, and review content survive a daemon restart.
5. A commit is blocked until an approval covering that repository exists.
6. The web UI is reachable from a phone without depending on any particular network
   product.
7. Zero configuration to run: one SQLite file, no external services.

### Non-goals

- **Multiple reviewers.** One reviewer identity. The schema leaves room; the UI does not.
- **An archive.** Reviews are working state, deleted once the agent acknowledges the
  outcome. Nothing here is a record of what was reviewed.
- **A hosting product.** Nothing is exposed to the public internet by default, and no
  configuration key makes that a one-step operation.
- **Its own authentication.** Network reachability is the access boundary for *reading* a
  review. If that stops being enough, the replacement is a standard mechanism rather than a
  bespoke one. Approving is a separate question, answered in section 4.
- **Merge conflict resolution, CI integration, branch management.**
- **Review authorship by the agent.** The agent surfaces changes and answers questions. It
  does not judge them.

---

## 2. The invariant that shapes everything

**The daemon never touches git.**

The client computes diffs and uploads content. The daemon stores, renders, and serves.

Four properties follow from it:

- A review remains readable after the working tree moves on. A daemon that read git would
  render a live window onto whatever HEAD points at, which is wrong the moment a branch
  changes mid-review.
- Multi-root is not a special case. The client uploads N roots and the daemon holds no
  opinion about how they relate. A daemon that read git would keep N repository handles and
  resolve N base refs per request.
- The repository under review is named explicitly by the client. A daemon that resolved a
  repository root from its own working directory can silently render a different repository
  than the one intended.
- The daemon runs anywhere. No second code path exists for a deployment away from the
  machine holding the code.

Consequences:

- Snapshots are pushed, never pulled.
- Review content is stored, not referenced.
- `open in editor` and live file watching are local-only capabilities, advertised by the
  daemon at `GET /api/capabilities` and hidden in the UI when absent.

---

## 3. Deployment shapes

### Local (default)

```
agent session ──stdio──> reviewd mcp ──HTTP──> reviewd (127.0.0.1:7777) ──> SQLite
                                                      │
commit hook ──────────────HTTP───────────────────────>│
                                                      │
browser / phone ────────HTTP(S)──────────────────────>┘
```

One launchd agent, one SQLite file, one port. `reviewd mcp` is a short-lived stdio process
the agent harness spawns per session.

### Split

```
dev machine:  agent session ──> reviewd mcp ──┐
              commit hook ─────────────────────┤
                                               └──HTTPS──> reviewd (server) ──> SQLite
```

Same protocol, same database engine, a different box and a persistent volume. The shim
carries a base URL from configuration instead of reaching loopback.

Out of scope for phase 1. The push invariant makes it free, and nothing in the build order
targets it.

---

## 4. Network exposure and access

`reviewd` binds a host and port and answers HTTP. Anything that routes to it works: LAN,
VPN, SSH tunnel, reverse proxy, Tailscale. No network product is a dependency, and none has
a code path.

### Binding

`host` defaults to `127.0.0.1`, `port` to `7777`. `0.0.0.0` opens the daemon to the LAN, and
a specific interface address narrows it further.

### The access boundary is the network

Whatever can reach the port can read and comment on the reviews. At every binding the daemon
supports, reaching the port means clearing a check stronger than any the daemon could
impose.

| Binding | Reaching the port requires | Strength of that check |
|---|---|---|
| `127.0.0.1` (default) | code execution on the machine | total. Anything with it can read the repositories directly, no daemon involved |
| a LAN address | membership on that network | as strong as the network. Weak on shared or guest wifi |
| behind `tailscale serve` | a device on the tailnet | device authentication, SSO identity, and ACLs, all enforced before the daemon sees a packet |

Credentials add nothing on loopback: the file holding them is readable by the same user that
can read the working tree. Behind a tunnel they duplicate a check the tunnel enforces first.
A LAN bind is the one case that gains, and a tunnel covers it better.

The daemon therefore ships no credentials, no login, and no sessions. A link to a review is a
link.

If reachability stops being a sufficient boundary, the replacement is an established
mechanism: an identity provider in front, or OIDC in the daemon.

### Reading and approving are different questions

The argument above is about reading, and it holds: anything that can reach the port can
already read the repository directly, so a password on the daemon protects nothing.

It does not carry over to approving. The gate exists to constrain the agent, and the agent
runs on this machine with code execution by construction — the very thing that makes
credentials pointless for reading is the thing that makes the agent the attacker here. An
approval the agent can write is a gate that clears itself.

So the two surfaces are kept apart:

- **The agent's API cannot approve.** `POST /api/reviews/:id/submissions` takes `comment` and
  `changes_requested` and refuses `approved`. There is no other route that writes an approval.
- **A verdict needs a token from the page.** The review page mints one into the submit form,
  signed with a key held in the daemon's memory and bound to the current revision. Approving
  without opening the review means scraping the UI.

**What this does not do, and why that is the right place to stop.** An agent that reads the
review page can take the token. No local mechanism can prevent that: it runs as you, so
anything your browser can obtain it can obtain too.

That is not a gap left open for want of a better idea. An agent that scrapes a page for a
token is not defeating a control by accident — it is doing something specific and deliberate,
which in practice means it was told to. That is a question of what you ask an agent to do,
and it belongs in the instructions you give it rather than in a check the daemon makes.
Reaching for a mechanism here would mean building authentication to enforce a rule about
your own intent, which is the wrong tool and a permanent cost for it.

So the line is drawn where a mechanism still earns its place: approval is not a documented
call, not reachable from the tool surface the agent is handed, and not something that happens
without a page having been rendered. Past that point it stops being the daemon's business.

If you need more than that — an agent you do not control, or a reviewer who must be a
different person — the answer is not a credential in this daemon. It is running it somewhere
the agent cannot reach, with the reviewer's browser on that side of the boundary.

### What the daemon does defend against

The daemon still refuses requests it should not serve. The attack that matters against a
service bound to loopback comes from a web page in an open browser, which reaches the port
on the reviewer's behalf without the reviewer knowing.

- **Host allowlist.** The daemon refuses any request whose `Host` header is neither a
  loopback name nor the host in `public_url`, closing DNS rebinding, where a hostile name
  resolves to `127.0.0.1` and a page in the browser talks to the daemon as same-origin.
- **Cross-site rejection.** Every mutating request requires `Sec-Fetch-Site: same-origin`,
  falling back to an `Origin` check for clients that omit it.
- **No framing.** `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every response.
  Without them the other two checks pass a framed click: the page in the frame is reviewd's
  own, so a click on its approve bar is genuinely same-origin and nothing above can tell it
  from the reviewer's. Sizing the frame puts the button where the attacker wants it.
- **No mutation on GET.** Approving, commenting, and releasing are POST or DELETE, so no
  `<img>` tag reaches them. The gate's own `consumed_at` stamp is why `/api/gate` is a POST.
  Held by a test that reads the database either side of every GET route the app registers,
  rather than by a check in the request path: the routes stay plain, a route added later is
  covered without anyone remembering to list it, and the one permitted write — the
  `last_activity_at` stamp that opening a review makes — is named there as the exception.
- **Deliberate exposure only.** Binding a non-loopback address requires `--bind-public` on
  the command line rather than a configuration key alone. Startup then prints what became
  reachable and to whom.

### Making the UI reachable from a phone

| Requirement | Steps | Address opened |
|---|---|---|
| One machine only | none | `http://127.0.0.1:7777` |
| LAN or an existing VPN | `--bind-public`, `host = "0.0.0.0"`, set `public_url` to the hostname | `http://<hostname>:7777` |
| Anywhere, no ports opened | `tailscale serve --bg 7777`, set `public_url` to the tailnet name | `https://<machine>.<tailnet>.ts.net` |

A tunnel needs no code and no product-specific key. `tailscale serve` reaches the daemon on
loopback like any other local client, and the daemon neither knows nor cares that a tunnel
sits in front. Substituting Cloudflare Tunnel, a WireGuard peer, or `ssh -L` changes nothing
about the daemon.

`public_url` is the one setting a tunnel requires, because the daemon knows what it bound to
and cannot know what address a phone should open. Leaving it null makes every link the agent
surfaces point at `http://127.0.0.1:7777`, which works on the machine and nowhere else. The
full definition is in section 12.

```json
{ "public_url": "https://mac.tailnet-name.ts.net" }
```

---

## 5. Storage

SQLite only. One file, no server, no container, no process to start first.

`kysely` 0.29 over `better-sqlite3` 13. Kysely rather than raw SQL for typed row shapes and
a migration runner; not an ORM, because the schema is nine tables and a query builder
suffices.

Kysely also keeps the dialect a constructor argument rather than a hardcoded driver. Nothing
is written *for* portability: no dialect flags in migrations, no abstraction seams, no second
CI job.

### Conventions

Most of these are SQLite facts rather than choices.

- **Primary keys** are TEXT holding a UUIDv7 (`uuid` package, `v7()`). Sortable by creation
  time, safe to generate client-side, no `AUTOINCREMENT`.
- **Timestamps** are INTEGER epoch milliseconds. SQLite has no date type.
- **Booleans** are INTEGER `0`/`1`. SQLite has no boolean type.
- **Enums** are TEXT with a CHECK constraint. SQLite has no enum type.
- **JSON** is TEXT, serialized in the application layer, never queried into. A field needing
  an index becomes a column.

### Pragmas

WAL mode, `busy_timeout = 5000`, `foreign_keys = ON`, `synchronous = NORMAL`. A single daemon
process holds the only writer, so contention is limited to long-poll readers.

### Event bus

The long-poll behind `reviewd wait` needs notice when a thread changes. An in-process
`EventEmitter` behind `bus.publish(channel, payload)` / `bus.subscribe(channel, handler)`.

The indirection is one file and keeps the long-poll handler out of the web layer's connection
list. It is not a portability seam.

---

## 6. Schema

```
review
  id            TEXT PK        uuidv7
  title         TEXT
  status        TEXT           open | approved
  created_by    TEXT           free-form session label from the agent
  created_at    INTEGER
  last_activity_at INTEGER     any snapshot, message, approval, view, or poll
  updated_at    INTEGER

source                          -- many per review; the multi-directory mechanism
  id            TEXT PK
  review_id     TEXT FK -> review.id  ON DELETE CASCADE
  label         TEXT           display name, e.g. "dotfiles" or "~/.claude"
  root_path     TEXT           absolute path on the client machine
  vcs           TEXT           git | none
  base_ref      TEXT NULL      HEAD, main, a sha, or NULL for a plain file set
  ordinal       INTEGER        tree ordering

snapshot                        -- a revision of the review
  id            TEXT PK
  review_id     TEXT FK
  seq           INTEGER        1, 2, 3...
  fingerprint   TEXT           sha256 over every source's change set at once
  created_at    INTEGER
  UNIQUE (review_id, seq)

file_change
  id            TEXT PK
  snapshot_id   TEXT FK
  source_id     TEXT FK
  path          TEXT           relative to source.root_path
  change_type   TEXT           added | modified | deleted | renamed | binary
  old_path      TEXT NULL
  old_blob_id   TEXT NULL FK -> blob.id
  new_blob_id   TEXT NULL FK -> blob.id
  is_binary     INTEGER
  truncated     INTEGER        content exceeded max_blob_bytes

snapshot_source                 -- a snapshot covers every source; each has its own fingerprint
  snapshot_id   TEXT FK
  source_id     TEXT FK
  fingerprint   TEXT           what the gate matches for this root
  PRIMARY KEY (snapshot_id, source_id)

blob                            -- content-addressed, deduped across snapshots
  id            TEXT PK        sha256 of content
  bytes         BLOB
  size          INTEGER

thread
  id            TEXT PK
  review_id     TEXT FK
  source_id     TEXT FK
  path          TEXT
  side          TEXT           old | new
  line          INTEGER
  anchor_hash   TEXT           sha256 of the anchored line
  context_hash  TEXT           sha256 of 3 lines either side
  state         TEXT           active | resolved | outdated
  origin        TEXT           human | agent    which role opened it
  first_seen_snapshot TEXT FK
  last_seen_snapshot  TEXT FK
  created_at    INTEGER
  updated_at    INTEGER

message
  id            TEXT PK
  thread_id     TEXT FK ON DELETE CASCADE
  seq           INTEGER
  author        TEXT           human | agent
  body          TEXT
  created_at    INTEGER
  submitted_at  INTEGER NULL   null means draft; agent messages submit on write
  UNIQUE (thread_id, seq)

submission                      -- one per batch the reviewer sends
  id            TEXT PK
  review_id     TEXT FK ON DELETE CASCADE
  verdict       TEXT           comment | changes_requested | approved
  message_count INTEGER
  submitted_at  INTEGER

approval
  id            TEXT PK
  review_id     TEXT FK ON DELETE CASCADE
  snapshot_id   TEXT FK
  source_id     TEXT FK        approval is per source root
  root_path     TEXT           denormalized from source, for the gate's index
  fingerprint   TEXT           the source's own fingerprint at approval time
  approved_at   INTEGER
  consumed_at   INTEGER NULL   set the first time a gate call matches it
  INDEX (root_path, fingerprint)
```

`max_blob_bytes` defaults to 2 MB. Larger files store metadata with `truncated = 1` and
render as "file too large to display."

### Thread state, and whose turn it is

A thread is a conversation and carries two independent facts: whether it remains live, and
which role owes the next message. The schema keeps one and derives the other. Collapsing them
into a single column produces values like `open` and `answered` that have no successor when
the human answers the agent's answer, and the repair is an endless series of `re-opened` and
`re-answered` states.

**Stored state** is one of three:

- `active`: the conversation is live.
- `resolved`: closed, either by the reviewer or by the agent after making a change and
  without a reopen.
- `outdated`: the anchored code no longer exists in the current snapshot. Shown in a
  collapsed section.

**Turn is derived, never stored:** `messages[last].author`. A last message from the reviewer
puts the turn on the agent; a last message from the agent puts it on the reviewer.

A thread therefore survives any number of exchanges without a state change. Reviewer
comments, agent replies, reviewer replies again: the thread stayed `active` throughout while
the turn flipped three times. No stored column can drift out of sync with the message list
that holds the truth.

The derivation covers agent-opened threads without a special case. An agent posts a question,
so the turn falls to the reviewer immediately, regardless of `origin`.

The UI surfaces turn rather than state, as "waiting on agent" against "needs your reply,"
counted separately in the review list. `threads_list` accepts `turn: "human" | "agent"` as a
filter, which answers the only question an agent has: what does it owe?

### Submission: comments arrive as a batch

Reviewer messages are drafts until submitted. A draft carries a null `submitted_at`, renders
in the UI, and stays invisible to `threads_list` and to every wake channel. **Submit review**
stamps every draft on the review in one transaction, writes one `submission` row, and emits
one event.

A per-comment stream would reach the agent sooner and produce worse work. The agent would
start editing a file while the reviewer was still three comments from the bottom of it, so
the reviewer would be reading a diff that no longer matched what the agent had, and comment
four would land on code comment two had already moved. Batching keeps the reviewer's mental
model of the change intact until the reviewer chooses to send it.

A submission carries a verdict:

| Verdict | Meaning | Effect |
|---|---|---|
| `comment` | notes, no judgment | drafts become visible, review stays open |
| `changes_requested` | work to do | drafts become visible, review stays open |
| `approved` | the code is fine | drafts become visible, approval rows written per source |

Approving with open threads is a legitimate call, so `approved` requires no thread to be
resolved first.

Drafts sync across devices. They are rows in the database rather than browser state, so every
browser open on that review shows the same tray, and a review started on a phone finishes at
a desk with the comments intact. Two browsers editing at once resolve per message on last
write, which is safe with a single reviewer and cheaper than a locking model that would earn
nothing here.

A thread whose messages are all drafts is itself unsubmitted. `threads_list` omits it and the
agent has no way to learn it exists. Re-anchoring treats it like any other unresolved thread,
so a draft written against snapshot 2 survives into snapshot 3 and moves with its line.

Agent messages carry no draft state. The agent writes one reply at a time and the reviewer
reads it as it lands, which is the direction that benefits from immediacy: the reviewer is
looking at the thread already.

### Lifecycle: approval, then acknowledgement

Approval says the code is fine. Discarding the review data is a separate statement, and only
the agent can make it, because the agent holds work that continues after the reviewer stops
paying attention.

A review therefore survives approval and is destroyed by an explicit acknowledgement:

```
review_release(review_id)
```

The agent saw the approval, committed, and needs none of it. The call drops the review and
every row hanging off it, approvals included, in one transaction. Blobs with no surviving
`file_change` reference go with them.

Because the review outlives approval, `approval` is an ordinary child row that cascades with
its parent.

**The premature-release guard.** A release before the commit would delete the approval and
block the commit that approval had cleared. The gate stamps `consumed_at` on an approval the
first time it matches one, and `review_release` refuses while any approval on the review
remains unconsumed:

> Not released. `~/ghq/.../dotfiles` was approved 4 minutes ago and no commit has used that
> approval yet. Commit first, or pass `force: true` to abandon it.

`force: true` exists because abandoning an approved review is legitimate. It should not be
what happens when tools are called in the wrong order.

### Automatic deletion

Deletion without an acknowledgement exists only to stop leaks. A review whose session died is
a leak rather than a record, and the daemon cannot distinguish a dead session from a reviewer
who stepped away for an evening. The horizon is therefore long and keyed on activity rather
than age:

| Row | Removed when |
|---|---|
| `review` | no activity for `sweep.review_idle_days`, default 14. Activity is any snapshot, message, approval, page view, or poll. |
| `approval` | its review is released, a newer snapshot for that root supersedes it, or the reviewer unapproves |
| `blob` | no `file_change` references it, swept after any review deletion |
| everything else | cascades from `review` |

An unreleased review stays visible while it waits. `review_list` returns it, the review list
page shows its age and an unreleased marker beside a delete button, and every sweep logs what
it removed. Discovering the sweep by noticing an absence is a defect.

---

## 7. Snapshots and re-anchoring

`review_snapshot` publishes a revision. The client walks each source, computes the change set
against `base_ref`, uploads any blob the daemon lacks, and posts the manifest.

The daemon re-anchors every unresolved thread against the new snapshot:

1. **Exact hit:** `path` and `line` still carry `anchor_hash`. Keep the line.
2. **Drifted:** `anchor_hash` appears elsewhere in the same file with a matching
   `context_hash`. Move the thread, record the new line.
3. **Weak hit:** `anchor_hash` matches, `context_hash` does not. Move the thread and flag it
   in the UI as surrounded by changed code.
4. **Gone:** mark `outdated`.

`review_snapshot` returns counts: `{seq: 3, files_changed: 7, threads_moved: 2,
threads_outdated: 1}`.

Content-addressed blobs mean revision N+1 of a 200-file review uploads only what changed.

---

## 8. MCP interface

`reviewd mcp` speaks stdio:

```bash
claude mcp add reviewd -- reviewd mcp
```

### Design rules

- **No diff content crosses the model context.** Tools return counts, ids, URLs, and thread
  text. The shim performs file reading and uploading itself. A 4000-line diff never lands in
  a tool result.
- Tool results stay small enough to call in a loop without consuming context.
- **Every mutating tool returns an openable URL**, surfaced in the session on create, after
  each snapshot, and on waking from a wait. A review the agent never links to is a review
  found by accident.

The URL rule has a failure mode worth naming. The agent reaches the daemon on
`http://127.0.0.1:7777`, so the naive implementation returns `http://127.0.0.1:7777/r/<id>`,
which is dead on any device other than the one holding the code, while nothing else breaks. **Every URL the daemon returns is built from `public_url`** (section 12), never from
the address a request arrived on. The agent never assembles a URL; it passes through what it
receives.

### Tools

| Tool | Input | Returns |
|---|---|---|
| `review_create` | `title`, `sources[]` (`{path, base?, label?}`), `notify?` | `{review_id, url, files_changed, sources[]}` |
| `review_list` | `status?`, `root_path?` | `[{review_id, title, status, url, age, threads_awaiting_agent}]` |
| `review_get` | `review_id` | status, current seq, latest submission and verdict, thread counts by state and by turn, per-source approval state |
| `review_snapshot` | `review_id` | `{seq, files_changed, threads_moved, threads_outdated}` |
| `threads_list` | `review_id`, `state?`, `turn?` | submitted messages only, with source, file, line, state, turn, and whether the thread drifted |
| `thread_create` | `review_id`, `path`, `line`, `body`, `end_line?`, `source_id?`, `side?` | `{thread_id}` |
| `thread_reply` | `thread_id`, `body` | `{thread_id, turn}` |
| `thread_resolve` | `thread_id`, `note?` | `{thread_id, state}` |
| `review_release` | `review_id`, `force?` | `{released: true}`, or a refusal naming the unconsumed approval |

`thread_create` lets the agent open threads on its own output, anchoring judgment calls to
the lines they affect rather than burying them in session prose.

`thread_resolve` from the agent moves a thread to `resolved` and records `origin` on the
closing message. The UI labels agent-closed threads with that origin and reopens them in one click.

Waiting has no tool. A blocking MCP call would hold the agent's turn open for as long as a
human takes to read a diff, which is the wrong shape. Waiting belongs outside the tool
call.

### How approval reaches the session

The reviewer submits from a phone, while the session runs on a machine with no one at the
keyboard. Three channels carry the result back, in decreasing order of reliability.

**1. A background process that exits.** The primary path. `reviewd` blocks on the daemon's
long-poll and exits when something happens:

```bash
reviewd wait --review <id> --timeout 3600
```

An agent harness runs this as a background command and resumes the session on exit, so the
wait costs nothing while it runs and fires on the next submission. Exactly one wake per
submission, never one per comment. The exit code carries the verdict, so the agent knows what
happened before reading any output:

| Code | Meaning |
|---|---|
| `0` | submitted `approved`, every source |
| `2` | submitted `changes_requested` or `comment` |
| `3` | review released or swept |
| `124` | timeout, no submission |

**2. Polling.** `review_get` returns the latest submission and its verdict. A session that was
compacted, restarted, or reattached hours later asks once. It is the only channel that works
with no live process, so the others degrade into it.

**3. The gate.** An agent that used neither of the above and attempted a commit receives an
`allow`. The other two channels affect latency, and this one is why they never affect
correctness.

The reverse direction is section 11: `review_create` fires the webhook and a link reaches the
phone. The round trip is notification out, `reviewd wait` parked, approval in, session
resumed.

---

## 9. Gate integration

The commit hook is shell, because hooks cannot speak MCP.

```
POST /api/gate    {"root": "<abs_path>", "fingerprint": "<sha256>"}
```

A POST because answering stamps `consumed_at`, and a GET that writes is a GET an `<img>`
tag can fire.

Returns:

```json
{
  "decision": "allow" | "deny",
  "reason": "human readable, goes straight into the deny message",
  "review_url": "https://.../r/01J...",
  "warnings": ["2 threads still open on this review"],
  "open_threads": [{"path": "src/a.ts", "line": 42, "excerpt": "..."}]
}
```

**Allow requires one thing: an approval row whose `root_path` matches and whose
`fingerprint` equals the fingerprint the hook computed.** Thread state is reported, never
consulted.

A matching gate call stamps `consumed_at` the first time it fires. The stamp invalidates
nothing, so a commit failing for an unrelated reason passes on the next attempt. Its only job
is letting `review_release` distinguish an approval that was used from one that was not.

Binding an approval to content rather than to a review id is what keeps concurrent reviews
correct. An approval issued by a different review of the same root at the same fingerprint
approved these exact bytes, so honoring it is right. An approval that matches by review id
alone would let a review of one repository authorize a commit in another.

Deny reasons the daemon distinguishes:

1. No review covers this root.
2. A review covers it and carries no approval at any fingerprint.
3. An approval exists at an older fingerprint. The reason names the snapshot it was
   approved at, since a fingerprint alone cannot say which files moved.

Warnings accompany an `allow` and print above the commit without blocking it. Open threads on
an approved review generate one, as does a second review touching the same root, which
indicates another session working in the same place.

`reviewd fingerprint` computes it client-side: stage every change, tracked and untracked,
into a throwaway index, and hash the resulting change set — each file's path, rename origin,
kind of change, and the sha256 of both sides. Staging must not change the answer, so the
command leaves the real index untouched.

Three things follow from hashing the change set rather than the diff text:

- **The daemon derives the same value from the manifest it stored**, and ignores anything the
  client sends. A fingerprint on the wire would be a claim about bytes rather than a fact
  about them, and a client could show the reviewer one change set while the approval covered
  another.
- **Content the reviewer could not be shown is still covered.** Binary and oversize files are
  described rather than uploaded, but both sides are hashed, so replacing one after approval
  moves the fingerprint. The gate says so in a warning, because approved and read came apart
  for those files.
- **Files the ignore rules hide are covered when git is carrying them.** Adding everything
  skips `dist/`, but force-adding a path inside it puts that file in the index and a commit
  takes it, so anything in the real index is pulled into the reading.

One thing the fingerprint cannot cover, because it reads the tree while a commit writes the
index: content staged and then changed on disk. `reviewd gate` refuses outright when the
status of a path differs on both sides, since the committed bytes would match neither what
was reviewed nor what they replaced. A wholly staged tree, a wholly unstaged one, and an
untouched one all pass; staging a partial hunk does not.

The hook detects the commit-producing subcommands — not only the one spelled `commit`, but
also merge, rebase, cherry-pick, revert, am, and the low-level tree and ref plumbing — then
resolves the repository root, shells out to `reviewd gate`, and emits the deny payload. It
fails closed on every error it can reach, including a `jq` that is missing or shadowed, which
it detects by asking a question with a known answer rather than by looking for the binary.

---

## 10. Web UI

Server-rendered pages with a small script for the interactive parts. No client framework
and no bundler.

Reviewing happens on a phone, often on a cell connection, and the whole interaction surface
is a few forms: open a comment box, save a draft, submit, approve. A framework earns nothing
against that and costs a build step, a hydration pass, and bytes over a slow link. The diff
is computed and rendered on the server, so a page arrives readable.

Phase 1 screens:

- `/`: review list grouped by status, each row showing age, source count, and threads by
  turn.
- `/r/<id>`: the review. Every root named first with its file count and approval state,
  files grouped under a heading per root, and a visible control on every line that opens a
  comment box. Threads render inline with full message history and a reply box.
- Split and unified come from one markup: every row carries both halves, and the stylesheet
  decides which to show. A narrow screen is always unified, because two columns of code do
  not fit and an option that cannot be honored is worse than no option. Wider screens default
  to split and offer a toggle, remembered in a cookie so the URL stays shareable without
  carrying one person's display choice.
- A draft tray showing unsent comments with a count, and **Submit review** taking a verdict
  of comment, request changes, or approve. Nothing reaches the agent before that button.
- Per-source approve state. Open threads show a count beside it and never block approval,
  since approving with threads open is a legitimate call. Approving records a fingerprint; a
  later snapshot re-arms the gate.
- A snapshot selector showing changes since the last visit.
- The page follows the review, and does not depend on one mechanism to do it.
  A new revision reaches it over the same event stream the agent's replies use,
  and it re-renders in place: same scroll position, same open replies, same
  half-typed text, with a note saying which revision arrived.

  The stream is the fast path rather than the guarantee. An in-app webview may
  never open it, a sleeping phone drops it, and a proxy can hold it — and the
  page has no way to tell a quiet review from a dead connection. So it also
  asks: every fifteen seconds, and immediately on becoming visible again, which
  is the case a phone actually hits. It compares the revision and the count of
  threads awaiting the reviewer, never the activity stamp, since the refresh is
  itself a read that moves the stamp and would refresh forever.

  This matters more than a stale render. A tab left open shows code that has
  been replaced, and its approve button describes a revision nobody read. The
  page catching up is what makes an approval mean the thing on screen, so it
  cannot rest on a connection staying up.

Mobile is a requirement, since reviewing away from the machine is half the point. Single column below 768px, file tree in a drawer, reply box pinned.

---

## 11. Notifications

Optional, off by default. `review_create` and `review_snapshot` accept `notify: true`.

Phase 1 ships one backend: an HTTP POST to a configured webhook carrying `{title, url,
threads_awaiting_you}`. The `url` is built from `public_url`, so a push opens the review on
any device that can route to the daemon.

[ntfy](https://ntfy.sh) is the documented example: free, self-hostable, with an iOS app that
renders the link as a tappable action. Pushover, Telegram, and Slack are the same POST with a
different body, so the configuration takes a template string.

---

## 12. Config

`~/.config/reviewd/config.json`, mode `0600`.

```json
{
  "host": "127.0.0.1",
  "port": 7777,
  "public_url": null,
  "database": { "path": "/Users/<user>/.local/state/reviewd/reviews.db" },
  "limits": { "max_blob_bytes": 2097152, "max_files_per_snapshot": 2000 },
  "sweep": { "review_idle_days": 14 },
  "notify": { "webhook_url": null, "template": null }
}
```

`public_url` is the base for every link the daemon emits: notification payloads and the
`url` returned to the agent. Null falls back to
`http://<host>:<port>`, which holds until something in front of the daemon changes the
address a phone should use. Behind `tailscale serve` it is the tailnet name; behind a reverse
proxy it is whatever that proxy answers on.

It is the most consequential string in the file. A wrong value makes every link dead while
nothing else appears broken, so it gets guardrails: `reviewd` prints the resolved value at
startup, `reviewd doctor` fetches it and reports whether the daemon answers there, and a
loopback `public_url` paired with a non-loopback `host` warns on every boot.

`database.path` defaults to `$XDG_STATE_HOME/reviewd/reviews.db`, falling back to
`~/.local/state/reviewd/reviews.db`. The directory is created on first run.

`reviewd` reads `~/.config/reviewd/client.json` for `{base_url}`, defaulting to
`http://127.0.0.1:7777`.

---

## 13. Build order

1. **Schema, migrations, tests green.** One CI job against a temp-file database. 2 hours.
2. **Daemon core**: sources, snapshots, blobs, threads, gate API, request hardening. Half a
   day.
3. **The client subcommands**: fingerprint, diff computation, upload, MCP shim, `wait`. Half a day.
4. **Web UI.** The bulk. A day and a half.
5. **Re-anchoring, notifications, sweeps.** Half a day.
6. **Integration**: commit hook and agent skills. 2 hours.

Steps 1 through 3 plus an unstyled diff view constitute a working service.