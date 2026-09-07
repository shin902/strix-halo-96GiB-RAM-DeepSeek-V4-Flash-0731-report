# llama.cpp Vulkan: prefill-chunk sweep 実測レポート

- 実施日: 2026-08-24
- 対象: `llama.cpp` の `build-vulkan/bin/llama-server`
- 測定対象: prompt eval の throughput（prefill TPS）
- 生データ: [`../prefill-chunk-raw/`](../prefill-chunk-raw/)

## 結論

この版の llama.cpp には `prefill-chunk` という専用CLIオプションはないため、本レポートでは `-ub / --ubatch-size` を prefill の物理チャンク上限として比較した。

指定条件の基準値 `-ub 512` は **102.89 tokens/s** だった。

| `-ub`（prefill chunk として扱う値） | 平均 prefill TPS | `-ub 512` 比 | 平均 prompt eval 時間 |
|---:|---:|---:|---:|
| 128 | 61.93 | -39.8% | 19,909 ms |
| 256 | 77.38 | -24.8% | 15,936 ms |
| **512** | **102.89** | **基準** | 11,984 ms |
| 1024 | 127.04 | +23.5% | 9,706 ms |
| **2048** | **160.21** | **+55.7%** | 7,696 ms |

このプロンプトでは `-ub 2048` が最速で、`-ub 512` から **約1.56倍**、`-ub 128` から **約2.59倍** になった。ただし `-ub 1024` と `2048` では Vulkan の pinned memory allocation warning が出ているため、実運用での採用にはメモリ使用量の追加確認が必要である。

## 1. prefill-chunk の定義

llama.cpp のヘルプ上、該当する設定は次の通り。

- `-b 2048`: logical batch size
- `-ub N`: physical batch size。1回の処理で扱える token 数の上限

したがって、ここでは `-ub` を便宜上 `prefill-chunk` と呼ぶ。ただし `-ub` は厳密な固定チャンク長ではなく、入力の残り token 数、内部の batch allocator、モデルのグラフ構成によって実際の処理単位は変わり得る。

今回の prompt は 1,233 tokens なので、理論上の物理チャンク数は次の通り。

| `-ub` | 1,233 tokens の分割数 |
|---:|---:|
| 128 | 10（最後は81 tokens） |
| 256 | 5（最後は209 tokens） |
| 512 | 3（最後は209 tokens） |
| 1024 | 2（最後は209 tokens） |
| 2048 | 1 |

## 2. モデル

- ファイル:
  `/mnt/data/DeepSeek-V4-Flash-0731-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-imatrix.gguf`
- ファイルサイズ: 86,720,111,520 bytes（約80.76 GiB）
- SHA-256:
  `0b39f9c337d6b49c77db2190556b8563abf3c5fbb98be3b58cf8d3a1db191e5f`
- GGUF architecture: `deepseek4`
- GGUF name: `DeepSeek V4 Flash`
- size label: `256x8.4B`
- quantization: `IQ2_XXS`, 2.0625 bpw
- block count: 43
- expert count: 256
- experts used per token: 6
- shared expert count: 1
- GGUF metadata context length: 1,048,576
- tokenizer: `gpt2`
- `tokenizer.ggml.add_bos_token`: `false`

## 3. ソフトウェアと実行環境

### llama.cpp

- repository: `/home/shi/ghq/github.com/ggml-org/llama.cpp`
- commit: `c060ca974c773c7c3d17fd1b66dc9d312bc292c0`
- short commit: `c060ca974`
- build: `0.2.0-dev (build 10603, commit c060ca974)`
- compiler: GNU 16.2.1, Linux x86_64

### ハードウェア

- CPU: AMD Ryzen AI MAX+ 395 w/ Radeon 8060S
- CPU: 16 cores / 32 threads
- GPU: AMD Radeon 8060S Graphics (RADV STRIX_HALO)
- GPU type: integrated GPU / UMA
- Vulkan API: 1.4.354
- Vulkan driver: RADV, Mesa 26.2.1-arch1.1
- OS: EndeavourOS rolling
- kernel: Linux 7.1.9-arch1-2 x86_64
- メモリ: 96 GiB 構成。実行時の `free` 表示は 91 GiB

## 4. 実行コマンド

ユーザー指定の llama-cli 条件を基本にし、HTTP API で timing を取得しやすい llama-server を使用した。`-ub` だけを 128, 256, 512, 1024, 2048 に変更し、それ以外は固定した。

```bash
build-vulkan/bin/llama-server \
    -m /mnt/data/DeepSeek-V4-Flash-0731-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-imatrix.gguf \
    -ngl 99 \
    -fa on \
    -c 100000 \
    -b 2048 \
    -ub ${UB} \
    -ctk q8_0 \
    -ctv q8_0 \
    -np 1 \
    --no-cont-batching \
    --no-cache-prompt \
    --no-ui \
    --host 127.0.0.1 \
    --port ${PORT}
```

`llama-server` のリクエストは次の JSON を使用した。

```json
{
  "prompt": "固定プロンプト本文",
  "n_predict": 0,
  "cache_prompt": false,
  "timings_per_token": true,
  "seed": 1
}
```

各 `-ub` について、次の手順で測定した。

1. `-np 1` でサーバーを起動
2. `/health` が 200 になるまで待機
3. 同じ prompt を1回実行してウォームアップ。結果は集計から除外
4. 同じ prompt を2回実行
5. response の `timings.prompt_ms` と `timings.prompt_per_second` を保存
6. `-ub` を変えるたびにサーバーを終了し、再起動

`n_predict=0` を指定したが、このbuildのresponse JSONには `predicted_n=1` と表示されるケースがある。`predicted_ms` は約0.001 msで、prefillの `prompt_ms` には実質的な影響がないため、TPS計算には prompt timing だけを使った。

サーバーログ上の effective context slot は `n_ctx_slot = 100096` だった。これは要求値 100000 が内部で丸められた値である。

## 5. プロンプト

### プロンプトの構成

固定 prompt は 4,428 bytes、104 lines で、SHA-256 は次の通り。

`7091b85ad584cd0ef11eba8f4c627459805d97ed2cbd466c4ef032e864666b4b`

正確な prompt 本文は [`prefill-chunk-raw/request.json`](../prefill-chunk-raw/request.json) の `prompt` フィールドに保存している。

構成は以下の通り。

1. 固定ヘッダ:
   `This is a fixed benchmark input corpus for measuring prompt processing...`
2. `llama.cpp` の `docs/build.md` の先頭 2,500 bytes
3. `llama.cpp` の `tools/cli/README.md` の先頭 1,500 bytes
4. 固定フッター:
   `Question: What is the main purpose of this corpus? Answer in one short sentence.`

プロンプト本文は、ベンチマーク入力として扱うよう明示した上で、llama.cpp の build/CLI ドキュメント断片を読み込ませる内容である。チャットテンプレートを使った会話ではなく、plain completion の prompt として評価した。

### token 数

`build-vulkan/bin/llama-tokenize` で同じモデルの tokenizer を使って確認した結果:

- prompt tokens: **1,233**
- 全設定で server response の `tokens_evaluated`: **1,233**
- 全設定で `truncated`: `false`
- 全設定で timing の `cache_n`: **0**、`prompt_n`: **1,233**

raw response の `tokens_cached` は 1,233 と表示されるが、prompt timing の `cache_n` は 0 であり、各測定で prompt 全体を処理している。サーバー側と request 側の両方で prompt cache を無効にした。

## 6. 実測結果

集計対象は warmup を除く2回。TPS は次で計算される値を採用した。

```text
prefill TPS = prompt_n / (prompt_ms / 1000)
```

| `-ub` | 分割数 | run 1: prompt ms | run 1: TPS | run 2: prompt ms | run 2: TPS | 平均 TPS | 512 比 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 128 | 10 | 19,850.305 | 62.115 | 19,968.262 | 61.748 | **61.931** | -39.8% |
| 256 | 5 | 16,059.383 | 76.778 | 15,812.736 | 77.975 | **77.376** | -24.8% |
| 512 | 3 | 11,985.285 | 102.876 | 11,982.494 | 102.900 | **102.888** | 0.0% |
| 1024 | 2 | 9,693.101 | 127.204 | 9,718.526 | 126.871 | **127.037** | +23.5% |
| 2048 | 1 | 7,702.554 | 160.077 | 7,689.433 | 160.350 | **160.213** | +55.7% |

### run 間のばらつき

2回のみなので統計的な確定値ではないが、run 間の標準偏差は次の通りだった。

| `-ub` | TPS 標準偏差 | 変動係数 |
|---:|---:|---:|
| 128 | 0.259 | 0.419% |
| 256 | 0.847 | 1.094% |
| 512 | 0.017 | 0.016% |
| 1024 | 0.235 | 0.185% |
| 2048 | 0.193 | 0.121% |

## 7. 観測事項と注意点

### `-ub` を大きくすると prefill TPS は単調に上がった

今回の 1,233-token prompt では、`-ub` を2倍にするたびにTPSが上がった。

- 128 -> 256: +24.9%
- 256 -> 512: +33.0%
- 512 -> 1024: +23.5%
- 1024 -> 2048: +26.1%

少なくともこの入力長では、物理チャンクを大きくして1回の graph execution に渡す token 数を増やすことが、prefill throughput に明確な効果を持つ。

### 大きい `-ub` では Vulkan warning が出た

`server-ub-1024.log` と `server-ub-2048.log` では、モデルロード時に次の warning が各2回出た。

```text
ggml_vulkan: Failed to allocate pinned memory
(Requested buffer size exceeds device buffer size limit: ErrorOutOfDeviceMemory)
```

warning が出てもサーバーはロード成功し、全 request は正常終了した。`-ub 128, 256, 512` ではこの pinned memory warning は確認されなかった。従って `-ub 2048` は速度だけなら最良だが、メモリ余裕を含めた最適値とはまだ断定できない。

### 一部の DeepSeek V4 fused op は無効化されている

全設定で次の Vulkan resolve warning が出た。

- Lightning Indexer: unsupported, disabled
- fused DeepSeek V4 HC pre: unsupported, disabled
- fused DeepSeek V4 HC comb: unsupported, disabled
- fused DeepSeek V4 HC post: unsupported, disabled

また `-ngl 99` は全ての処理が GPU 上で動くことを意味しない。今回の結果は、これらの fused op が使われない現行 `build-vulkan` の実装状態での値である。

## 8. まとめ

この環境と 1,233-token の固定 prompt に限ると、ユーザー指定の `-ub 512` は 102.89 tok/s、`-ub 1024` は 127.04 tok/s、`-ub 2048` は 160.21 tok/s だった。

実用上の読み方は次の通り。

- 最大 prefill throughput が目的なら、今回の範囲では `-ub 2048`
- `-ub 512` から `-ub 1024` へ上げるだけでも +23.5%
- `-ub 2048` は `-ub 512` より +55.7% だが、pinned memory warning がある
- `-ub 512` は warning がなく、ユーザー指定条件の基準として再現しやすい
- decode latency、複数リクエストの公平性、RAM/GTT 使用量を含めると、最適値は別になる可能性がある

従って、今回の単一 prompt の prefill throughput だけで選ぶなら `2048`、メモリ余裕と安全性を優先する暫定運用値なら `512` または `1024` を候補にする。次の正式評価では、同じ `-ub` sweep を 8k/32k/64k/100k tokens の prompt 長でも行い、RSS/GTT、TTFT、decode TPS、複数 slot の throughput を併記する必要がある。

## 9. 生データ

同じリポジトリの [`prefill-chunk-raw/`](../prefill-chunk-raw/) に保存している。

- `results.jsonl`: warmup と測定2回分の集計行
- `run-1-ub-*.json`: 1回目の完全な server response
- `run-2-ub-*.json`: 2回目の完全な server response
- `warmup-ub-*.json`: warmup の完全な server response
- `request.json`: prompt と request parameters
- `health-ub-*.json`: 各 server の health response
- `server-ub-*.log`: 各設定の effective context、warning、timing log
- `driver.stderr`: ベンチマーク driver の実行記録

このレポートの平均値は `run-1-ub-*.json` と `run-2-ub-*.json` の `timings.prompt_per_second` から再計算できる。

## 10. 限界

- 各設定の本測定は2回だけであり、長時間の中央値・信頼区間ではない。
- prompt は 1,233 tokens で、長文 prompt や context position に対する性能を代表しない。
- prefill TPS のみを測定し、生成 TPS は測定していない。
- `-ub 1024` と `2048` の warning による実際の fallback allocation とメモリ量は未計測。
- GPU clock、電力制限、他プロセスの影響を固定していない。
- `-fa on` は指定したが、fused DeepSeek V4 op の一部は backend support 不足で無効化されている。
- したがって結論は、記載した commit、モデル、Vulkan driver、prompt、context、batch、server mode に限定する。
