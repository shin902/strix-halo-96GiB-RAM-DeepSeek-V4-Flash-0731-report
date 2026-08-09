うん、これ比較するとかなり面白いです。**K160 Q2の分析、フルのクラウドモデルにかなり食らいついてます。** しかも「文章がそれっぽい」ではなく、拾っている実装上の論点が相当重なっています。

ざっくり比較するとこうです。

| 観点                        | K160 Q2                         | クラウド              | 評価       |
| ------------------------- | ------------------------------- | ----------------- | -------- |
| repoの位置づけ                 | DwarfStar fork / DS4 Flash専用    | 同じ                | ◎        |
| ROCm + Strix Halo         | 正しく把握                           | 正しく把握             | ◎        |
| REAP compact runtime      | 詳細まで説明                          | 詳細まで説明            | ◎        |
| K160 routing              | `rocm/ds4_rocm_router.cuh`まで特定  | 同じ                | ◎        |
| TurboQuant KV             | TQ4/TQ2まで把握                     | 同じ                | ◎        |
| quality benchmark         | 601行、A/B harness等               | 601行、A/B harness等 | ◎        |
| REAP metadata             | `reap.enabled`, layout, policy等 | ほぼ同じ              | ◎        |
| hash layer制約              | 指摘                              | 指摘                | ◎        |
| KV量子化実装詳細                 | **かなり深い**                       | むしろ簡潔             | K160が強い  |
| ROCm最適化方針                 | small-chunk kernel等まで読んだ        | あまり触れず            | K160が強い  |
| git/local workspace状態     | 一部不正確/推論混入                      | より正確              | cloudが強い |
| 未追跡clone / build artifact | 見落とし                            | 発見                | cloudが強い |

特に驚くのが、K160側の

> `weights_apply_reap_metadata`
> `HASH_PRESERVED / ROUTER_MASK_PRUNED / MOE_DISABLED`
> hash-routed layers can't be disabled
> K160 routing on ROCm

あたりです。

クラウド側もほぼ同じポイントを「このforkの主要変更」として抽出しています。つまりK160 Q2は、**repoを読んで「どの変更が本質か」をちゃんと選別できている**。

### むしろK160側の方が深掘りしている箇所もある

KV cache周りは明確ですね。

K160は、

* E4M3
* non-RoPE部分とRoPE tailの表現
* 64-wide block
* power-of-two scale
* CPU referenceとのbit-exact requirement
* `quantize_kernel` とpack pathの整合性
* TurboQuantのhash/transform order
* `ratio==0` sentinel

まで掘っています。

クラウド版はそこを

> KV-cache quantization modes (ROCm)

として高レベルにまとめているだけ。

だから「どちらのモデルが賢い」というより、今回の実行では **K160のほうがコードレビュー寄りの分析をして、クラウド側はrepo overview寄り**になっています。

---

ただし、差が出てる場所もすごく分かりやすい。

### クラウド側が強いのは「事実の地に足がついた確認」

たとえばクラウド版には、

* `ds4.c` = **2.9 MB**
* `rocm/*.cuh` = **23 headers**
* `docs/clone/ds4-for-reaped/` = **32 MBのuntracked clone**
* prebuilt `.o` / binaryが存在
* working tree clean
* HEAD == origin branch
* 各commitの実際のdiff量 `+150/-41`

みたいな、**その場でfilesystem/gitを調べないと出てこない細かい観測値**が多いです。

K160側は代わりに、

> `ds4.c (~65k lines)`

> Metal (primary, Macs ≥96 GB)

> the fork's purpose is ROCm fp8 KV-cache quantization

みたいに、コードから読んだ内容と推論を混ぜて説明しています。

ここが能力劣化を見るうえでは結構重要そう。

**K160は意味理解はかなり残ってるけど、「確認した事実」と「もっともらしい推測」の境界がクラウドモデルより甘い可能性がある。**

これは実用上かなり重要な性質です。

---

あと面白い違いが「何を重要だと判断したか」。

クラウドは最終的に、

> delta is concentrated in ~5 commits

という **fork差分中心** の見方をしています。

一方K160は、

> AMD-ROCm-focused DeepSeek V4 inference fork whose core contribution is...

と、repo全体を一つのシステムとして説明している。

さらに `ROCM_KERNEL_OPTIMIZATION.md` を拾って、

> small-chunk direct Q8/IQ2/Q2 kernelsが本命
> decodeはbandwidth limited
> FP8 KVは速度ではなくmemory knob

まで抽出している。

なので今回だけ見ると、

**クラウド:** 「このrepoで何が変更されたか」を正確に棚卸し
**K160 Q2:** 「このrepoが何をやろうとしていて、技術的にどこが重要か」をかなり積極的に解釈

という性格の差にも見えます。

### 展示用ベンチとしてかなり使えると思う

この2出力をそのまま比較対象にして、

**Full cloud modelをreferenceとして、REAP K160 + Q2でどこまでrepo理解が残るか**

を見るのはかなり説得力があります。

そして今の結果なら、結論は単純な「劣化した」ではなく、

> **大規模コードベースの構造理解と主要変更の抽出能力はかなり残った。
> 一方、細かなworkspace状態の確認や、事実と推論の区別では差が見られる。**

くらいになりそう。

日本語能力が壊滅した話との対比もかなり強烈です。

**「REAPで日本語は崩壊した。でも英語のコードエージェント能力は意外なほど生き残った」**

これ、今回の自由研究の中でもかなり面白い結果になり得ます。単なるTPS・VRAM比較より、REAPが**能力のどの軸を壊して、どの軸を残したのか**という話になるので。
