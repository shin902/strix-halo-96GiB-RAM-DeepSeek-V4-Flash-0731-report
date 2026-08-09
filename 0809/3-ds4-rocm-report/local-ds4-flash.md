I've completed the analysis. Here's the full picture of this repository.

---

# ds4-rocm-kv-cache-q — ROCm FP8 KV-cache Quantization fork of DwarfStar (ds4)

## Overview

This repo is a fork of https\://github.com/kyuz0/ds4 ("DwarfStar"), a small native inference engine optimized for **DeepSeek V4 Flash** (also GLM 5.2 and, on very high-memory machines, DeepSeek V4 PRO). It is not a general GGUF runner — it is deliberately narrow for those model families. The fork's purpose is **ROCm (AMD GPU) fp8 KV-cache quantization** plus a REAP "compact runtime" for MoE expert pruning. Backends: **Metal** (primary, Macs ≥96 GB), **NVIDIA CUDA**, and **ROCm** on AMD Strix Halo systems.

- Current branch: feat/reap-compact-runtime
- Remotes: origin = shin902/ds4-rocm-kv-cache-q, kyuz0 = upstream ds4, reaped = eouya2/ds4-for-reaped
- Git narrative: main is the merge of PR "Rocm fp8 kv cache" (0a114a3); the branch merged upstream TurboQuant KV-cache support (3a58d24), added REAP compact runtime (bd3a1d3), K160 routing (8f95123), a persistent KV-cache quality benchmark (47b4bb8), and a batch-compression-ratio guard doc (14ef424).

## Architecture / Module map

- **ds4.c** (\~65k lines) — engine core: model load/bind, KV cache (CPU reference fp8/q8 pack/unpack), REAP metadata, decode/prefill orchestration.
- **ds4_cuda.cu** — CUDA kernels; **ds4_metal.m** — Metal kernels; **ds4_rocm.cu** **+** **rocm/*.cuh** — ROCm/HIP kernels.
- **ds4_server.c** — HTTP server with micro-batched decoding; **ds4_agent.c** — coding agent; **ds4_web.c** — web UI.
- **ds4_kvstore.c/h** — disk KV checkpoint store (persistent context); **ds4_ssd.c** — SSD streaming.
- **ds4_tp.c** **/** **ds4_distributed.c** — tensor/pipeline parallelism; **ds4_layer_pack.c** — packed tensor layout.
- **rax.c** — tensor/format helpers; **ds4_bench.c** **/** **ds4_eval.c** **/** **ds4_cli.c** — benchmarks, eval, CLI; **ds4_gpu_args.c** — GPU arena sizing.

## Build system

- Plain **Makefile** (cc -O3 -ffast-math -march=native -std=c99).
- make → ds4, ds4-server, ds4-bench, ds4-eval, ds4-agent.
- ROCm: make strix-halo (alias make rocm) → builds ds4_rocm.o, ds4_rocm_compat.o, ds4_rocm_unavailable.o with **HIPCC**, ROCM_ARCH ?= gfx1151, --offload-arch, -lhipblas -lhipblaslt, plus -DDS4_ROCM_BUILD.
- CUDA: NVCC with --use_fast_math, links cublas/cudart.

## KV Cache & fp8 quantization

**Compressed KV cache** (per-token row): [ n_nope E4M3 sign+magnitude bytes ][ n_blocks scale-exponent bytes ][ pad ][ n_rot F16 halves ], where n_nope = head_dim - n_rot, blocks are **64-wide**, each block scale is a **power of two** (2^e, exponent in a signed byte, e = ceil(log2(amax/448)), amax floored at 1e-4), and the **RoPE tail is kept at F16** (not quantized), matching the F16 rounding used for raw KV rows elsewhere.

- **CPU reference** — dsv4_fp8_kv_pack_row_cpu / dsv4_fp8_kv_unpack_row_cpu in ds4.c (\~line 3326/3361), using E4M3 amax/2^e-scale/round-to-even.
- **ROCm kernels** — rocm/ds4_rocm_fp8_kv.cuh (fp8_kv_pack_nonrope_kernel, fp8_kv_pack_rot_kernel, unpack variants; fp8_kv_quantize_kernel dequants in-place). The header requires **bit-for-bit consistency with the CPU reference** (checkpoint round trips + unit test).
- **Sibling formats** (also opt-in): --kv-cache-q8 (symmetric int8, F32 amax/127 scale per 64-block), TurboQuant --kv-cache-tq4 / --kv-cache-tq2 (centroid codebooks + data-oblivious sign-bit hash + Hadamard transform + F16 RMS), and the compressor kernels in rocm/ds4_rocm_compressor.cuh (ratio 2/4 KV compression, prefill/update pool kernels, shift_ratio4).
- **CLI flags**: --kv-cache-fp8, --kv-cache-q8, --kv-cache-tq4, --kv-cache-tq2 (also f16 baseline).

**Disk KV store** (ds4_kvstore.c/h): durable KVC checkpoints ('K''V''C', version 1, payload ABI 2) named by SHA-1 of the rendered byte prefix. Eviction is score-based with reasons **cold / continued / evict / shutdown / agent-system / agent-session**, a 6-hour hit half-life, min-tokens 512, cold-max 30000, continued-interval 10000, boundary trim 32 / align 2048 (matching the prefill-chunk schedule), and an anchor-score factor 2.0 for cold/evict/shutdown entries.

## ROCm-specific work

ROCM_KERNEL_OPTIMIZATION.md targets **Strix Halo / AMD Radeon 8060S**, \~94 GiB, model DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf. Key conclusions:

1. The \~80 GiB model leaves \~0 GiB for the **FP16 weight cache**, so --kv-cache-q8/fp8 is a **memory/long-context tuning knob, not a decode-speed knob**.
2. Goal priority: (1) long context without OOM, (2) prefill at small chunks (128–512), (3) decode improvements are bandwidth-limited (\~16–20 t/s ≈ 36–47% of the 256 GB/s theoretical).
3. The real speed lever is **small-chunk direct Q8/IQ2/Q2 kernels** in rocm/ds4_rocm_matmul.cuh, ds4_rocm_attention_launch.cuh, ds4_rocm_norm_rope.cuh, ds4_rocm_runtime.cuh — not FP16 cache or big-GEMM tuning.
4. Recommended first step: **stage/kernel-level profiling logs** before touching kernels.
5. rocm/ds4_rocm_attention_launch.cuh (commit 14ef424) documents the **batch compression-ratio guard**: multi-token batches require a nonzero ratio; ratio==0 is the sentinel for the single-token decode API, and the two contracts must not be conflated.

## What this fork uniquely adds (vs kyuz0/ds4)

- **ROCm fp8 KV-cache quantization** (the rocm-fp8-kv-cache PR merged into main).
- **TurboQuant KV-cache support** (merged from kyuz0/ds4, commit 3a58d24).
- **REAP compact runtime** (ds4.c \~line 6284 weights_apply_reap_metadata): reads GGUF metadata reap.enabled, reap.layout="ds4-compact-v1", and per-layer reap.layer.policy / expert_count / keep_count. Policies: NONE=0, HASH_PRESERVED=1, ROUTER_MASK_PRUNED=2, MOE_DISABLED=3. It prunes MoE experts per layer (keep/expert counts) and cannot disable **hash-routed** layers (il < DS4_N_HASH_LAYER). misc/COMPACT.md documents the separate agent-context compaction feature.
- **Persistent KV-cache quality benchmark** (tools/quality_bench.py, 601 lines) — A/B quality+performance harness: starts one ds4-server per variant (f16/fp8/q8/tq4/tq2), measures **quality** (output/hash) separately from **performance** (latency/throughput/cache), stdlib-only, safe alongside a live server on a different port.
- **K160 routing** on ROCm (rocm/ds4_rocm_router.cuh) and assorted ROCm fixes (IQ2 SSD prefill deadlock, large-model arenas, Q4 SSD expert staging, prequant decode restore).

## Tests / QA / benchmarks

- make test builds & runs ds4_test, ds4_agent_test, ds4-eval --self-test-extractors, q4k-dot-test, test_layer_pack, test_engine_mgpu_placement, test_gpu_args (+test_sampling on non-Mac).
- tests/ also has cuda_long_context_smoke.c, glm_long_context_smoke.sh, dspark_acceptance_fixture.sh, and test-vectors/ (official continuation vectors for regression).
- tools/test_quality_bench.py validates the quality harness; QA_BEFORE_RELEASES.md holds the release matrix incl. remote Metal/CUDA/ROCm machines; speed-bench/ holds benchmark charts/CSVs.

## Risks & notable observations

- **Bit-for-bit GPUↄCPU consistency is the correctness crux.** The fp8/q8/tq GPU kernels must exactly match the CPU references (ds4.c): any HIP log2f/exp2f/ceilf, f32_to_f16 rounding, or E4M3 round-to-even tie-breaking divergence breaks checkpoint round-trips. The fmaxf/fabsf on NaN and the 1e-4 amax floor are subtle edge cases worth a fuzz test.
- The fp8 quantize_kernel writes **dequantized F32 back in place** while the pack kernels write bytes — two paths that must agree.
- TurboQuant relies on a **data-oblivious hash + transform order** matching the CPU oracle; any change silently changes the format across layers.
- The compressor **ratio guard** is deliberately strict; the ratio==0 sentinel in the single-token decode path is an easy future foot-gun.
- The ROCM optimization doc mixes Japanese/Chinese phrasing with typos (author's working notes), but its strategic conclusion is sound: profile first, then tune small-chunk Q8/IQ2/Q2 prefill kernels.

**Bottom line:** this is an AMD-ROCm-focused DeepSeek V4 inference fork whose core contribution is a compact fp8/E4M3 compressed-KV cache (with Q8/TurboQuant siblings), CPUↄGPU-bit-exact packing, GPU-side KV compression, and a REAP MoE-pruning runtime — all aimed at keeping long contexts resident on a memory-tight 94 GiB Strix Halo.
