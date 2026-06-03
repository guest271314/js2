#!/usr/bin/env bash
# TeammateIdle retry hook (#rate-limit resilience).
#
# Re-engages a teammate that went idle WHILE it still owns an in-progress task
# AND whose last transcript message was a server-side rate-limit error.
# If the agent went idle for any other reason (finished, waiting for input,
# shutdown_request, etc.) we do NOT nudge — we allow idle.
#
# Logic:
#   1. Identify teammate name from payload.
#   2. Check it owns an in_progress task (otherwise not stalled — allow idle).
#   3. Find its most-recent transcript via agentType in subagents/meta.json.
#   4. Grep the last 2KB for a rate-limit indicator.
#   5. Only emit the nudge (exit 2) if step 4 confirms a rate limit.
#
# SAFE BY DEFAULT: exits 0 on ANY uncertainty.
# Hard cap of 3 re-engages per teammate prevents infinite loops.

payload="$(cat 2>/dev/null || true)"
name="$(printf '%s' "$payload" | jq -r '.teammate_name // .teammate // .name // .from // empty' 2>/dev/null || true)"
[ -z "${name:-}" ] && exit 0

# Hard cap: at most 3 auto-retries per teammate.
safe="${name//[^a-zA-Z0-9_-]/_}"
cnt_file="${CLAUDE_CODE_TMPDIR:-/tmp}/idle-retry-${safe}.cnt"
n="$(cat "$cnt_file" 2>/dev/null || echo 0)"
case "$n" in ''|*[!0-9]*) n=0 ;; esac
[ "$n" -ge 3 ] && exit 0

# Step 2: confirm the teammate owns an in_progress task.
owns=0
for f in $(grep -rl "\"${name}\"" "$HOME"/.claude/tasks/ 2>/dev/null || true); do
  [ -f "$f" ] || continue
  o="$(jq -r '.owner // empty' "$f" 2>/dev/null || true)"
  s="$(jq -r '.status // empty' "$f" 2>/dev/null || true)"
  if [ "$o" = "$name" ] && [ "$s" = "in_progress" ]; then owns=1; break; fi
done
[ "$owns" -eq 0 ] && exit 0

# Step 3: find the most-recently-modified transcript for this teammate.
# Session ID lives in CLAUDE_CODE_TMPDIR path, e.g.:
#   /tmp/claude-1000/-workspace/<uuid>/tasks/
session_id="$(printf '%s' "${CLAUDE_CODE_TMPDIR:-}" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
latest_transcript=""
if [ -n "$session_id" ]; then
  subagents_dir="/home/node/.claude/projects/-workspace/${session_id}/subagents"
  latest_mtime=0
  for meta in "${subagents_dir}"/agent-*.meta.json; do
    [ -f "$meta" ] || continue
    agent_type="$(jq -r '.agentType // empty' "$meta" 2>/dev/null || true)"
    [ "$agent_type" = "$name" ] || continue
    transcript="${meta%.meta.json}.jsonl"
    [ -f "$transcript" ] || continue
    mtime="$(stat -c '%Y' "$transcript" 2>/dev/null || echo 0)"
    if [ "$mtime" -gt "$latest_mtime" ]; then
      latest_mtime="$mtime"
      latest_transcript="$transcript"
    fi
  done
fi

# Step 4: check last ~2KB for a rate-limit indicator.
# If we cannot find the transcript, do NOT nudge (safe default).
[ -n "$latest_transcript" ] || exit 0

is_rate_limited="$(tail -c 2000 "$latest_transcript" 2>/dev/null \
  | grep -ci 'temporarily limiting\|Rate limited\|rate_limit\|overloaded\|429' 2>/dev/null || echo 0)"
[ "${is_rate_limited:-0}" -gt 0 ] || exit 0

# Step 5: confirmed rate limit — nudge.
echo $((n + 1)) > "$cnt_file" 2>/dev/null || true
printf '%s\n' '{"systemMessage":"Transient server-side rate limit detected. Retry your last request and resume your in-progress task. If you are genuinely blocked, message the lead instead."}'
exit 2
