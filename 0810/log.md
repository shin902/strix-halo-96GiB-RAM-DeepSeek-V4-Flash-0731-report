# 今日やったこと
- MTPを実装（MTPヘッダも160エキスパートでやる）
- 検証した（ノーマルのほうが今のところ速度出る）
  - ただ、検証フェーズがクソ重いので、accept率が100％でも逆転しないそうな、、、
  - 今後カーネル最適化しないとな、、、
- ベンチマークツール作った


# ただ、MTPカーネルはまだ発展途上、、、
現時点で**実際にMTP推論まで成功しているGGUF**はこれです。

```text
DeepSeek-V4-Flash-0731-K160-REAP-MTP-IQ2XXS-w2Q2K-AttnQ8-SExpQ8-ROCm.gguf
```

### 現在の対応状況

| MTP GGUF | 状態 |
|---|---|
| `...MTP-IQ2XXS-w2Q2K-AttnQ8-SExpQ8-ROCm.gguf` | **動作確認済み** |
| `...MTP-Q8_0-ROCm.gguf` | ロード成功。ただしdraft graph実行は毎回失敗 |
| `...MTP-BF16.gguf` | 現在のlegacy MTP検証条件では非対応 |
| `...MTP-ExpertsBF16-AttnQ8-SExpQ8.gguf` | 未確認。BF16部分はlegacy MTP条件と不整合の可能性あり |

コード上、MTPの以下の主要テンソルは基本的に`Q8_0`固定です。

- `e_proj`
- `h_proj`
- MTP attention projection
- shared expert

routed expert部分のvalidation上は以下を受け付けます。

```text
Q8_0
IQ2_XXS
Q2_K
Q4_K
Q5_K
Q6_K
```

ただし、**validationを通ることと、実際にROCm MTP graphで動くことは別**です。今回のQ8_0版はロードは通りましたが、draft実行が108/108回失敗しました。

したがって、現状の実用上の回答は：

> `IQ2_XXS` routed expert + `Q2_K` MTP routed expert構成のGGUFだけが動作確認済み

です。
