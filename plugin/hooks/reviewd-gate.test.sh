#!/bin/bash
# Tests for reviewd-gate.sh, the PreToolUse hook that refuses an unreviewed
# commit.
#
# The cases here are all one question: which repository does the gate think a
# command commits to. Three commit shapes were invisible to it at one point or
# another, so each shape gets a test rather than the one that happened to bite.
#
# Run: ./reviewd-gate.test.sh   (from anywhere; needs git and jq)

set -u

HOOK=$(cd "$(dirname "$0")" && pwd)/reviewd-gate.sh
[ -x "$HOOK" ] || { echo "no hook at $HOOK"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0
fail=0

# A reviewd the tests control, so nothing here talks to a real daemon. It
# answers deny, which makes "was the gate reached at all" the thing under test.
cat >"$work/reviewd" <<'STUB'
#!/bin/bash
case $1 in
  fingerprint)
    # Empty hash for a clean tree, matching the real one on the property the
    # hook depends on: nothing to review means nothing to gate.
    if [ -z "$(git -C "$2" status --porcelain 2>/dev/null)" ]; then
      printf '' | shasum -a 256 | cut -d' ' -f1
    else
      echo "fingerprint-of-$2"
    fi
    ;;
  gate) echo '{"decision":"deny","reason":"stubbed","reviewUrl":"http://example/r/1"}' ;;
esac
STUB
chmod +x "$work/reviewd"

# Exported, not prefixed onto the jq that builds the payload. A prefix there
# reaches jq and not the hook on the other side of the pipe, which is how this
# suite spent its first day quietly testing against the real daemon.
export REVIEWD_BIN="$work/reviewd"

repo() {
  local path=$work/$1
  mkdir -p "$path"
  git -C "$path" init --quiet
  git -C "$path" config user.email t@example.com
  git -C "$path" config user.name t
  echo "one" >"$path/file.txt"
  git -C "$path" add -A
  git -C "$path" commit --quiet -m initial
  # Dirty, so the gate has something to check rather than passing on an empty
  # fingerprint.
  echo "two" >>"$path/file.txt"
  printf '%s' "$path"
}

# Runs the hook and prints "deny" or "allow".
verdict() {
  local command=$1 cwd=$2 out
  out=$(jq -nc --arg c "$command" --arg d "$cwd" '{tool_input:{command:$c},cwd:$d}' | "$HOOK")

  if printf '%s' "$out" | grep -q '"deny"'; then printf 'deny'; else printf 'allow'; fi
}

check() {
  local name=$1 want=$2 command=$3 cwd=$4 got
  got=$(verdict "$command" "$cwd")

  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n    wanted %s, got %s\n    command: %s\n    cwd: %s\n' \
      "$name" "$want" "$got" "$command" "$cwd"
  fi
}

A=$(repo alpha)
B=$(repo beta)
outside=$work/not-a-repo
mkdir -p "$outside"

echo "reviewd-gate"

# The shape that always worked.
check "commit from inside the repository" deny "git commit -m x" "$A"

# The shape that did not. cwd is not a repository, so the gate used to resolve
# nothing and exit 0.
check "commit behind a cd" deny "cd $A && git commit -m x" "$outside"
check "commit behind a cd and an add" deny "cd $A && git add -A && git commit -m x" "$outside"
check "commit behind a cd from another repository" deny "cd $A && git commit -m x" "$B"

# Same hole, different spelling: -C never moves the shell.
check "commit named with -C" deny "git -C $A commit -m x" "$outside"

# Ambiguous rather than wrong. Guessing here would check one repository's
# approval and commit the other.
check "two repositories in one command" deny "cd $A && git add -A; cd $B && git commit -m x" "$outside"

# Nothing identifiable is a denial now, not a silent pass.
check "commit with no repository anywhere" deny "git commit -m x" "$outside"

# Still quiet about everything that is not a commit. The word turns up in
# messages, in echoed text, and in arguments to other programs, and a gate that
# fires on those teaches the user to reach past it.
check "reading the log" allow "cd $A && git log --oneline" "$outside"
check "showing a file out of history" allow "git -C $A show HEAD:file.txt" "$outside"
check "a word that only looks like one" allow "echo git commit" "$outside"
check "the phrase inside another program's argument" allow "jq -n --arg c 'git commit -m x' '\$c'" "$A"
check "the phrase inside a commit message" deny "cd $A && git commit -m 'fix the git commit gate'" "$outside"
check "a wrapper in front of it" deny "cd $A && rtk git commit -m x" "$outside"
check "an env assignment in front of it" deny "cd $A && GIT_AUTHOR_NAME=t git commit -m x" "$outside"
check "the escape hatch the user asks for by name" allow "cd $A && REVIEWD_SKIP=1 git commit -m x" "$outside"

# A repository that opted out stays opted out.
touch "$(git -C "$A" rev-parse --absolute-git-dir)/reviewd-gate-off"
check "a repository with the gate turned off" allow "cd $A && git commit -m x" "$outside"
rm -f "$(git -C "$A" rev-parse --absolute-git-dir)/reviewd-gate-off"

# A clean tree has nothing to review, so an --amend of a message is not gated.
git -C "$B" checkout --quiet -- .
check "a clean tree" allow "cd $B && git commit --amend -m x" "$outside"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
