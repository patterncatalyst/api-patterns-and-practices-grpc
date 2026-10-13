#!/usr/bin/env bash
# scripts/ch14-demo-breaking.sh
#
# Chapter 14's on-demand, ephemeral demo: watch the REAL `contracts` CI job
# (`buf breaking --against main`) turn red against the real contract, instead
# of only the standalone proof in examples/14-evolution/.
#
# What it does, every time it's run:
#   1. Refuses to run if the working tree is dirty, or if this isn't a git repo.
#   2. Fetches the current `origin/main` and FORCE-RECREATES a local branch
#      named `demo/ch14-breaking` from it — so the branch never drifts from
#      whatever `main` actually looks like today, no matter how long it's
#      been since the last run.
#   3. Seeds ONE breaking change into the REAL contract: renumbers
#      `shipping.type.v1.Cargo cargo` from field 3 to field 7 in
#      contracts/proto/shipping/routing/v1/routing.proto — the exact edit
#      Chapter 14's "On the wire" box shows the output of.
#   4. Commits that change on `demo/ch14-breaking` ONLY, and force-pushes the
#      branch (with --force-with-lease) so GitHub Actions runs the real
#      `contracts` workflow against it. The `buf breaking` step is expected,
#      and intended, to fail — that is the entire point of running this.
#   5. Switches back to the branch you started on, leaving your working tree
#      exactly as it was before step 2.
#
# `demo/ch14-breaking` is meant to be red: it exists to be watched failing
# in CI, never to be fixed, reviewed, or merged — this script never checks
# out, commits to, merges into, or pushes `main` itself, only the disposable
# sibling branch. Delete it with:
#
#   scripts/ch14-demo-breaking.sh --cleanup
#
# which removes both the local and the remote copy. Safe to run from a clean
# checkout; safe to re-run as many times as you like; safe to forget about
# and clean up later, since nothing here ever touches `main`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="demo/ch14-breaking"
REMOTE="origin"
PROTO_FILE="contracts/proto/shipping/routing/v1/routing.proto"
OLD_LINE="  repeated shipping.type.v1.Cargo cargo = 3;"
NEW_LINE="  repeated shipping.type.v1.Cargo cargo = 7;"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--cleanup]

  (no flags)   Fork demo/ch14-breaking off the current main, seed a
               breaking field renumber in the real routing.proto, and push
               it so CI's "contracts" workflow runs buf breaking against it
               and fails as expected. Never merge this branch; delete it
               with --cleanup when you're done.

  --cleanup    Delete demo/ch14-breaking locally and on $REMOTE.
EOF
}

require_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ch14-demo-breaking: FAIL — not inside a git repository" >&2
    exit 1
  fi
}

require_clean_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "ch14-demo-breaking: FAIL — working tree is not clean." >&2
    echo "Commit, stash, or discard your changes first — this script switches" >&2
    echo "branches and will not run against uncommitted work." >&2
    exit 1
  fi
}

current_branch() {
  git rev-parse --abbrev-ref HEAD
}

do_cleanup() {
  require_git_repo
  require_clean_tree

  local start_branch
  start_branch="$(current_branch)"

  if [[ "$start_branch" == "$BRANCH" ]]; then
    echo "ch14-demo-breaking: currently on $BRANCH — switching to main before deleting it" >&2
    if git show-ref --verify --quiet "refs/heads/main"; then
      git checkout main
    else
      git fetch "$REMOTE" main --quiet
      git checkout -B main "$REMOTE/main"
    fi
  fi

  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git branch -D "$BRANCH"
    echo "ch14-demo-breaking: deleted local branch $BRANCH"
  else
    echo "ch14-demo-breaking: no local branch $BRANCH to delete"
  fi

  if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
    git push "$REMOTE" --delete "$BRANCH"
    echo "ch14-demo-breaking: deleted remote branch $REMOTE/$BRANCH"
  else
    echo "ch14-demo-breaking: no remote branch $REMOTE/$BRANCH to delete"
  fi

  echo "ch14-demo-breaking: cleanup complete — demo/ch14-breaking no longer exists locally or on $REMOTE."
}

do_run() {
  require_git_repo
  require_clean_tree

  local start_branch
  start_branch="$(current_branch)"

  echo "ch14-demo-breaking: fetching $REMOTE/main ..." >&2
  git fetch "$REMOTE" main --quiet

  # Force-recreate the demo branch from whatever main looks like RIGHT NOW,
  # so it never rots relative to main — never built from a stale local ref.
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git branch -D "$BRANCH"
  fi
  git checkout -b "$BRANCH" "$REMOTE/main"

  if [[ ! -f "$PROTO_FILE" ]]; then
    echo "ch14-demo-breaking: FAIL — $PROTO_FILE not found on $REMOTE/main" >&2
    git checkout "$start_branch"
    git branch -D "$BRANCH"
    exit 1
  fi

  if ! grep -qF "$OLD_LINE" "$PROTO_FILE"; then
    echo "ch14-demo-breaking: FAIL — expected line not found in $PROTO_FILE:" >&2
    echo "  $OLD_LINE" >&2
    echo "The real routing.proto has moved on since this script was written —" >&2
    echo "update OLD_LINE/NEW_LINE here to match its current shape." >&2
    git checkout "$start_branch"
    git branch -D "$BRANCH"
    exit 1
  fi

  # Portable in-place sed (GNU and BSD/macOS sed both accept this form with
  # an explicit, empty backup suffix argument).
  sed -i.bak "s|${OLD_LINE}|${NEW_LINE}|" "$PROTO_FILE"
  rm -f "${PROTO_FILE}.bak"

  git add "$PROTO_FILE"
  git commit --quiet -m "demo(ch14): seed a breaking field renumber (meant to fail, do not merge)

cargo (field 3) renumbered to field 7 in GetQuoteRequest. This is a drift
test for Chapter 14 — buf breaking --against main is expected to fail on
this branch. Never merge demo/ch14-breaking into main; delete it instead
with scripts/ch14-demo-breaking.sh --cleanup."

  echo "ch14-demo-breaking: pushing $BRANCH to $REMOTE ..." >&2
  git push --force-with-lease -u "$REMOTE" "$BRANCH"

  git checkout "$start_branch"

  echo
  echo "PASS — demo/ch14-breaking pushed. Open the repository's Actions tab" \
       "and watch the 'contracts' workflow run for this branch: the 'buf" \
       "breaking (vs main)' step is expected to fail. This branch exists" \
       "only to be watched failing and must never be merged — run" \
       "'scripts/ch14-demo-breaking.sh --cleanup' when you're done with it."
}

case "${1:-}" in
  --cleanup)
    do_cleanup
    ;;
  -h | --help)
    usage
    ;;
  "")
    do_run
    ;;
  *)
    echo "ch14-demo-breaking: unknown argument: $1" >&2
    usage >&2
    exit 1
    ;;
esac
