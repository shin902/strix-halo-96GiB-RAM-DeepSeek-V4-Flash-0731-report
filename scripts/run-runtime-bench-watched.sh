#!/usr/bin/env bash
# Run the benchmark in the foreground and notify Herdr when it stops.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
output="runs/runtime/$(date -u +%Y%m%dT%H%M%S.%NZ)"
log="${output}.log"
mkdir -p runs/runtime
printf 'Benchmark output: %s\nMonitor log: %s\n' "$output" "$log"

# ponytail: 12h is a safety ceiling for a one-off exhibition run; raise it only if valid cases time out.
timeout --signal=TERM --kill-after=2m 12h \
  python3 scripts/bench-runtime.py --output "$output" "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if (( status == 0 )); then
  title="Runtime benchmark completed"
  sound=done
else
  title="Runtime benchmark failed (exit $status)"
  sound=request
fi
herdr notification show "$title" --body "$PWD/$output — log: $PWD/$log" --sound "$sound" || true
printf '\n%s\n' "$title"
exit "$status"
