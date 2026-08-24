# Security

## What reviewd defends

reviewd runs on your machine and holds a copy of the code you are reviewing. It
ships no credentials, no login, and no sessions, because on loopback they would
protect nothing: the file holding a password is readable by the same user that
can read the working tree.

Two boundaries do the work instead.

**Reaching the port is the boundary for reading.** Whatever can open the port can
read the reviews. At every binding reviewd supports, reaching the port already
requires clearing a check stronger than any reviewd could impose — code execution
on the machine, membership of a network, or a tunnel's own authentication.

**A verdict has to come from the review page.** The agent's API can report
`comment` and `changes_requested` and cannot approve. Approving requires a token
minted into the page's own form, signed with a key held in memory. That keeps the
process being gated from clearing itself.

Against a browser, reviewd refuses requests addressed to a name it does not answer
to (closing DNS rebinding), refuses cross-site mutations, refuses to be framed,
and makes no state change on a GET.

## What reviewd does not defend

**An agent running as you, that is trying to.** It can read the review page and
take the token from it. Nothing local can prevent that: it runs with your
permissions, so anything your browser can obtain it can obtain too.

That is a deliberate stopping point rather than an unfixed gap. An agent scraping
a page for a token is doing something specific enough that it was almost certainly
told to, and that belongs in the instructions you give your agent rather than in a
check the daemon makes. The line is drawn where a mechanism still earns its place:
approval is not a documented call, not on the tool surface the agent is handed,
and not possible without a page having been rendered.

If you need more — an agent you do not control, or a reviewer who has to be a
different person — run the daemon somewhere the agent cannot reach, with the
reviewer's browser on that side of the boundary. A credential in this daemon would
not give you that.

**Anything reachable on your network, if you publish it there.** Binding beyond
loopback needs `--bind-public` on the command line, and startup prints what became
reachable. On Linux a Docker published port is DNAT'd ahead of `INPUT`, so `ufw`
and `firewalld` do not filter it.

## Reporting a vulnerability

Open a [security advisory](https://github.com/bamsammich/reviewd/security/advisories/new)
rather than a public issue. A report is most useful with the reviewd version, how
the daemon is bound, and the smallest sequence that shows the behaviour.

Findings in the two areas above are known and documented rather than reportable.
Everything else is worth sending, particularly anything that lets an approval
cover bytes the reviewer was not shown, or lets a page in a browser act on a
review on the reviewer's behalf.
