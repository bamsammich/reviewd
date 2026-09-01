#!/bin/bash
# PreToolUse(Bash) gate: refuse `git commit` until reviewd says the current
# working tree was approved.
#
# The whole decision lives in the daemon. This script resolves which repository
# is being committed, asks, and turns the answer into a hook verdict. It stays
# silent in every case that is not a clearly unreviewed commit.

set -u

REVIEWD="${REVIEWD_BIN:-reviewd}"

# REVIEWD_BIN decides both the fingerprint and the verdict, so a redirected one
# is the whole gate. It stays, because a checkout that is not on PATH is a real
# situation, but it announces itself: silence is what makes a redirect useful to
# anything other than its documented purpose.
if [ -n "${REVIEWD_BIN:-}" ]; then
  printf 'reviewd gate: using REVIEWD_BIN=%s instead of the installed reviewd.\n' \
    "$REVIEWD_BIN" >&2
fi

# deny() uses no external command, not even jq.
#
# It has to work in exactly the situations where the rest of the script cannot:
# jq missing, jq shadowed, PATH broken. A denial that depends on the tools whose
# absence it is reporting is a denial that turns into silence, and silence here
# reads as permission. Bash's own substitution covers the three characters JSON
# needs escaped in this string.
deny() {
  local reason=$1
  reason=${reason//\\/\\\\}
  reason=${reason//\"/\\\"}
  reason=${reason//$'\n'/\\n}

  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

# jq parses the payload, so a jq that does not work leaves `cmd` empty, every
# commit reads as "not a commit", and the gate waves it through in silence.
#
# Tested by use rather than by `command -v`, because the failure that matters is
# not only a missing jq: one earlier on PATH that exits 0 and prints nothing
# passes an existence check and still answers nothing. Asking it a question with
# a known answer covers both.
if [ "$(printf '{"probe":"ok"}' | jq -r '.probe' 2>/dev/null)" != "ok" ]; then
  deny "reviewd gate: jq is missing or not working, so this command cannot be checked.

Check it with:
  printf '{\"probe\":\"ok\"}' | jq -r .probe

Install it (brew install jq) or fix what is shadowing it, then try again.

This message says "command" where the rest say "commit" or "push": jq is what
reads the command, so nothing here knows yet which one it was.

Override this one command only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
[ -n "$cmd" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD

# Is this actually a commit?
#
# Matching the word anywhere caught `echo git commit`, a jq argument carrying
# the phrase, and any message mentioning it. A gate that fires on those trains
# the user to reach for the escape hatch, which costs more than the commits it
# would have caught. So look for git in command position: at the start of a
# segment the shell would run, past any environment assignments or wrappers in
# front of it, with commit as the subcommand rather than a word further along.
#
# Quoted text is data. Splitting through it denied `gh pr create --body` for
# naming a repository it never touched.
#
# Safe only with the recursion in runs_git: a wrapper's argument now survives
# whole, so it is re-read rather than tested as a single command.

# command_head strips leading whitespace, so without this every segment after
# the first differs from its head and reads as a wrapper.
trim() {
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

# Splits a command into the segments a shell would run, in order.
#
# awk because quote state has to carry across the string, which a regex cannot
# do, and because `${s:i:1}` is quadratic: a 32KB `--body` cost 7.7s that way,
# against this hook's 15s timeout.
segments() {
  printf '%s' "$1" | awk '
    BEGIN { RS = "\036"; quote = ""; out = "" }
    {
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)

        if (quote != "") {
          out = out c
          # Backslash escapes inside double quotes, and nowhere else the shell
          # would honor it.
          if (c == "\\" && quote == "\"") { out = out substr($0, ++i, 1); continue }
          if (c == quote) quote = ""
          continue
        }

        if (c == "\"" || c == "\047") { quote = c; out = out c; continue }
        if (c == "\\") { out = out c substr($0, ++i, 1); continue }

        # `&&` and `||` split, and so does a single `|`. A lone `&`
        # backgrounds what came before, which is still a command that ran.
        if (c == "&" || c == "|") {
          out = out "\n"
          if (substr($0, i + 1, 1) == c) i++
          continue
        }

        if (c == ";" || c == "`" || c == "(" || c == ")") { out = out "\n"; continue }

        out = out c
      }
    }
    END { printf "%s", out }
  '
}

# Strips leading whitespace, environment assignments, and wrappers, leaving
# whatever the shell would actually execute.
#
# The shell wrappers matter as much as sudo does. `bash -c "git commit"` runs a
# commit, and stripping only sudo and env left the quoted command unexamined,
# which made it the shortest way past this script. The quotes come off with the
# wrapper so the command inside is read on its own terms.
command_head() {
  printf '%s' "$1" | sed -E '
    s/^[[:space:]]+//
    :strip
    s/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+//
    t strip
    # Wrappers taking an argument of their own go first: stripping the bare
    # word would leave the argument sitting where the command should be, and
    # `10 git commit` matches nothing.
    s/^timeout[[:space:]]+(-[^[:space:]]+[[:space:]]+)*[0-9]+[smhd]?[[:space:]]+//
    t strip
    s/^nice[[:space:]]+-n[[:space:]]+-?[0-9]+[[:space:]]+//
    t strip
    s/^(sudo|command|time|nice|env|xargs|rtk|exec|eval|nohup|stdbuf)[[:space:]]+//
    t strip
    s/^(ba|z|k|da)?sh[[:space:]]+-[a-z]*c[[:space:]]+//
    t strip
    s/^"//; s/"$//
    s/^'\''//; s/'\''$//
    t strip
  '
}

# Anything that writes a commit, not only the one spelled `commit`.
#
# A gate that watched `commit` alone watched one door in a room with several.
# `rebase --continue`, `merge`, `cherry-pick`, `revert`, and `am` all produce
# commits from content this script never measured, and `commit-tree` with
# `update-ref` builds one out of plumbing. They are listed rather than the
# regex being loosened, so a reader can see exactly which doors are covered.
#
# `apply` was in this list and is not a door: it writes the working tree and
# stops there, so the commit that follows still has to pass the gate with the
# bytes it wrote. Gating it denied an ordinary way to move a patch around and
# bought nothing, which is the trade the paragraph above refuses to make.
COMMIT_VERBS='commit|merge|rebase|cherry-pick|revert|am|commit-tree|update-ref'

# The other door, watched only where a repository asks for it.
#
# A push is the point where code leaves the machine, which is what makes it
# worth gating instead of every commit on the way there. Whether this
# repository holds commits or pushes is the daemon's answer, not this script's:
# both verbs are reported and `reviewd gate` acts on whichever one applies.
PUSH_VERBS='push'

# Both sets, for the walk that works out which repository a command acts on.
# That walk cares only that a git command is being gated, since a push carries
# `-C` exactly the way a commit does.
GATED_VERBS="${COMMIT_VERBS}|${PUSH_VERBS}"

# Flags and their arguments may sit between git and the subcommand, which is
# what makes `git -C path commit` a commit and `git -C path show` not.
#
# Quoting inside the subcommand is stripped too: `git "commit"` and `git com""mit`
# are the same command to the shell and were two different strings to the regex.
head_runs() {
  local head
  head=$(printf '%s' "$1" | tr -d '"'"'"'')

  printf '%s' "$head" |
    grep -Eq "^git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+(${2})([[:space:]]|$)"
}

# Recursive because segments() keeps a quoted argument whole. command_head
# strips the wrapper off `sh -c 'cd /repo && git commit'`, leaving a command
# line with its own operators, so it goes back through the same reading.
#
# Only a head command_head changed is worth recursing on; anything else is the
# same string and would not terminate.
runs_git() {
  local segment head depth=${3:-0}
  local IFS=$'\n'

  [ "$depth" -gt 8 ] && return 1

  for segment in $(segments "$1"); do
    segment=$(trim "$segment")
    head=$(command_head "$segment")
    head_runs "$head" "$2" && return 0
    [ "$head" != "$segment" ] && runs_git "$head" "$2" $((depth + 1)) && return 0
  done

  return 1
}

# Every gated verb this command carries, not the first one found.
#
# `git commit -m x && git push` is one command and reaches this hook as one
# string. Reporting only the commit would let the push through on a repository
# that gates pushes, since nothing else looks at this command again.
verbs=''
runs_git "$cmd" "$COMMIT_VERBS" && verbs='commit'
runs_git "$cmd" "$PUSH_VERBS" && verbs="${verbs:+$verbs,}push"

[ -n "$verbs" ] || exit 0

# What to call this in a message a person reads. A denial that says "commit"
# about a push describes something that did not happen, which is the fastest
# way to teach someone the gate does not understand what they are doing.
case $verbs in
  commit) noun='commit' ;;
  push) noun='push' ;;
  *) noun='commit and push' ;;
esac

# Escape hatch, for the user to ask for by name.
#
# Matched only where the shell would read it as an assignment: at the front of
# a segment, before the command. Searching the whole string meant a commit
# message mentioning the variable turned the gate off, and prose about this
# very feature is a plausible thing to write in one.
has_skip_prefix() {
  local segment
  local IFS=$'\n'

  for segment in $(segments "$1"); do
    printf '%s' "$segment" |
      sed -E 's/^[[:space:]]+//' |
      grep -Eq '^(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|sudo|command|env)[[:space:]]+)*REVIEWD_SKIP=1([[:space:]]|$)' &&
      return 0
  done

  return 1
}

has_skip_prefix "$cmd" && {
  printf 'reviewd gate: skipped by REVIEWD_SKIP=1.\n' >&2
  exit 0
}

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

# Prints the directory this line's first commit runs in, failing when it holds
# no commit. Recursive for runs_git's reason: a wrapper's argument is walked
# rather than read as one command, so an inner -C still decides the repository.
#
# A `cd` inside a wrapper does not carry out to the caller, since a subshell
# that moves does not move the shell that started it.
walk_to_commit() {
  local line=$1 dir=$2 depth=${3:-0} segment head path inner
  local IFS=$'\n'

  [ "$depth" -gt 8 ] && return 1

  for segment in $(segments "$line"); do
    segment=$(trim "$segment")
    head=$(command_head "$segment")

    if head_runs "$head" "$GATED_VERBS"; then
      # -C decides the repository for this one invocation without moving the
      # shell, so it wins over wherever the walk had reached.
      path=$(printf '%s' "$head" | sed -nE 's/.*[[:space:]]-C[[:space:]]+([^[:space:]]+).*/\1/p')
      [ -n "$path" ] && resolve_dir "$dir" "$path" || printf '%s' "$dir"
      return 0
    fi

    if [ "$head" != "$segment" ]; then
      inner=$(walk_to_commit "$head" "$dir" $((depth + 1))) && {
        printf '%s' "$inner"
        return 0
      }
      continue
    fi

    case $head in
      cd\ * | pushd\ *)
        path=$(printf '%s' "$head" | sed -E 's/^(cd|pushd)[[:space:]]+//; s/[[:space:]].*//')
        [ -n "$path" ] && dir=$(resolve_dir "$dir" "$path")
        [ -n "$dir" ] || { printf ''; return 0; }
        ;;
    esac
  done

  return 1
}

target_dir() {
  walk_to_commit "$cmd" "$cwd" || printf '%s' "$cwd"
}

# The first directory the command names that carries a `$`, or nothing.
#
# The hook reads the command before the shell expands it, so `git -C "$R"`
# arrives as four literal characters and no directory matches. That is the
# right verdict and the wrong sentence: "no git repository could be identified"
# describes a typo, so a reader checks the path, finds it correct, and reaches
# for REVIEWD_SKIP=1 to get past what looks like a broken gate. Naming the
# variable turns it into an instruction instead.
#
# Only consulted once resolution has already failed, so it cannot change which
# repository the gate picks.
unexpanded_path() {
  local segment head path
  local IFS=$'\n'

  for segment in $(segments "$cmd"); do
    head=$(command_head "$segment")
    path=''

    if head_runs "$head" "$GATED_VERBS"; then
      path=$(printf '%s' "$head" | sed -nE 's/.*[[:space:]]-C[[:space:]]+([^[:space:]]+).*/\1/p')
    else
      case $head in
        cd\ * | pushd\ *)
          path=$(printf '%s' "$head" | sed -E 's/^(cd|pushd)[[:space:]]+//; s/[[:space:]].*//')
          ;;
      esac
    fi

    case $path in
      *'$'*)
        path=${path#[\"\']}
        path=${path%[\"\']}
        printf '%s' "$path"
        return
        ;;
    esac

    head_runs "$head" "$GATED_VERBS" && return
  done
}

target=$(target_dir)
root=$(git -C "${target:-/nonexistent}" rev-parse --show-toplevel 2>/dev/null) || root=""

if [ -z "$root" ]; then
  variable=$(unexpanded_path)

  if [ -n "$variable" ]; then
    deny "reviewd gate: this is a $noun, but the repository is named with a shell
variable this hook cannot expand: $variable

The hook reads the command as text, before the shell runs it, so $variable is
still literal here and no directory matches it. The gate is working; it just
cannot see where you meant.

Write the path out, either way round:
  git -C /path/to/repo commit ...
  cd /path/to/repo && git commit ...

Override this one $noun only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
  fi

  deny "reviewd gate: this is a $noun, but no git repository could be identified
for it, so it cannot be checked.

Run it from inside the repository, or name the repository explicitly:
  git -C /path/to/repo commit ...

Override this one $noun only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

# Not knowing where the git directory is means not knowing whether the gate is
# off for this repository, and that is a reason to stop rather than to continue.
if ! gitdir=$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null); then
  deny "reviewd gate: $root has no git directory this hook can read, so the $noun
cannot be checked.

Override this one $noun only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

# The off switch stays, and stops being quiet.
#
# Anything that can write this file can also write the working tree, so it is
# not a boundary and treating it as one would be a lie. What it can be is
# visible: a gate that is off says so on every commit, so a transcript shows
# when it was turned off and by whom, rather than showing nothing at all.
if [ -f "$gitdir/reviewd-gate-off" ]; then
  printf 'reviewd gate: OFF for %s (%s exists). Nothing here is being checked.\n' \
    "$root" "$gitdir/reviewd-gate-off" >&2
  exit 0
fi

# A tool that is not there is not the same as nothing to review, and both used
# to produce an empty fingerprint and an allow. Deleting the binary during a
# rename was enough to open the gate silently. The daemon-down branch below has
# always denied; this now matches it.
if ! command -v "$REVIEWD" >/dev/null 2>&1 && [ ! -x "$REVIEWD" ]; then
  deny "reviewd gate: \"$REVIEWD\" is not on PATH, so this $noun cannot be checked.

Install it, or point REVIEWD_BIN at it.

Override this one $noun only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."
fi

# An empty tree used to short-circuit here, before `reviewd gate` ran. That
# made "looks like nothing changed" the fastest way through, and staging a
# change and restoring the file produces exactly that appearance. Deciding it
# is `reviewd gate`'s job now, because it is the only side that also checks
# what the index is holding.
answer=$("$REVIEWD" gate "$root" --json --for "$verbs" 2>/dev/null)

if [ -z "$answer" ]; then
  # A daemon that is down denies rather than waves everything through, because
  # the point of the gate is that unreviewed code does not get committed. The
  # message carries both ways out.
  deny "reviewd is not answering, so this $noun cannot be checked.

It normally starts on first use, so something stopped it from coming up. The
log says what:
  ~/.local/state/reviewd/reviewd.log

Start it by hand with \`reviewd serve\`, or restart whatever runs it for you: a
launchd agent (launchctl kickstart -k gui/\$(id -u)/com.bamsammich.reviewd), a
systemd unit, or the container. Then commit again.

To turn the gate off for this repository only:
  touch \"$gitdir/reviewd-gate-off\"

Override this one $noun only if the user explicitly asks: prefix the command
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

Override this one $noun only if the user explicitly asks: prefix the command
with REVIEWD_SKIP=1."

deny "$message"
