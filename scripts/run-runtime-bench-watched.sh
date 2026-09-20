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

# Stop before another host-wide OOM; keep a 2 GiB host reserve.
timeout --signal=TERM --kill-after=2m 12h \
  python3 scripts/bench-runtime.py "${destination[@]}" "$@" > >(tee "$log") 2>&1 &
pid=$!
while kill -0 "$pid" 2>/dev/null; do
  available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  if (( available < 2097152 )); then
    printf 'Stopping: MemAvailable below 2 GiB\n' | tee -a "$log"
    kill -TERM "$pid" 2>/dev/null || true
    break
  fi
  sleep 1
done
wait "$pid"
status=$?
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
