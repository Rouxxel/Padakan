# Padakan tree bootstrap: clone the repository and check out the task branch. Idempotent.
# Sent as ONE command string over `daytona exec` (which re-joins everything after `--`), so no
# shebang is needed and no heredoc is used. Inputs arrive as exported variables:
#   PADAKAN_TREE, PADAKAN_REPO_URL, PADAKAN_BRANCH, PADAKAN_BASE_SHA
# Auth was seeded before this runs (gh auth setup-git), so an https clone works without a token
# in the URL. Success is the literal last line BOOTSTRAP-OK; anything else is a failed bootstrap.
set -e
: "${PADAKAN_TREE:?}" "${PADAKAN_REPO_URL:?}" "${PADAKAN_BRANCH:?}" "${PADAKAN_BASE_SHA:?}"
T="$HOME/trees/$PADAKAN_TREE"
mkdir -p "$HOME/trees"
if [ ! -d "$T/.git" ]; then git clone -q "$PADAKAN_REPO_URL" "$T"; fi
cd "$T"
git fetch -q origin
if git rev-parse -q --verify "refs/heads/$PADAKAN_BRANCH" >/dev/null; then
  git checkout -q "$PADAKAN_BRANCH"
elif git rev-parse -q --verify "refs/remotes/origin/$PADAKAN_BRANCH" >/dev/null; then
  git checkout -q -b "$PADAKAN_BRANCH" "origin/$PADAKAN_BRANCH"
else
  git checkout -q -b "$PADAKAN_BRANCH" "$PADAKAN_BASE_SHA"
fi
mkdir -p .padakan/evidence
grep -qx '/.padakan/' .git/info/exclude 2>/dev/null || echo '/.padakan/' >> .git/info/exclude
echo "CHECKOUT=$(git rev-parse --abbrev-ref HEAD)@$(git rev-parse --short HEAD)"
echo BOOTSTRAP-OK
