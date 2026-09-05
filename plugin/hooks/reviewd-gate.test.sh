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

# Built rather than written, so this file does not carry the literal phrase
# that the hook under test looks for.
VERB=$(printf 'commit')

# A reviewd the tests control, so nothing here talks to a real daemon. It
# answers deny, which makes "was the gate reached at all" the thing under test.
#
# `gate` is the only subcommand the hook calls. There used to be a `fingerprint`
# case here too, from when the hook decided for itself that an empty tree had
# nothing to review. That decision moved into `reviewd gate`, which is the only
# side that can also see what the index is holding, and the stub kept answering
# a question nobody asked while its `gate` case denied unconditionally — so the
# one test that expects an allow on a clean tree failed against a correct hook.
cat >"$work/reviewd" <<'STUB'
#!/bin/bash
case $1 in
  # Mirrors the real gate on the one property the hook depends on: a tree with
  # nothing to review is allowed, and everything else denies while echoing the
  # root back, so a test can assert which repository the gate decided this
  # commit was for and not merely that it denied.
  gate)
    # --for carries the verbs the hook saw, echoed back so a test can assert
    # which doors this command was read as opening.
    # Read before the loop below shifts it away.
    root=$2
    verbs=''
    remote=''
    while [ $# -gt 0 ]; do
      case $1 in
        --for) verbs=$2; shift ;;
        # Echoed back so a test can assert which remote the hook read out of
        # the push command.
        --remote) remote=$2; shift ;;
      esac
      shift
    done

    if [ -z "$(git -C "$root" status --porcelain 2>/dev/null)" ]; then
      printf '{"decision":"allow","reason":"%s has no changes against HEAD","warnings":[]}\n' "$root"
    else
      printf '{"decision":"deny","reason":"stubbed for %s verbs=%s remote=%s","reviewUrl":"http://example/r/1"}\n' \
        "$root" "$verbs" "${remote:-none}"
    fi
    ;;
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

# Which remote the hook read out of a push command, from its denial.
check_remote() {
  local name=$1 want=$2 command=$3 cwd=$4 out got
  out=$(jq -nc --arg c "$command" --arg d "$cwd" '{tool_input:{command:$c},cwd:$d}' | "$HOOK")
  got=$(printf '%s' "$out" |
    jq -r '.hookSpecificOutput.permissionDecisionReason // ""' |
    sed -nE 's/.*remote=([^ "]*).*/\1/p')

  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n    wanted %s, got %s\n    command: %s\n' "$name" "$want" "$got" "$command"
  fi
}

# Which repository the gate resolved, read back out of its denial.
check_root() {
  local name=$1 want=$2 command=$3 cwd=$4 out got
  want=$(git -C "$want" rev-parse --show-toplevel)
  out=$(jq -nc --arg c "$command" --arg d "$cwd" '{tool_input:{command:$c},cwd:$d}' | "$HOOK")
  got=$(printf '%s' "$out" |
    jq -r '.hookSpecificOutput.permissionDecisionReason // ""' |
    sed -nE 's/.*stubbed for ([^ ]*).*/\1/p')

  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n    wanted root %s, got %s\n    command: %s\n    cwd: %s\n' \
      "$name" "$want" "${got:-<none>}" "$command" "$cwd"
  fi
}

# Which verbs the hook reported, read back out of the stub's denial.
check_verbs() {
  local name=$1 want=$2 command=$3 cwd=$4 out got
  out=$(jq -nc --arg c "$command" --arg d "$cwd" '{tool_input:{command:$c},cwd:$d}' | "$HOOK")
  got=$(printf '%s' "$out" |
    jq -r '.hookSpecificOutput.permissionDecisionReason // ""' |
    sed -nE 's/.*verbs=([^ ]*).*/\1/p')

  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n    wanted verbs %s, got %s\n    command: %s\n' \
      "$name" "$want" "${got:-<none>}" "$command"
  fi
}

# Asserts the denial says a particular thing, not merely that it denied.
#
# Every case here already denies, so `check` cannot tell the two messages
# apart, and the message is what the reader acts on.
check_says() {
  local name=$1 want=$2 command=$3 cwd=$4 out reason
  out=$(jq -nc --arg c "$command" --arg d "$cwd" '{tool_input:{command:$c},cwd:$d}' | "$HOOK")
  reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""')

  if printf '%s' "$reason" | grep -qF "$(printf '%s' "$want" | sed 's/\\//g')"; then
    pass=$((pass + 1))
    printf '  ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n    wanted the reason to mention %s\n    got: %s\n    command: %s\n' \
      "$name" "$want" "${reason:-<none>}" "$command"
  fi
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

# ---------------------------------------------------------------------------
# The other door.
#
# A push is watched the same way a commit is, and both verbs travel to
# `reviewd gate`, which acts on whichever one the repository holds. This hook
# does not decide that: it reports what it saw.
#
# The strings below are built from $VERB and $PUSH rather than written out, for
# the reason the top of this file gives: a literal one would make this test
# file itself something the hook fires on.
# ---------------------------------------------------------------------------

PUSH=$(printf 'push')

check "a push is watched" deny "git $PUSH" "$A"

# The range a push carries was every commit no remote had seen, which counts a
# fork as publication: a branch pushed to a fork and then to upstream produced
# an empty range the second time, and the gate reported a push carrying
# nothing.
git -C "$A" remote add origin https://example.invalid/origin.git
git -C "$A" remote add fork https://example.invalid/fork.git

check_remote "a named remote is passed on" origin "git push origin main" "$A"
check_remote "the other remote is too" fork "git push fork my-branch" "$A"
check_remote "flags before the remote are stepped over" origin "git push --force-with-lease origin" "$A"

# Left to the client, which reads the branch's own setting the way git does.
check_remote "a bare push names none" none "git push" "$A"

# `git push main` names a branch and no remote. Reading it as one would exclude
# the refs of a remote that does not exist, which is every commit on the branch.
check_remote "a branch is not a remote" none "git push main" "$A"
check_remote "a URL is not a remote" none "git push https://example.invalid/x.git" "$A"

# `npm version patch` records its commit inside npm's own process, so the text
# this hook reads carries no git command at all. Found while cutting 0.1.3 by
# running the release command the README documents.
check "a version bump is watched" deny "npm version patch" "$A"
check "a version bump by minor is watched" deny "npm version minor" "$A"
check "an explicit version is watched" deny "npm version 1.2.3" "$A"
check "pnpm bumps too" deny "pnpm version patch" "$A"
check "yarn bumps too" deny "yarn version major" "$A"
check "a bump behind a wrapper is watched" deny "sh -c 'cd $A && npm version patch'" "$outside"

# Reading rather than writing. Neither of these records a commit, and denying
# one would refuse something for a thing it does not do.
check "bare npm version only prints" allow "npm version" "$A"
check "npm version --json only prints" allow "npm version --json" "$A"
check "a bump told not to commit is left alone" \
  allow "npm version patch --no-git-tag-version" "$A"

# Nothing to do with versions.
check "npm install is not a commit" allow "npm install" "$A"
check "npm run version-check is not a bump" allow "npm run version-check" "$A"
check "a push with a remote and a branch is watched" deny "git $PUSH origin main" "$A"
check "a push named with -C is watched" deny "git -C $A $PUSH" "$work/beta"

check_verbs "a push reports push" "push" "git $PUSH" "$A"
check_verbs "a commit reports commit" "commit" "git $VERB -m x" "$A"

# One Bash command, two doors. Reporting only the first would let the other
# through, since nothing looks at this command again.
check_verbs "a commit and a push report both" "commit,push" \
  "git $VERB -m x && git $PUSH" "$A"

check_verbs "order does not decide what is reported" "commit,push" \
  "git $PUSH && git $VERB -m x" "$A"

# A wrapper hides the push from a plain read of the string, the same way it
# hides a commit.
check_verbs "a push inside a shell wrapper is found" "push" \
  "bash -c 'cd $A && git $PUSH'" "$work/beta"

# Neither door. The gate stays out of the way of every other git command, which
# is most of them.
check "a fetch is not watched" allow "git fetch origin" "$A"
check "a status is not watched" allow "git status" "$A"

# `stash push` is a subcommand of stash, not a push, and the verb sits one word
# further along than the pattern looks.
check "pushing a stash is not a push" allow "git stash $PUSH -m x" "$A"


# The shape that did not. cwd is not a repository, so the gate used to resolve
# nothing and exit 0.
check "commit behind a cd" deny "cd $A && git commit -m x" "$outside"
check "commit behind a cd and an add" deny "cd $A && git add -A && git commit -m x" "$outside"
check "commit behind a cd from another repository" deny "cd $A && git commit -m x" "$B"

# Same hole, different spelling: -C never moves the shell.
check "commit named with -C" deny "git -C $A commit -m x" "$outside"

# Following the shell rather than second-guessing it. An earlier rule collected
# every directory the command mentioned and demanded they agree, which denied
# all four of these — and the first is how anyone commits to a repository other
# than the one their shell is sitting in.
check_root "commit in another repository than the shell" "$A" "cd $A && git commit -m x" "$B"
check_root "commit named with -C from inside another" "$A" "git -C $A commit -m x" "$B"
check_root "the last cd before the commit wins" "$B" "cd $A && git add -A; cd $B && git commit -m x" "$outside"
check_root "-C beats the directory walked to" "$B" "cd $A && git -C $B commit -m x" "$outside"

# A cd after the commit does not move it. The shell would not either.
check_root "a cd that comes too late" "$A" "cd $A && git commit -m x && cd $B" "$outside"

# Relative paths resolve from wherever the walk has reached, not from cwd.
check_root "a relative cd" "$A" "cd $work && cd alpha && git commit -m x" "$outside"

# The plain cases still name the right repository too.
check_root "no cd at all" "$A" "git commit -m x" "$A"

# Nothing identifiable is a denial now, not a silent pass.
check "commit with no repository anywhere" deny "git commit -m x" "$outside"

# A repository named by a variable still denies, and now says why. The verdict
# was never the problem: "no git repository could be identified" reads as a
# typo, so the reader checks a path that is correct and concludes the gate is
# broken. Assert on the sentence, because the sentence is the whole fix.
check_says "a -C naming a variable blames the variable" '\$R' "git -C \"\$R\" commit --no-edit" "$outside"
check_says "a cd to a variable blames the variable" '\$REPO' "cd \"\$REPO\" && git commit -m x" "$outside"
check_says "a bare variable, unquoted" '\$R' "git -C \$R commit -m x" "$outside"
check_says "an unresolvable path with no variable stays generic" 'no git repository' "cd /nope/nowhere && git commit -m x" "$outside"

# A variable the walk never reaches is not the cause, so it is not blamed.
check_says "a variable after the commit is not the cause" 'no git repository' "git commit -m x && cd \"\$R\"" "$outside"

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

# Quoted text is an argument, not a command. Splitting through it denied
# `gh pr create` whenever the body carried both a shell operator and the word,
# which is what anyone documenting this tool writes. The operator is what made
# the old split start a segment at the git text and read it as a real commit,
# so each case here carries one.
check "a body whose text has a paren before the phrase" allow \
  "gh pr create --body 'The gate denies (git -C /nope $VERB -m x) until approved'" "$A"
check "a body quoting a cd and a commit" allow \
  "gh pr create --body 'Run: cd /nope && git $VERB -m x'" "$A"
check "a double-quoted body carrying the phrase" allow \
  "gh issue comment 1 --body \"see: cd /nope && git $VERB\"" "$A"

# Respecting quotes is only safe while a wrapper's argument is still read as a
# command. A quoted argument now survives segmentation whole, so these are the
# cases that would go quiet if the recursion in is_commit were dropped.
check_root "a commit inside sh -c" "$A" "sh -c 'cd $A && git $VERB -m x'" "$outside"
check_root "-C inside sh -c beats the outer cd" "$B" "cd $A && sh -c 'git -C $B $VERB -m x'" "$outside"
check "a commit nested two wrappers deep" deny \
  "sh -c \"sh -c 'git -C $A $VERB -m x'\"" "$outside"

# A single & backgrounds what came before it and starts a new command, which
# the old split did not treat as a boundary at all.
check "a commit after a backgrounded command" deny "cd $A & git -C $A $VERB -m x" "$outside"

# A repository that opted out stays opted out.
touch "$(git -C "$A" rev-parse --absolute-git-dir)/reviewd-gate-off"
check "a repository with the gate turned off" allow "cd $A && git commit -m x" "$outside"
rm -f "$(git -C "$A" rev-parse --absolute-git-dir)/reviewd-gate-off"

# A clean tree has nothing to review, so an --amend of a message is not gated.
git -C "$B" checkout --quiet -- .
check "a clean tree" allow "cd $B && git commit --amend -m x" "$outside"

# The tool going missing used to look exactly like a clean tree: both produced
# an empty fingerprint and an allow. Deleting the binary during a rename was
# enough to open the gate without a word.
REVIEWD_BIN=/nonexistent/reviewd \
  check "a binary that is not there" deny "cd $A && git commit -m x" "$outside"

cat >"$work/broken" <<'BROKEN'
#!/bin/bash
exit 1
BROKEN
chmod +x "$work/broken"
REVIEWD_BIN="$work/broken" \
  check "a binary that fails" deny "cd $A && git commit -m x" "$outside"

# Why it failed used to be discarded with 2>/dev/null, so every failure read as
# a daemon that was down. A binary asking for a route an older daemon does not
# have was reported as silence, and the message sent people to a log with
# nothing in it.
cat >"$work/no-route" <<'NOROUTE'
#!/bin/bash
echo "reviewd: no route for POST /api/gate/scope" >&2
exit 1
NOROUTE
chmod +x "$work/no-route"

reason=$(jq -nc --arg c "cd $A && git commit -m x" --arg d "$outside" \
  '{tool_input:{command:$c},cwd:$d}' | REVIEWD_BIN="$work/no-route" "$HOOK" 2>&1)

if printf '%s' "$reason" | grep -q 'no route for POST /api/gate/scope'; then
  pass=$((pass + 1))
  printf '  ok   a failure says what it was\n'
else
  fail=$((fail + 1))
  printf '  FAIL a failure says what it was\n    got: %s\n' "$reason"
fi

if printf '%s' "$reason" | grep -q 'docker compose up -d --build'; then
  pass=$((pass + 1))
  printf '  ok   a missing route names the upgrade that fixes it\n'
else
  fail=$((fail + 1))
  printf '  FAIL a missing route names the upgrade that fixes it\n    got: %s\n' "$reason"
fi

# A long argument used to cost more per character the further in it went: a
# 32KB --body took 7.7s against this hook's 15s timeout. The bound is loose
# because CI machines vary; it is here to catch a return to quadratic, not to
# measure anything.
big=$(head -c 40000 /dev/zero | tr '\0' 'x')
started=$(date +%s)
verdict "gh pr create --body \"$big\"" "$A" >/dev/null
elapsed=$(($(date +%s) - started))

if [ "$elapsed" -le 5 ]; then
  pass=$((pass + 1))
  printf '  ok   a 40KB argument, in %ss\n' "$elapsed"
else
  fail=$((fail + 1))
  printf '  FAIL a 40KB argument took %ss, which is quadratic again\n' "$elapsed"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
