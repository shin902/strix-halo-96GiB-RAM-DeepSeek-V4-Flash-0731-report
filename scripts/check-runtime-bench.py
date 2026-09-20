#!/usr/bin/env python3
"""Offline self-check of launch flags and arithmetic; no model, GPU or test framework."""
import json
from pathlib import Path
import runpy

bench = runpy.run_path(str(Path(__file__).with_name("bench-runtime.py")))
config = json.loads((bench["ROOT"] / "configs/runtime-bench.json").read_text())
for drafter in config["variants"].values():
    cmd = bench["command"](config, drafter)
    assert "--slots" in cmd and "--metrics" in cmd, "Required monitoring endpoints must be enabled"
response = {
    "timings": {"prompt_n": 4, "cache_n": 6, "prompt_ms": 20,
                "predicted_n": 5, "predicted_ms": 50, "draft_n": 4, "draft_n_accepted": 3},
    "tokens": [1, 2, 3, 4, 5], "stop_type": "limit",
}
delta = bench["metrics"]("\n".join([
    "# TYPE llamacpp:spec_decode_num_drafts_total counter",
    "llamacpp:spec_decode_num_draft_tokens_total 4",
    "llamacpp:spec_decode_num_accepted_tokens_total 3",
    "llamacpp:spec_decode_num_drafts_total 2",
]))
row = bench["summarize"](response, delta, list(range(10)), True)
assert (row["prefill_tps"], row["decode_tps"], row["acceptance"]) == (200, 100, 0.75)
assert (row["mean_accepted_draft_tokens"], row["mean_accepted_length"]) == (1.5, 2.5)
assert row["prefill_kind"] == "incremental" and not row["repeated_tail_warning"]
try:
    bench["summarize"](response, {**delta, "steps": None}, list(range(10)), True)
except ValueError:
    pass
else:
    raise AssertionError("Missing statistics must not silently become zero")
response["timings"].update(draft_n=0, draft_n_accepted=0, cache_n=0, prompt_n=10)
row = bench["summarize"](response, {}, list(range(10)), False)
assert row["acceptance"] is None and row["mean_accepted_length"] is None
assert row["prefill_kind"] == "cold"
sample = bench["memory_sample"]()
sample.update(swap_total_bytes=0, swap_used_bytes=0, swap_used_percent=None,
              swap_in_pages=0, swap_out_pages=0)
summary = bench["memory_summary"]([sample, {**sample, "swap_in_pages": 2}])
assert summary["swap_used_peak_percent"] is None
assert summary["swap_in_bytes"] == 2 * bench["os"].sysconf("SC_PAGE_SIZE")
assert 0 <= summary["memory_used_peak_percent"] <= 100
print("runtime benchmark self-check: OK")
