#!/usr/bin/env python3
"""Serial llama-server benchmark: fixed-prefix prefill, decode and DSpark acceptance."""
import argparse
from contextlib import contextmanager
import csv
import fcntl
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SPEC_METRICS = {
    "drafted": "llamacpp:spec_decode_num_draft_tokens_total",
    "accepted": "llamacpp:spec_decode_num_accepted_tokens_total",
    "steps": "llamacpp:spec_decode_num_drafts_total",
}


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_info(path, digest=False):
    path = Path(path)
    stat = path.stat()
    info = {"path": str(path.absolute()), "resolved": str(path.resolve()),
            "bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    if digest:
        info["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return info


def http(url, route, body=None, timeout=3600, raw=False):
    data = None if body is None else json.dumps(body).encode()
    request = Request(url + route, data=data, headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
    except HTTPError as exc:
        raise RuntimeError(f"{route}: HTTP {exc.code}: {exc.read().decode(errors='replace')}") from exc
    return text if raw else json.loads(text)


def metrics(text):
    values = {}
    for line in text.splitlines():
        if line and not line.startswith("#"):
            name, value, *_ = line.split()
            if name in SPEC_METRICS.values():
                values[name] = float(value)
    return {key: values.get(name) for key, name in SPEC_METRICS.items()}


def memory_sample():
    mem = {line.split()[0].rstrip(":"): int(line.split()[1]) * 1024
           for line in Path("/proc/meminfo").read_text().splitlines()}
    vm = dict(line.split() for line in Path("/proc/vmstat").read_text().splitlines())
    return {"time": time.time(), "mem_total_bytes": mem["MemTotal"],
            "mem_available_bytes": mem["MemAvailable"],
            "system_unavailable_bytes": mem["MemTotal"] - mem["MemAvailable"],
            "memory_used_percent": 100 * (1 - mem["MemAvailable"] / mem["MemTotal"]),
            "swap_total_bytes": mem["SwapTotal"],
            "swap_used_bytes": mem["SwapTotal"] - mem["SwapFree"],
            "swap_used_percent": 100 * (1 - mem["SwapFree"] / mem["SwapTotal"]) if mem["SwapTotal"] else None,
            "swap_in_pages": int(vm["pswpin"]), "swap_out_pages": int(vm["pswpout"])}


@contextmanager
def sample_memory(path):
    samples, errors = [], []
    stop = threading.Event()
    with path.open("w", encoding="utf-8") as log:
        def sample():
            row = memory_sample()
            samples.append(row)
            log.write(json.dumps(row) + "\n")
            log.flush()

        def monitor():
            try:
                while not stop.wait(1):
                    sample()
            except Exception as exc:
                errors.append(exc)

        sample()
        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
        try:
            yield samples
        finally:
            stop.set()
            thread.join()
            sample()
            if errors:
                raise errors[0]


def memory_summary(samples):
    page_size = os.sysconf("SC_PAGE_SIZE")
    return {"mem_total_bytes": samples[0]["mem_total_bytes"],
            "system_unavailable_peak_bytes": max(s["system_unavailable_bytes"] for s in samples),
            "memory_used_peak_percent": max(s["memory_used_percent"] for s in samples),
            "mem_available_min_bytes": min(s["mem_available_bytes"] for s in samples),
            "swap_total_bytes": samples[0]["swap_total_bytes"],
            "swap_used_peak_bytes": max(s["swap_used_bytes"] for s in samples),
            "swap_used_peak_percent": max((s["swap_used_percent"] for s in samples
                                           if s["swap_used_percent"] is not None), default=None),
            "swap_in_bytes": (samples[-1]["swap_in_pages"] - samples[0]["swap_in_pages"]) * page_size,
            "swap_out_bytes": (samples[-1]["swap_out_pages"] - samples[0]["swap_out_pages"]) * page_size}


def command(config, drafter):
    cmd = [config["server"], "-m", config["target"], "--host", "127.0.0.1",
           "--port", str(config["port"]), "-np", "1", "-c", str(config["context_size"]),
           "-b", str(config["batch_size"]), "-ub", str(config["ubatch_size"]),
           "-ngl", "99", "-fa", "on", "-ctk", config["target_kv"], "-ctv", config["target_kv"],
           "--metrics", "--slots", "--jinja", "--cache-ram", "0", "--no-context-shift", "--log-colors", "off"]
    if drafter:
        cmd += ["--spec-type", "draft-dspark", "-md", drafter, "-ngld", "99",
                "--spec-draft-n-max", str(config["n_max"]),
                "-ctkd", config["draft_kv"], "-ctvd", config["draft_kv"]]
    else:
        cmd += ["--spec-type", "none"]
    return cmd


def port_in_use(port):
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) == 0


@contextmanager
def server(config, drafter, out, timeout):
    # Never connect to or stop an existing service, even if it uses our port.
    if port_in_use(config["port"]):
        raise RuntimeError(f"port {config['port']} is already in use")
    env = {k: v for k, v in os.environ.items() if not k.startswith("LLAMA_ARG_")}
    env.update(config.get("env", {}))
    cmd = command(config, drafter)
    version = subprocess.run([config["server"], "--version"], env=env, capture_output=True,
                             text=True, timeout=30, check=True)
    metadata = {"command": cmd, "version": version.stdout + version.stderr,
                "platform": platform.platform(), "target": file_info(config["target"]),
                "drafter": file_info(drafter) if drafter else None,
                "launcher": file_info(config["server"], digest=True),
                "memory_before_launch": memory_sample()}
    with (out / "server.log").open("w", encoding="utf-8") as log:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        try:
            url = f"http://127.0.0.1:{config['port']}"
            deadline = time.monotonic() + timeout
            while True:
                if proc.poll() is not None:
                    raise RuntimeError(f"server exited ({proc.returncode}); see {out / 'server.log'}")
                if time.monotonic() >= deadline:
                    raise TimeoutError("server readiness timeout")
                try:
                    if http(url, "/health", timeout=2).get("status") == "ok":
                        break
                except (OSError, URLError, RuntimeError):
                    pass
                time.sleep(0.5)
            metadata["executable"] = file_info(Path(f"/proc/{proc.pid}/exe").resolve(), digest=True)
            process_env = Path(f"/proc/{proc.pid}/environ").read_bytes().decode().split("\0")
            metadata["runtime_environment"] = dict(item.split("=", 1) for item in process_env
                if item.startswith(("GGML_", "VK_", "LD_LIBRARY_PATH=")))
            metadata["memory_after_load"] = memory_sample()
            save(out / "run.json", metadata)
            save(out / "props.json", http(url, "/props"))
            slots = http(url, "/slots")
            save(out / "slots.json", slots)
            if len(slots) != 1 or slots[0]["n_ctx"] < config["context_size"]:
                raise RuntimeError("server did not provide the requested single-slot context")
            yield url
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
            metadata["server_returncode"] = proc.returncode
            save(out / "run.json", metadata)


def prompts(url, workload, depths):
    # Fixed inputs across variants: never feed a variant's generated output into the next point.
    marker = "__BENCH_CONTEXT_4917__"
    template = http(url, "/apply-template", {"messages": [
        {"role": "user", "content": marker + "\n\n" + workload["task"]}]})["prompt"]
    if template.count(marker) != 1:
        raise ValueError("chat template did not preserve the context marker")
    before, after = template.split(marker)

    def tokenize(text, special):
        return http(url, "/tokenize", {"content": text, "add_special": False,
                                       "parse_special": special})["tokens"]

    head, tail = tokenize(before, True), tokenize(after, True)
    corpus = tokenize(workload["context"], False)
    if not corpus or min(depths) <= len(head) + len(tail):
        raise ValueError("empty corpus or depth too small for the task/chat template")
    result = {}
    for depth in depths:
        count = depth - len(head) - len(tail)
        # Synthetic repeated corpus is intentional; replace context with a real pinned corpus for publication.
        result[depth] = head + (corpus * ((count + len(corpus) - 1) // len(corpus)))[:count] + tail
    return result, head + tail


def request_payload(tokens, predict, seed, reuse):
    return {"prompt": tokens, "n_predict": predict, "seed": seed, "temperature": 0,
            "top_k": 1, "top_p": 1, "min_p": 0, "repeat_penalty": 1,
            "cache_prompt": reuse, "id_slot": 0, "stream": False, "return_tokens": True,
            "ignore_eos": False}


def measure(url, payload, out, case, timeout):
    save(out / f"{case}.request.json", payload)
    before = http(url, "/metrics", raw=True)
    (out / f"{case}.metrics-before.txt").write_text(before)
    start = time.monotonic()
    with sample_memory(out / f"{case}.memory.jsonl") as samples:
        response = http(url, "/completion", payload, timeout=timeout)
    wall = time.monotonic() - start
    save(out / f"{case}.response.json", response)
    (out / f"{case}.output.txt").write_text(response.get("content", ""), encoding="utf-8")
    after = http(url, "/metrics", raw=True)
    (out / f"{case}.metrics-after.txt").write_text(after)
    if "error" in response or response.get("truncated"):
        raise RuntimeError(f"{case}: completion failed or context was truncated")
    pre, post = metrics(before), metrics(after)
    delta = {k: post[k] - pre[k] if pre[k] is not None and post[k] is not None else None for k in pre}
    return response, delta, wall, memory_summary(samples)


def summarize(response, delta, prompt, speculative):
    timing = response["timings"]
    prompt_n, cache_n = timing["prompt_n"], timing["cache_n"]
    if prompt_n + cache_n != len(prompt):
        raise ValueError("prompt/cache accounting mismatch; raw response preserved")
    if timing["prompt_ms"] <= 0 or timing["predicted_ms"] <= 0 or timing["predicted_n"] <= 0:
        raise ValueError("missing/invalid timing data")
    drafted = timing.get("draft_n", 0)
    accepted = timing["draft_n_accepted"] if drafted else timing.get("draft_n_accepted", 0)
    if not 0 <= accepted <= drafted or (drafted and not speculative):
        raise ValueError("unexpected draft counters")
    if speculative and any(delta.get(k) is None for k in SPEC_METRICS):
        raise ValueError("server lacks speculation counters required for mean accepted length")
    steps = delta["steps"] if speculative else None
    if speculative and (delta["drafted"] != drafted or delta["accepted"] != accepted
                        or (drafted > 0 and steps <= 0) or (drafted == 0 and steps != 0)):
        raise ValueError("metrics/response mismatch; ensure this server has no other clients")
    tokens = response.get("tokens")
    if not tokens:
        raise ValueError("return_tokens produced no token IDs; correctness comparison unavailable")
    # ponytail: exact repeated-tail warning only; human review is required for semantic degeneration.
    loop = any(len(tokens) >= size * 4 and tokens[-size:] * 4 == tokens[-size * 4:]
               for size in range(1, 65))
    return {"input_tokens": len(prompt), "cache_tokens": cache_n, "prefill_tokens": prompt_n,
            "prefill_kind": "incremental" if cache_n else "cold",
            "prefill_ms": timing["prompt_ms"], "prefill_tps": prompt_n * 1000 / timing["prompt_ms"],
            "decode_tokens": timing["predicted_n"], "decode_ms": timing["predicted_ms"],
            # Use server accounting: its first token comes from prefill, so immediate EOS has 0 decode TPS.
            "decode_tps": timing["predicted_per_second"],
            "draft_tokens": drafted, "accepted_tokens": accepted,
            "acceptance": accepted / drafted if drafted else None,
            "verification_steps": steps,
            "mean_accepted_draft_tokens": accepted / steps if steps else None,
            "mean_accepted_length": 1 + accepted / steps if steps else None,
            "stop_type": response.get("stop_type"), "repeated_tail_warning": loop}


def load_config(path, args):
    config = json.loads(path.read_text(encoding="utf-8"))
    def absolute(value):
        p = Path(value).expanduser()
        return str(p if p.is_absolute() else (path.parent / p).resolve())
    for key in ("server", "target"):
        config[key] = absolute(config[key])
    config["variants"] = {name: absolute(p) if p else None for name, p in config["variants"].items()}
    if args.depths:
        config["depths"] = [int(n) for n in args.depths.split(",")]
    if args.predict is not None:
        config["predict"] = args.predict
    for key in ("port", "context_size", "batch_size", "ubatch_size", "n_max", "predict"):
        if type(config[key]) is not int or config[key] <= 0:
            raise ValueError(f"{key} must be a positive integer")
    depths = config["depths"]
    if not depths or any(type(n) is not int or n <= 0 for n in depths) or depths != sorted(set(depths)):
        raise ValueError("depths must be strictly increasing positive integers")
    if max(depths) + config["predict"] + config["n_max"] + 8 > config["context_size"]:
        raise ValueError("context_size must fit max depth + predict + n_max + 8")
    if config["ubatch_size"] > config["batch_size"] or config["port"] > 65535:
        raise ValueError("invalid batch sizes or port")
    for name in list(config["variants"]) + list(config["workloads"]):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise ValueError(f"unsafe variant/workload name: {name}")
    for workload in config["workloads"].values():
        if not all(isinstance(workload[k], str) and workload[k].strip() for k in ("context", "task")):
            raise ValueError("workloads require nonempty context and task strings")
    if config["variants"].get("plain", "missing") is not None:
        raise ValueError("plain variant must have a null drafter")
    variants = list(config["variants"]) if args.variant == "all" else args.variant.split(",")
    workloads = list(config["workloads"]) if args.workload == "all" else args.workload.split(",")
    if len(set(variants)) != len(variants) or any(n not in config["variants"] for n in variants):
        raise ValueError("unknown or duplicate variant")
    if len(set(workloads)) != len(workloads) or any(n not in config["workloads"] for n in workloads):
        raise ValueError("unknown or duplicate workload")
    variants.sort(key=lambda name: name != "plain")
    for p in [config["server"], config["target"]] + [config["variants"][n] for n in variants if config["variants"][n]]:
        if not Path(p).is_file():
            raise ValueError(f"file not found: {p}")
    if not os.access(config["server"], os.X_OK):
        raise ValueError("server must be executable")
    if type(config["seed"]) is not int or not 0 <= config["seed"] < 2**32 - 1:
        raise ValueError("seed must be a fixed uint32 (not the random-seed sentinel)")
    if any(not isinstance(v, str) or k.startswith("LLAMA_ARG_") for k, v in config.get("env", {}).items()):
        raise ValueError("env values must be strings; LLAMA_ARG_* is not allowed")
    return config, variants, workloads


def resume_rows(out, plan):
    if json.loads((out / "plan.json").read_text()) != plan:
        raise ValueError("resume requires the original config and benchmark options")
    text = (out / "results.jsonl").read_text()
    if text and not text.endswith("\n"):
        raise ValueError("incomplete results.jsonl tail; preserve and inspect it before resuming")
    rows = [json.loads(line) for line in text.splitlines()]
    keys = [(r["variant"], r["workload"], r["repeat"], r["input_tokens"]) for r in rows]
    if len(set(keys)) != len(keys):
        raise ValueError("duplicate completed points in results.jsonl")
    return rows, set(keys)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "configs/runtime-bench.json")
    parser.add_argument("--variant", default="all", help="all or comma-separated config variant names")
    parser.add_argument("--workload", default="all", help="all or comma-separated workload names")
    parser.add_argument("--depths", help="override input token depths, e.g. 2048,8192,16384,32768")
    parser.add_argument("--predict", type=int, help="override maximum generated tokens per point")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--cache-mode", choices=("reuse", "cold"), default="reuse")
    parser.add_argument("--timeout", type=float, default=3600, help="HTTP request timeout in seconds")
    parser.add_argument("--startup-timeout", type=float, default=600)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--resume", type=Path, help="resume an existing run with identical options")
    parser.add_argument("--dry-run", action="store_true", help="validate and print plan; do not start a server")
    args = parser.parse_args()
    if args.repetitions <= 0 or not 0 < args.timeout < float("inf") or not 0 < args.startup_timeout < float("inf"):
        parser.error("repetitions and timeouts must be positive and finite")
    config, variants, workloads = load_config(args.config.resolve(), args)
    plan = {"config": config, "variants": variants, "workloads": workloads,
            "cache_mode": args.cache_mode, "repetitions": args.repetitions,
            "commands": {name: command(config, config["variants"][name]) for name in variants}}
    if args.dry_run:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return
    if args.resume and args.output:
        parser.error("--resume and --output are mutually exclusive")
    out = args.resume or args.output or ROOT / "runs/runtime" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    if not args.resume:
        out.mkdir(parents=True, exist_ok=False)
    # Hold the run lock until main returns; two resume processes must not append together.
    lock = (out / ".lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    rows, done = resume_rows(out, plan) if args.resume else ([], set())
    if not args.resume:
        save(out / "plan.json", plan)
    save(out / "status.json", {"status": "running"})
    writer = None
    try:
        with (out / "results.jsonl").open("a", encoding="utf-8") as jsonl, (out / "results.csv").open("w", newline="", encoding="utf-8") as csvfile:
            if rows:
                writer = csv.DictWriter(csvfile, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
                csvfile.flush()
            for variant in variants:
                pending = {(variant, w, r, d) for w in workloads
                           for r in range(1, args.repetitions + 1) for d in config["depths"]} - done
                if not pending:
                    continue
                directory = out / variant
                directory.mkdir(exist_ok=True)
                attempt = directory / datetime.now(timezone.utc).strftime("attempt-%Y%m%dT%H%M%S.%fZ")
                attempt.mkdir()
                drafter = config["variants"][variant]
                with server(config, drafter, attempt, args.startup_timeout) as url:
                    for workload in workloads:
                        if not any(k[1] == workload for k in pending):
                            continue
                        inputs, warmup = prompts(url, config["workloads"][workload], config["depths"])
                        measure(url, request_payload(warmup, 16, config["seed"], False), attempt,
                                f"{workload}-warmup", args.timeout)
                        for repeat in range(1, args.repetitions + 1):
                            remaining = [k[3] for k in pending if k[1:3] == (workload, repeat)]
                            if not remaining:
                                continue
                            for point, (depth, tokens) in enumerate(inputs.items()):
                                if depth > max(remaining):
                                    break
                                case = f"{workload}-r{repeat}-p{depth}"
                                reuse = args.cache_mode == "reuse" and point > 0
                                payload = request_payload(tokens, config["predict"], config["seed"], reuse)
                                if (variant, workload, repeat, depth) in done:
                                    if args.cache_mode == "reuse":
                                        # Replay the prefix sequence without overwriting completed measurements.
                                        measure(url, payload, attempt, f"replay-{case}", args.timeout)
                                    continue
                                response, delta, wall, mem = measure(url, payload, directory, case, args.timeout)
                                row = {"variant": variant, "workload": workload, "repeat": repeat,
                                       "cache_mode": args.cache_mode, "cache_requested": reuse,
                                       "drafter_bytes": Path(drafter).stat().st_size if drafter else 0,
                                       **summarize(response, delta, tokens, bool(drafter)),
                                       "wall_seconds": wall, **mem,
                                       "matches_plain_tokens": None, "matches_plain_text": None,
                                       "quality_review": "unreviewed"}
                                baseline = out / "plain" / f"{case}.response.json"
                                if variant != "plain" and baseline.exists():
                                    base_request = json.loads((baseline.parent / f"{case}.request.json").read_text())
                                    if base_request != payload:
                                        raise ValueError("plain/spec requests differ; refusing correctness comparison")
                                    base = json.loads(baseline.read_text())
                                    row["matches_plain_tokens"] = base["tokens"] == response["tokens"]
                                    row["matches_plain_text"] = base["content"] == response["content"]
                                jsonl.write(json.dumps(row, ensure_ascii=False) + "\n")
                                jsonl.flush()
                                if writer is None:
                                    writer = csv.DictWriter(csvfile, fieldnames=list(row))
                                    writer.writeheader()
                                writer.writerow(row)
                                csvfile.flush()
                                swap = row["swap_used_peak_percent"]
                                swap_text = f"{swap:.1f}%" if swap is not None else "n/a"
                                print(f"{variant} {case}: prefill={row['prefill_tps']:.2f}, decode={row['decode_tps']:.2f}, acceptance={row['acceptance']}, RAM={row['memory_used_peak_percent']:.1f}%, swap={swap_text}, cache={row['cache_tokens']}, plain_match={row['matches_plain_tokens']}", flush=True)
        save(out / "status.json", {"status": "completed", "quality_review": "unreviewed"})
    except BaseException as exc:
        save(out / "status.json", {"status": "interrupted" if isinstance(exc, (KeyboardInterrupt, SystemExit)) else "failed",
                                   "error": f"{type(exc).__name__}: {exc}"})
        raise
    print(f"Saved: {out}")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
