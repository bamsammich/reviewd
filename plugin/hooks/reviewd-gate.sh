#!/bin/bash
# PreToolUse(Bash) gate: refuse `git commit` until reviewd says the current
# working tree was approved.
#
# The whole decision lives in the daemon. This script resolves which repository
# is being committed, asks, and turns the answer into a hook verdict. It stays
# silent in every case that is not a clearly unreviewed commit.

set -u

REVIEWD="${REVIEWD_BIN:-reviewd}"

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

# Splits a command into the segments a shell would run, in order.
segments() {
  printf '%s' "$1" | sed -E 's/(\&\&|\|\||[;|`()])/\n/g'
}

# Strips leading whitespace, environment assignments, and wrappers, leaving
# whatever the shell would actually execute.
command_head() {
  printf '%s' "$1" | sed -E '
    s/^[[:space:]]+//
    :strip
    s/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+//
    t strip
    s/^(sudo|command|time|nice|env|xargs|rtk)[[:space:]]+//
    t strip
  '
}

# Flags and their arguments may sit between git and the subcommand, which is
# what makes `git -C path commit` a commit and `git -C path show` not.
is_commit_head() {
  printf '%s' "$1" |
    grep -Eq '^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)'
}

is_commit() {
  local segment
  local IFS=$'\n'

  for segment in $(segments "$1"); do
    is_commit_head "$(command_head "$segment")" && return 0
  done

  return 1
}

is_commit "$cmd" || exit 0

# Escape hatch, for the user to ask for by name.
printf '%s' "$cmd" | grep -q 'REVIEWD_SKIP=1' && exit 0

# Which repository is this commit actually for?
#
# The payload's cwd is where the shell starts, not where the commit runs. A
# command can move first, `cd /repo && git commit`, or name a repository
# without moving, `git -C /repo commit`.
#
# An earlier version collected every directory the command mentioned and
# demanded they agree. That denied `cd /other-repo && git commit` run from
# anywhere else, which is an ordinary thing to do and not ambiguous at all:
# the shell runs the cd first. So follow the shell instead of second-guessing
# it. Walk the segments in order, carry the working directory, and stop at the
# commit. Whatever directory it lands in is the answer.
resolve_dir() {
  local from=$1 path=$2

  path=${path#[\"\']}
  path=${path%[\"\']}
  case $path in '~' | '~/'*) path="$HOME${path#\~}" ;; esac

  # Relative paths are relative to where the shell has walked to so far, which
  # is why this cds from `from` rather than resolving the fragment alone.
  (cd "$from" 2>/dev/null && cd "$path" 2>/dev/null && pwd) || printf ''
}

target_dir() {
  local dir=$cwd segment head path
  local IFS=$'\n'

  for segment in $(segments "$cmd"); do
    head=$(command_head "$segment")

    if is_commit_head "$head"; then
      # -C decides the repository for this one invocation without moving the
      # shell, so it wins over wherever the walk had reached.
      path=$(printf '%s' "$head" | sed -nE 's/.*[[:space:]]-C[[:space:]]+([^[:space:]]+).*/\1/p')
      [ -n "$path" ] && resolve_dir "$dir" "$path" || printf '%s' "$dir"
      return
    fi

    case $head in
      cd\ * | pushd\ *)
        path=$(printf '%s' "$head" | sed -E 's/^(cd|pushd)[[:space:]]+//; s/[[:space:]].*//')
        [ -n "$path" ] && dir=$(resolve_dir "$dir" "$path")
        [ -n "$dir" ] || { printf ''; return; }
        ;;
    esac
  done

  printf '%s' "$dir"
}

target=$(target_dir)
root=$(git -C "${target:-/nonexistent}" rev-parse --show-toplevel 2>/dev/null) || root=""

if [ -z "$root" ]; then
  deny "reviewd gate: this is a commit, but no git repository could be identified
for it, so it cannot be checked.

Run it from inside the repository, or name the repository explicitly:
  git -C /path/to/repo commit ...

Override this one commit only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

gitdir=$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null) || exit 0
[ -f "$gitdir/reviewd-gate-off" ] && exit 0

# A tool that is not there is not the same as nothing to review, and both used
# to produce an empty fingerprint and an allow. Deleting the binary during a
# rename was enough to open the gate silently. The daemon-down branch below has
# always denied; this now matches it.
if ! command -v "$REVIEWD" >/dev/null 2>&1 && [ ! -x "$REVIEWD" ]; then
  deny "reviewd gate: \"$REVIEWD\" is not on PATH, so this commit cannot be checked.

Install it, or point REVIEWD_BIN at it.

Override this one commit only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

# Nothing to review means nothing to gate: an --amend that only edits a message
# leaves the tree identical to HEAD.
empty_hash=$(printf '' | shasum -a 256 | cut -d' ' -f1)
if ! fingerprint=$("$REVIEWD" fingerprint "$root" 2>/dev/null) || [ -z "$fingerprint" ]; then
  deny "reviewd gate: could not read the working tree of $root, so this commit
cannot be checked.

Try it by hand to see why:
  $REVIEWD fingerprint \"$root\"

Override this one commit only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi
[ "$fingerprint" = "$empty_hash" ] && exit 0

answer=$("$REVIEWD" gate "$root" --json 2>/dev/null)
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
  reviewd wait --review <id>

Override this one commit only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."

deny "$message"
exit "$status"
