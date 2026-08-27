#!/bin/bash
# PostToolUse(Bash) check: say so when a commit landed that no approval cleared.
#
# The gate runs before the command and reads the tree as it stands then, which
# leaves two things it cannot see. A command that edits files and commits in one
# line is cleared on bytes it does not record, and a commit reached through a
# wrapper the gate does not recognise is not checked at all. Both are plain
# afterwards, from the commit itself.
#
# Reports and never blocks. The commit already exists; the failure being fixed
# is that it passed unnoticed.

set -u

REVIEWD="${REVIEWD_BIN:-reviewd}"

# Silence is the whole contract here, so every reason to stop is a quiet exit.
# A PostToolUse hook that complains about its own environment would do so after
# every command, and the gate already denies loudly when reviewd is missing.
command -v "$REVIEWD" >/dev/null 2>&1 || [ -x "$REVIEWD" ] || exit 0
[ "$(printf '{"probe":"ok"}' | jq -r '.probe' 2>/dev/null)" = "ok" ] || exit 0

payload=$(cat)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
[ -n "$cwd" ] || cwd=$PWD

# `observe` prints nothing when the commit carries what was approved, so its
# output is the message rather than something to filter.
"$REVIEWD" observe "$cwd" 2>&1 >/dev/null | while IFS= read -r line; do
  [ -n "$line" ] && printf '%s\n' "$line" >&2
done

exit 0
