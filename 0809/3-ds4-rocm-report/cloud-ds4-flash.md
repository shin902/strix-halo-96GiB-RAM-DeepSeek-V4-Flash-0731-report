# Repo Analysis: `ds4-rocm-kv-cache-q`

## What it is

A fork of **DwarfStar (ds4)** — a self-contained, single-purpose native inference engine for **DeepSeek V4 Flash** (plus GLM 5.2, and DeepSeek V4 PRO on big machines). It is deliberately **not a general GGUF runner**; model loading, KV cache, agent, and server are built together. Backends: Metal (primary), CUDA, and **ROCm** (Strix Halo / Framework Desktop).

The fork name says it all: this workspace's own work is **ROCm KV-cache quality/compression** plus **REAP compact-runtime support**.

## Layout

| Area             | Files                                                                                         | Notes                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Engine core      | `ds4.c` (2.9 MB), `ds4.h`                                                                     | Single-file engine; binds GGUF metadata → tensors          |
| GPU backends     | `ds4_cuda.cu` (1.2 MB), `ds4_metal.m`, `rocm/*.cuh` (23 headers)                              | ROCm kernels split into include-per-module headers         |
| Server/agent     | `ds4_server.c`, `ds4_agent.c`, `ds4_web.c`                                                    | Multi-user micro-batching, in-process coding agent         |
| KV store         | `ds4_kvstore.c/.h`                                                                            | Session persistence (`~/.ds4/kvcache`, `/save`, `/switch`) |
| Quality/baseline | `ds4_bench.c`, `ds4_eval.c`, `tools/quality_bench.py`                                         | Frontier-throughput + A/B quality harness                  |
| Extras           | `gguf-tools/`, `dir-steering/`, `speed-bench/`, `tests/` (incl. official-vector test vectors) |                                                            |

## Recent fork work (branch `feat/reap-compact-runtime`, Aug 2026)

1. **`bd3a1d3`** **— REAP compact runtime support** (`ds4.c`, +150/−41) — the distinctive feature. Loads GGUF metadata (`reap.enabled`, `reap.layout=ds4-compact-v1`, per-layer `reap.layer.policy/expert_count/keep_count`) and adapts the engine to a *pruned* model: per-layer expert counts, three policies (`HASH_PRESERVED`, `ROUTER_MASK_PRUNED`, `MOE_DISABLED`), validation that hash-routed layers can't be disabled, and routing code generalized to use stored expert counts instead of fixed `DS4_N_EXPERT`.
2. **`8f95123`** **— K160 routing on ROCm** — adds a 160-expert path (REAP's router-masked-count) to `router_select_warp_topk_kernel` in `rocm/ds4_rocm_router.cuh`, both single and batch.
3. **`2f7c31b`** **...** **`47d3b52`** **earlier — ROCm KV cache quality work** merged from `kyuz0/ds4` (TurboQuant KV cache support), plus ROCm fixes (IQ2 SSD prefill deadlock, MTP verification, arena sizing).
4. **`95f342d`** **— persistent KV cache quality benchmark**: `tools/quality_bench.py` (601 lines) + `tools/test_quality_bench.py` + README section. Pure-stdlib harness that starts one `ds4-server` per variant, A/Bs quantizations (F16/FP8/Q8/TQ4/TQ2), measures latency/throughput/cache-hit/VRAM/system-RAM, fingerprint comparison, session-restore durability check, crash detection, `--dry-run`.
5. **`a82affa`** **— Document ROCm batch compression ratio guard** (3 lines in `ds4_rocm_attention_launch.cuh`).

## KV-cache quantization modes (ROCm)

`--kv-cache-fp8 | --kv-cache-q8 | --kv-cache-tq4 | --kv-cache-tq2` (also via env vars) select the compressed-cache representation; F16 is the uncompressed baseline. Flags are parsed in `ds4_agent.c`, `ds4_server.c`, `ds4_cli.c`, doc'd in `ds4_help.c`. `tools/quality_bench.py` uses these exact flags.

## Notable oddities

- **`docs/clone/ds4-for-reaped/`** — a full 32 MB git clone of the reasoning repo `eouya2/ds4-for-reaped` (remote `reasoned`), present locally but **not tracked** (gitignored). It's the reference for the "reaped/compact" model format this branch implements.
- **3 remotes**: `origin` (shin902/ds4-rocm-kv-cache-q), `ky0c/ds4` (ROCm upstream-ish), `reasoned` (ds4-for-reaped).
- Clean working tree, on branch with nothing unpushed (HEAD == origin/feat/reap-compact-runtime).
- Prebuilt `.o` files and binaries present (Aug 9 2026 build).

## Assessment

This is a focused optimization fork: most of the code is the upstream DwarfStar product; the delta is concentrated in \~5 commits on the ROCm KV-cache path, the REAP-aware runtime loader, and the new measured benchmark. The quality-run harness is well-tested (unit model-free coverage included).

If you want, I can go deeper into a specific area — e.g., the REAP metadata flow in `ds4.c`, the TurboQuant kernel set in `rocm/`, or how `quality_bench.py`'s JSON results are consumed.
