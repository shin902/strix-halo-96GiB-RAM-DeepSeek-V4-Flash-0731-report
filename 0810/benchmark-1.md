## 実測レポート

### 条件

- Backend: ROCm / Radeon 8060S (`gfx1151`)
- Target model: `DeepSeek-V4-Flash-0731-K160-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-imatrix.gguf`
- MTP model: 指定された  
  `DeepSeek-V4-Flash-0731-K160-REAP-MTP-IQ2XXS-w2Q2K-AttnQ8-SExpQ8-ROCm.gguf`
- Context: 100,000
- KV cache: `--kv-cache-tq4`
- Temperature: `0`
- Environment: `DS4_CUDA_NO_Q8_F16_CACHE=1`
- 生成上限: 256 tokens（実際には回答終了により約128 tokens）
- Prefill prompt: speculative decoding の説明を要求する固定プロンプト

指定ファイルは単体のtarget modelではなく、`--mtp`で読み込むMTP support GGUFとして検出されました。

### TPS

| 設定 | Prefill | Generation | MTPなし比 |
|---|---:|---:|---:|
| MTPなし | 39.49 t/s | **16.23 t/s** | — |
| `--mtp-draft 1` | 39.65 t/s | **16.24 t/s** | +0.1% |
| `--mtp-draft 2` | 40.98 t/s | **14.94 t/s** | **−8.0%** |
| `--mtp-draft 3` | 40.74 t/s | **5.96 t/s** | **−63.3%** |

### Acceptance

| Draft数 | Draft試行 | 提案token数 | Accepted token数 | Acceptance率 | Accepted tokens / cycle |
|---:|---:|---:|---:|---:|---:|
| 1 | MTP speculation無効 | — | — | — | — |
| 2 | 60 | 120 | 48 | **40.0%** | **0.80** |
| 3 | 67 | 198 | 66 | **33.3%** | **0.985** |

`--mtp-draft 1` は現在の実装上、投機実行が無効になり、実質的にMTPなしと同じ動作です。

### Draft時間 vs Target verification時間

| Draft数 | Draft時間 | Target verification | 備考 |
|---:|---:|---:|---|
| 2 | 約4.55 ms | 平均88.4 ms | 1 token accept時 約67.2 ms、2 token accept時 約124.2 ms |
| 3 | 約9.14 ms | 約313.7 ms | さらにpartial accept時 replay 約65〜275 ms |

MTP draft 2では、2 tokenの完全acceptでもverificationだけで約124 msかかり、通常decode 1 token相当の約62 msを大きく上回っています。

Draft 3ではverificationが約314 ms、partial acceptではreplayも加わるため、MTPなしより大幅に遅くなりました。

## 結論

この環境・モデル・設定では、

- Draft 2: acceptance率40%だが、verificationコストが高く **約8%遅い**
- Draft 3: accepted tokens/cycleは増えるが、verificationとreplayコストが大きく **約63%遅い**
- 速度面では `--mtp-draft 1`、つまりMTPなし相当が最速

という結果になりました。ROCmの現在のverification実装では、acceptance率だけではverificationコストを回収できていません。
