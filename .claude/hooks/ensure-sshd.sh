#!/bin/bash
# SessionStart hook: sshd does not survive a bare `docker restart` (only
# devcontainer postStartCommand starts it, and that's client-tooling-driven,
# not part of the container's own boot). Self-heal here since Claude Code
# sessions restart far more often than the container gets rebuilt.
if ! (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ':2222 '; then
  sudo /usr/sbin/sshd -p 2222 2>/dev/null
fi
exit 0
