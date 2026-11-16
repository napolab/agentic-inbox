#!/usr/bin/env bash
# Run MCP protocol tests against the working tree, and optionally a control ref.
#   bash run.sh                         # all tests in tests/
#   bash run.sh tests/foo.test.mts      # specific files
#   bash run.sh --control origin/main   # also run against origin/main (new tests should FAIL there)
set -uo pipefail
SKILL_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(git rev-parse --show-toplevel)
CONTROL=""
FILES=()
while [ $# -gt 0 ]; do
	case "$1" in
		--control) CONTROL="$2"; shift 2 ;;
		*) FILES+=("$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"); shift ;;
	esac
done
[ ${#FILES[@]} -eq 0 ] && FILES=("$SKILL_DIR"/tests/*.test.mts)

run_against() {
	MCP_TEST_REPO="$1" "$REPO/node_modules/.bin/tsx" --import "$SKILL_DIR/harness/register.mjs" --test "${FILES[@]}"
}

echo "== working tree: $REPO"
run_against "$REPO"
STATUS=$?

if [ -n "$CONTROL" ]; then
	WT="$(mktemp -d)/control"
	git -C "$REPO" worktree add -q --detach "$WT" "$CONTROL" || exit 1
	ln -s "$REPO/node_modules" "$WT/node_modules"
	trap 'git -C "$REPO" worktree remove --force "$WT"' EXIT
	echo
	echo "== control: $CONTROL (tests for the new behavior are EXPECTED to fail here)"
	run_against "$WT"
fi
exit $STATUS
