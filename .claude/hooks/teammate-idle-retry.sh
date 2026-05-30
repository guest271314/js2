#!/usr/bin/env bash
# TeammateIdle retry hook (#rate-limit resilience).
#
# Re-engages a teammate that went idle WHILE it still owns an in-progress task —
# the signature of a transient server-side throttle stall (the SDK exhausted its
# retries and the teammate fell idle with work still to do). Emits a "retry" nudge
# (exit 2 = blocking feedback) so the teammate resumes without the lead hand-nudging.
#
# SAFE BY DEFAULT: exits 0 (allow idle) on ANY uncertainty, so legitimate idle and
# shutdown_request-driven exits are NEVER blocked. A teammate being shut down has its
# task marked completed/reassigned first, so it owns no in-progress task -> idle allowed.
# Hard cap of 3 re-engages per teammate prevents infinite loops on a genuinely-stuck agent.
payload="$(cat 2>/dev/null || true)"
name="$(printf '%s' "$payload" | jq -r '.teammate_name // .teammate // .name // .from // empty' 2>/dev/null || true)"
[ -z "${name:-}" ] && exit 0   # can't identify the teammate -> allow idle (safe no-op)

# Hard cap: at most 3 auto-retries per teammate, then allow idle so the lead intervenes.
safe="${name//[^a-zA-Z0-9_-]/_}"
cnt_file="${CLAUDE_CODE_TMPDIR:-/tmp}/idle-retry-${safe}.cnt"
n="$(cat "$cnt_file" 2>/dev/null || echo 0)"
case "$n" in ''|*[!0-9]*) n=0 ;; esac
[ "$n" -ge 3 ] && exit 0

# Re-engage ONLY if the teammate owns an in_progress task (has work -> it stalled, not
# finished). grep pre-filters task files mentioning the name; jq confirms owner+status.
owns=0
for f in $(grep -rl "\"${name}\"" "$HOME"/.claude/tasks/ 2>/dev/null || true); do
  [ -f "$f" ] || continue
  o="$(jq -r '.owner // empty' "$f" 2>/dev/null || true)"
  s="$(jq -r '.status // empty' "$f" 2>/dev/null || true)"
  if [ "$o" = "$name" ] && [ "$s" = "in_progress" ]; then owns=1; break; fi
done
[ "$owns" -eq 0 ] && exit 0   # no owned in-progress task -> legitimate idle/shutdown, allow it

echo $((n + 1)) > "$cnt_file" 2>/dev/null || true
printf '%s\n' '{"systemMessage":"Likely a transient server-side throttle (not your usage limit). Retry your last request and resume your in-progress task. If you are genuinely blocked (not throttled), message the lead instead."}'
exit 2
