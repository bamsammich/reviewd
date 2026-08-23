---
name: reviewd
description: "Open a code review the user can read on any device, wait for their verdict, and act on it. Use before committing, whenever the commit gate denies a commit, or when the user invokes /reviewd."
user_invocable: true
---

# reviewd

The commit gate refuses `git commit` until reviewd holds an approval for the
exact bytes in the working tree. This skill is how that approval gets there.

Everything runs through MCP tools. There is no port to remember, no server to
start, and no browser to open on the user's behalf: `reviewd` runs under
launchd and the tools return a link.

## Opening a review

Call `review_create` with every directory the change touches. Several roots in
one review is ordinary rather than a special case, so pass all of them: a
change spanning a repository and a config directory is one review, not two.

```
review_create({
  title: "what this change does, in a few words",
  sources: [{ path: "/abs/path/to/repo" }, { path: "/abs/path/to/other" }],
  notify: true
})
```

Give the user the `url` it returns. Do not build a URL yourself; the one the
daemon returns is the only one that works on a device other than this machine.

## Waiting

Run this as a **background** Bash command so the session resumes when it exits:

```bash
reviewctl wait --review <id> --timeout 3600
```

The exit code carries the verdict, so read it rather than the output:

| Code | Meaning | What to do |
|---|---|---|
| 0 | approved | commit |
| 2 | changes requested, or notes | read the threads, fix, snapshot again |
| 3 | released or swept | the review is gone; open a new one if work remains |
| 124 | timeout | wait again, or ask the user |

Do not poll in a loop and do not call the wait repeatedly in the foreground.
One background command per wait.

## Acting on comments

`threads_list({ reviewId, turn: "agent" })` returns exactly what is owed. A
thread the user has not sent is invisible here by design, so anything it
returns is a comment they deliberately sent.

For each one:

1. Read `path` and `line`, make the change.
2. `thread_reply` saying what you did, in a sentence.
3. `thread_resolve` when the change addresses it.

A question is not a change request. Answer it with `thread_reply` and leave the
thread open for the user to close.

When ambiguity in your own work is worth flagging, `thread_create` opens a
thread on the line it applies to. That is better than a paragraph in chat,
which the user reads on a phone and scrolls past.

## After editing

`review_snapshot({ reviewId })` publishes a revision. Comments re-anchor to the
code they were written against, and the result reports how many moved and how
many went outdated. Then wait again.

## After committing

`review_release({ reviewId })` says you saw the outcome and need none of the
data. It refuses while an approval has not been used by a commit, since
releasing first would delete the very approval that clears it. Commit, then
release.

## When the gate denies a commit

Read the reason it gives.

- **Nobody has looked at it.** Open a review.
- **Not approved.** A review exists and is waiting on the user. Send them the
  link again rather than opening a second review.
- **Approved at an older snapshot.** The tree moved after approval. Call
  `review_snapshot` and wait again.
- **reviewd is not answering.** The daemon is down. Tell the user the command
  in the message; do not work around it.

Never write an approval by hand, and never suggest `REVIEWD_SKIP=1` on your
own. The user asks for that, or the commit waits.
