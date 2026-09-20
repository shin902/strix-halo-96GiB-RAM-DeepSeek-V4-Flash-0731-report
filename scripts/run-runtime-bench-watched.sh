#!/usr/bin/env bash
# Run in a Herdr pane; retain an exit marker even if the benchmark dies.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [[ ${1:-} == --resume ]]; then
  output=${2:?Usage: $0 --resume RUN_DIRECTORY [benchmark options]}
  shift 2
  destination=(--resume "$output")
else
  output="runs/runtime/$(date -u +%Y%m%dT%H%M%S.%NZ)"
  destination=(--output "$output")
fi
log="${output}.$(date -u +%Y%m%dT%H%M%S.%NZ).log"
mkdir -p runs/runtime
rm -f "${output}.exit"
printf 'Benchmark output: %s\nMonitor log: %s\n' "$output" "$log"

# Swap is expected; do not abort based on available RAM alone.
timeout --signal=TERM --kill-after=2m 12h \
  python3 scripts/bench-runtime.py "${destination[@]}" "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
printf '%s\n' "$status" > "${output}.exit"
if (( status == 0 )); then
  title="Runtime benchmark completed"
  sound=done
else
  title="Runtime benchmark failed (exit $status)"
  sound=request
fi
herdr notification show "$title" --body "$PWD/$output — log: $PWD/$log" --sound "$sound" || true
printf '\n%s: %s\n' "$title" "$output"
exit "$status"
