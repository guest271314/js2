#!/usr/bin/env bash
# poll-pr-mentions.sh — token-free shell loop that watches for new PR comments
# tagging a specific marker (default: @claude). Emits one line per new mention
# so a harness can pick them up — designed to run in a tmux pane, launchd
# service, or similar.
#
# When the tech lead sees a line, they dispatch a developer agent to handle
# the request in the comment (typically: merge main into the PR branch,
# semantically review the diff, push).
#
# Usage:
#   scripts/poll-pr-mentions.sh                # default: @claude, 60s interval
#   MENTION=@reviewer scripts/poll-pr-mentions.sh
#   INTERVAL_SECS=30 scripts/poll-pr-mentions.sh
#
# State (last-seen timestamp) lives in ${STATE_FILE:-~/.cache/poll-pr-mentions-state}.

set -euo pipefail

REPO="${REPO:-loopdive/js2wasm}"
MENTION="${MENTION:-@claude}"
INTERVAL_SECS="${INTERVAL_SECS:-60}"
STATE_FILE="${STATE_FILE:-${HOME}/.cache/poll-pr-mentions-state}"

mkdir -p "$(dirname "$STATE_FILE")"

# Default to looking back one hour on first run so we don't miss boot-time events.
if [ -f "$STATE_FILE" ]; then
  LAST_SEEN=$(cat "$STATE_FILE")
else
  LAST_SEEN=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
              || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)  # BSD fallback (macOS)
fi

# Print one-line startup banner so the human knows the watcher is alive.
echo "[poll-pr-mentions] watching $REPO for '$MENTION' (every ${INTERVAL_SECS}s), since=$LAST_SEEN"

while true; do
  # GitHub's "List repo issue comments" endpoint with since= filter.
  # Lists comments on issues AND PRs (GitHub treats PRs as a kind of issue).
  # --paginate handles >100 results; harmless when empty.
  NEW=$(gh api "repos/$REPO/issues/comments?since=$LAST_SEEN&sort=created&direction=asc&per_page=100" \
          --paginate 2>/dev/null || echo '[]')

  # Iterate matching comments and emit one event-line each.
  echo "$NEW" | jq -c --arg mention "$MENTION" '.[] | select(.body | contains($mention))' 2>/dev/null \
    | while IFS= read -r comment; do
        pr_url=$(echo "$comment" | jq -r '.issue_url')
        pr_num=$(echo "$pr_url" | grep -oE '[0-9]+$' | head -1)
        created=$(echo "$comment" | jq -r '.created_at')
        author=$(echo "$comment" | jq -r '.user.login')
        # First line of the body (skipping HTML markers) — caller can fetch
        # full body via gh api or gh pr view.
        first_line=$(echo "$comment" | jq -r '.body' \
                       | grep -v '^<!--' \
                       | sed -n '/[A-Za-z]/{p;q;}' \
                       | head -c 200)
        echo "[$created] @$author on #$pr_num: $first_line"
      done

  # Advance the watermark to *now* so we don't re-emit the same comments.
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_FILE"
  LAST_SEEN=$(cat "$STATE_FILE")
  sleep "$INTERVAL_SECS"
done
