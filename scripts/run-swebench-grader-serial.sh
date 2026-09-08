#!/usr/bin/env bash
set -Eeuo pipefail

# Run SWE-bench one instance at a time and remove only images created by this
# invocation. The official harness removes containers but intentionally leaves
# per-instance evaluation images behind.

usage() {
  cat <<'EOF'
Usage: scripts/run-swebench-grader-serial.sh \
  --dataset <path-or-name> --predictions <path> --run-id <id> \
  [--split <split>] [--timeout <seconds>] [--report-dir <dir>] [--python <path>]

The wrapper requires Docker and the swebench Python package. It assumes no
other SWE-bench evaluation is running concurrently.
EOF
}

python_bin="${PYTHON_BIN:-python3}"
dataset=""
split="test"
predictions=""
run_id=""
timeout="1800"
report_dir="."

while (($# > 0)); do
  case "$1" in
    --dataset) dataset=${2:?--dataset requires a value}; shift 2 ;;
    --split) split=${2:?--split requires a value}; shift 2 ;;
    --predictions) predictions=${2:?--predictions requires a value}; shift 2 ;;
    --run-id) run_id=${2:?--run-id requires a value}; shift 2 ;;
    --timeout) timeout=${2:?--timeout requires a value}; shift 2 ;;
    --report-dir) report_dir=${2:?--report-dir requires a value}; shift 2 ;;
    --python) python_bin=${2:?--python requires a value}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$dataset" || -z "$predictions" || -z "$run_id" ]]; then
  usage >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

list_eval_images() {
  docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' \
    | awk '$1 ~ /^swebench\/sweb\.eval\./ {print $2}' \
    | sort -u
}

list_eval_containers() {
  docker ps -aq --filter 'name=^sweb\.eval\.' | sort -u
}

before_images=$(mktemp)
before_containers=$(mktemp)
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e

  local after_images after_containers
  after_images=$(mktemp)
  after_containers=$(mktemp)
  list_eval_images >"$after_images"
  list_eval_containers >"$after_containers"

  # The official harness normally removes containers. This also handles an
  # interrupt or an evaluator failure before its finally block runs.
  comm -13 "$before_containers" "$after_containers" | while read -r container; do
    [[ -z "$container" ]] || docker rm -f "$container" >/dev/null 2>&1 || true
done
  comm -13 "$before_images" "$after_images" | while read -r image; do
    [[ -z "$image" ]] || docker image rm "$image" >/dev/null 2>&1 || true
done

  rm -f "$before_images" "$before_containers" "$after_images" "$after_containers"
  exit "$status"
}
trap cleanup EXIT INT TERM

list_eval_images >"$before_images"
list_eval_containers >"$before_containers"

# Empty patches never create an evaluation image, so grade only predictions
# that can actually be evaluated. The final rewrite pass restores the official
# aggregate report, including empty-patch and incomplete counts.
mapfile -t instance_ids < <(
  "$python_bin" - "$predictions" <<'PY'
import json
import sys
for line in open(sys.argv[1], encoding="utf-8"):
    prediction = json.loads(line)
    if prediction.get("model_patch"):
        print(prediction["instance_id"])
PY
)

for instance_id in "${instance_ids[@]}"; do
  echo "==> grading $instance_id"
  "$python_bin" -m swebench.harness.run_evaluation \
    --dataset_name "$dataset" \
    --split "$split" \
    --instance_ids "$instance_id" \
    --predictions_path "$predictions" \
    --max_workers 1 \
    --timeout "$timeout" \
    --run_id "$run_id" \
    --report_dir "$report_dir"

  # Remove images immediately, rather than accumulating one image per task.
  after_images=$(mktemp)
  list_eval_images >"$after_images"
  comm -13 "$before_images" "$after_images" | while read -r image; do
    [[ -z "$image" ]] || docker image rm "$image" >/dev/null 2>&1 || true
done
  rm -f "$after_images"
done

echo "==> writing aggregate report"
"$python_bin" -m swebench.harness.run_evaluation \
  --dataset_name "$dataset" \
  --split "$split" \
  --predictions_path "$predictions" \
  --run_id "$run_id" \
  --rewrite_reports true \
  --report_dir "$report_dir"
