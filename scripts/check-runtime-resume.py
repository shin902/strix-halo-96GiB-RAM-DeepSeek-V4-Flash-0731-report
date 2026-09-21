#!/usr/bin/env python3
"""Offline crash/replay/resume check using only Python's standard library."""
from contextlib import nullcontext
import csv
import json
import os
from pathlib import Path
import runpy
import sys
import subprocess
from tempfile import TemporaryDirectory
from unittest.mock import patch

bench = runpy.run_path(str(Path(__file__).with_name("bench-runtime.py")))
config = {"variants": {"plain": None}, "workloads": {"coding": {}},
          "depths": [2, 4], "seed": 1234, "predict": 2}
calls = []
fail = True


def measure(url, payload, directory, case, timeout):
    calls.append(case)
    if fail and case == "coding-r1-p4":
        raise RuntimeError("simulated interruption")
    return ({"timings": {"prompt_n": len(payload["prompt"]), "cache_n": 0,
                         "prompt_ms": 1, "predicted_n": 2, "predicted_ms": 1,
                         "predicted_per_second": 1000}, "tokens": [1, 2]}, {}, 0.1,
            {"swap_used_peak_percent": 0, "memory_used_peak_percent": 50})


with TemporaryDirectory() as tmp, patch.dict(bench["main"].__globals__, {
    "load_config": lambda *_: (config, ["plain"], ["coding"]),
    "command": lambda *_: [], "server": lambda *_: nullcontext("offline"),
    "prompts": lambda *_: ({2: [1, 2], 4: [1, 2, 3, 4]}, [1]), "measure": measure,
}):
    out = Path(tmp) / "run"
    with patch.object(sys, "argv", ["bench", "--output", str(out)]):
        try:
            bench["main"]()
        except RuntimeError as exc:
            assert str(exc) == "simulated interruption"
        else:
            raise AssertionError("interruption did not occur")
    first = (out / "results.jsonl").read_text()
    assert len(first.splitlines()) == 1
    fail = False
    calls.clear()
    with patch.object(sys, "argv", ["bench", "--resume", str(out)]):
        bench["main"]()
        assert calls == ["coding-warmup", "replay-coding-r1-p2", "coding-r1-p4"]
        calls.clear()
        bench["main"]()
        assert calls == [], "completed run must not launch or replay anything"
    assert (out / "results.jsonl").read_text().startswith(first)
    assert len((out / "results.jsonl").read_text().splitlines()) == 2
    with (out / "results.csv").open() as stream:
        assert len(list(csv.DictReader(stream))) == 2
    assert json.loads((out / "status.json").read_text())["status"] == "completed"
    try:
        bench["resume_rows"](out, {"different": "plan"})
    except ValueError:
        pass
    else:
        raise AssertionError("changed conditions must not be merged")
# Exercise watcher exit markers without models or real notifications.
with TemporaryDirectory() as tmp:
    root = Path(tmp)
    for name, body in {"python3": "exit 7", "herdr": "exit 0"}.items():
        tool = root / name
        tool.write_text(f"#!/bin/sh\n{body}\n")
        tool.chmod(0o755)
    env = {**os.environ, "PATH": f"{root}:{os.environ['PATH']}"}
    launcher = Path(__file__).with_name("run-runtime-bench-watched.sh")
    for expected in (7, 0):
        (root / "python3").write_text(f"#!/bin/sh\nexit {expected}\n")
        result = subprocess.run(["bash", str(launcher), "--resume", str(root / "run")],
                                env=env, capture_output=True, text=True, timeout=10)
        assert result.returncode == expected, result.stdout + result.stderr
        assert (root / "run.exit").read_text().strip() == str(expected)
print("runtime resume/watcher self-check: OK")
