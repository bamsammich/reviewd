#!/bin/bash
# PreToolUse(Bash) gate: refuse `git commit` until reviewd says the current
# working tree was approved.
#
# The whole decision lives in the daemon. This script resolves which repository
# is being committed, asks, and turns the answer into a hook verdict. It stays
# silent in every case that is not a clearly unreviewed commit.

set -u

REVIEWCTL="${REVIEWD_CTL:-reviewctl}"

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
[ -n "$cmd" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD

deny() {
  jq -nc --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Is this actually a commit?
#
# Matching the word anywhere caught `echo git commit`, a jq argument carrying
# the phrase, and any message mentioning it. A gate that fires on those trains
# the user to reach for the escape hatch, which costs more than the commits it
# would have caught. So look for git in command position: at the start of a
# segment the shell would run, past any environment assignments or wrappers in
# front of it, with commit as the subcommand rather than a word further along.
#
# Quoting is the known limit: this splits on shell operators without knowing
# which are inside quotes, so `printf 'git commit'` still reads as one. That
# errs toward denying a command that was not a commit, which is the direction
# to be wrong in, and the alternative of blanking quoted text would let
# `sh -c '... git commit'` through unchecked.
is_commit() {
  local segment head
  local IFS=$'\n'

  for segment in $(printf '%s' "$1" | sed -E 's/(\&\&|\|\||[;|`()])/\n/g'); do
    head=$(printf '%s' "$segment" | sed -E '
      s/^[[:space:]]+//
      :strip
      s/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+//
      t strip
      s/^(sudo|command|time|nice|env|xargs|rtk)[[:space:]]+//
      t strip
    ')

    # Flags and their arguments may sit between git and the subcommand, which
    # is what makes `git -C path commit` a commit and `git -C path show` not.
    printf '%s' "$head" |
      grep -Eq '^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)' &&
      return 0
  done

  return 1
}

is_commit "$cmd" || exit 0

# Escape hatch, for the user to ask for by name.
printf '%s' "$cmd" | grep -q 'REVIEWD_SKIP=1' && exit 0

# Which repository is this commit actually for?
#
# The payload's cwd is where the shell starts, not where the commit runs. A
# command can move first, `cd /repo && git commit`, or never move at all,
# `git -C /repo commit`. Neither was visible here: the gate resolved cwd alone,
# found no repository, and exited 0. That waved every such commit straight
# through, and where cwd happened to be a different repository it checked the
# wrong one's approval.
#
# So collect every directory this command could mean, resolve each to a
# repository root, and require them to agree. No answer, or more than one,
# denies rather than guesses.
candidates=$(
  printf '%s\n' "$cwd"
  printf '%s' "$cmd" |
    grep -oE '(^|[;&|(])[[:space:]]*(cd|pushd)[[:space:]]+[^;&|)[:space:]]+' |
    sed -E 's/.*(cd|pushd)[[:space:]]+//'
  printf '%s' "$cmd" |
    grep -oE 'git[[:space:]]+-C[[:space:]]+[^;&|)[:space:]]+' |
    sed -E 's/.*-C[[:space:]]+//'
)

roots=""
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue

  candidate=${candidate#[\"\']}
  candidate=${candidate%[\"\']}
  case $candidate in '~' | '~/'*) candidate="$HOME${candidate#\~}" ;; esac

  # Relative paths are relative to where the shell started, which is why this
  # walks from cwd rather than calling realpath on the fragment alone.
  resolved=$(cd "$cwd" 2>/dev/null && cd "$candidate" 2>/dev/null && pwd) || continue
  [ -n "$resolved" ] || continue

  top=$(git -C "$resolved" rev-parse --show-toplevel 2>/dev/null) || continue
  [ -n "$top" ] && roots=$(printf '%s\n%s' "$roots" "$top")
done <<CANDIDATES
$candidates
CANDIDATES

roots=$(printf '%s\n' "$roots" | grep . | sort -u)
count=$(printf '%s\n' "$roots" | grep -c .)

if [ "$count" -eq 0 ]; then
  deny "reviewd gate: this is a commit, but no git repository could be identified
for it, so it cannot be checked.

Run it from inside the repository, or name the repository explicitly:
  git -C /path/to/repo commit ...

Override this one commit only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

if [ "$count" -gt 1 ]; then
  deny "reviewd gate: this command reaches more than one repository, so which one
is being committed is ambiguous:

$(printf '%s\n' "$roots" | sed 's/^/  /')

Commit them one command at a time.

Override this one commit only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

root=$roots

gitdir=$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null) || exit 0
[ -f "$gitdir/reviewd-gate-off" ] && exit 0

# Nothing to review means nothing to gate: an --amend that only edits a message
# leaves the tree identical to HEAD.
empty_hash=$(printf '' | shasum -a 256 | cut -d' ' -f1)
fingerprint=$("$REVIEWCTL" fingerprint "$root" 2>/dev/null) || fingerprint=""
[ -z "$fingerprint" ] && exit 0
[ "$fingerprint" = "$empty_hash" ] && exit 0

answer=$("$REVIEWCTL" gate "$root" --json 2>/dev/null)
status=$?

if [ -z "$answer" ]; then
  # A daemon that is down denies rather than waves everything through, because
  # the point of the gate is that unreviewed code does not get committed. The
  # message carries both ways out.
  deny "reviewd is not answering, so this commit cannot be checked.

Start it:
  launchctl kickstart -k gui/\$(id -u)/com.bamsammich.reviewd

Then commit again. To turn the gate off for this repository only:
  touch \"$gitdir/reviewd-gate-off\"

Override this one commit only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

decision=$(printf '%s' "$answer" | jq -r '.decision // "deny"')
[ "$decision" = "allow" ] && {
  # Warnings ride along with an allow and are worth printing, but they never
  # block: approving with threads open is the reviewer's call.
  printf '%s' "$answer" | jq -r '.warnings[]? | "reviewd warning: \(.)"' >&2
  exit 0
}

reason=$(printf '%s' "$answer" | jq -r '.reason // "not approved"')
url=$(printf '%s' "$answer" | jq -r '.reviewUrl // empty')
threads=$(printf '%s' "$answer" | jq -r '.openThreads[]? | "  \(.path):\(.line) — \(.excerpt)"')

message="reviewd gate: $reason"
[ -n "$url" ] && message="$message

Review: $url"
[ -n "$threads" ] && message="$message

Open threads:
$threads"

message="$message

Open a review with the reviewd MCP tools (review_create, then review_snapshot
after edits), and wait for a verdict with:
  reviewctl wait --review <id>

Override this one commit only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."

deny "$message"
exit "$status"
