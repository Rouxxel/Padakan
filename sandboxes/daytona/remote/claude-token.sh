#!/usr/bin/env bash
# Picks the Claude token that answers. ~/.claude-env carries both tokens; this
# probes the main one with the real consumer (`claude -p`) and rewrites
# CLAUDE_CODE_OAUTH_TOKEN in ~/.claude-env to whichever answers, so the herdr
# server, an ssh shell and the agent all pick up the working one.
#   claude-token.sh          probe (cached 1 h), rewrite ~/.claude-env, say which
#   claude-token.sh --fresh  probe again
#   claude-token.sh --use main|fallback   pin one until --fresh
set -uo pipefail
ENV="$HOME/.claude-env"; CACHE="$HOME/.cache/claude-token"; TTL=3600
[ -f "$ENV" ] || { echo "no $ENV"; exit 1; }
main="$(sed -n 's/^export CLAUDE_CODE_OAUTH_MAIN_TOKEN=//p' "$ENV" | head -1)"
fb="$(sed -n 's/^export CLAUDE_CODE_OAUTH_FALLBACK_TOKEN=//p' "$ENV" | head -1)"
probe() { out="$(CLAUDE_CODE_OAUTH_TOKEN="$1" IS_SANDBOX=1 timeout 60 claude -p 'Reply with exactly: OK' --max-turns 1 2>&1)" && grep -q OK <<<"$out"; }
if [ "${1:-}" = "--use" ]; then
  case "${2:-}" in main|fallback) which="$2"; mkdir -p "$(dirname "$CACHE")"; ( umask 077; echo "$which" > "$CACHE" ) ;; *) echo "--use main|fallback"; exit 2 ;; esac
elif [ "${1:-}" != "--fresh" ] && [ -f "$CACHE" ] && [ $(( $(date +%s) - $(stat -c %Y "$CACHE") )) -lt "$TTL" ]; then
  which="$(cat "$CACHE")"
else
  which=""
  [ -n "$main" ] && probe "$main" && which=main
  [ -z "$which" ] && [ -n "$fb" ] && probe "$fb" && which=fallback
  [ -n "$which" ] || { echo "claude token: NEITHER answers"; rm -f "$CACHE"; exit 1; }
  mkdir -p "$(dirname "$CACHE")"; ( umask 077; echo "$which" > "$CACHE" )
fi
tok="$main"; [ "$which" = fallback ] && tok="$fb"
[ -n "$tok" ] || { echo "claude token: $which is empty in $ENV"; exit 1; }
# rewrite the active line in place; the two source lines stay untouched
tmp="$(mktemp)"; grep -v '^export CLAUDE_CODE_OAUTH_TOKEN=' "$ENV" > "$tmp"
printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$tok" >> "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$ENV"
echo "claude token: $which"
