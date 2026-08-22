# DeepSeek V4 Flash SWE-bench harness

Pi SDKを共通 agent harness として使い、`cloud-fp`、`q2-reap`、`reap-*` のOpenAI互換endpointを同じSWE-bench instanceへ通すための最小環境です。既存のレポートとは独立したTypeScript実装です。

## セットアップ

Node.js 22.19以上（Pi SDK 0.84.2の要件）を使います。

```bash
npm install
cp .env.example .env
# configs/example.json のendpoint、モデル名、repositories、manifestを実環境に合わせて編集
npm run typecheck
```

Pi SDKのprovider catalogはrunnerが選択したvariantごとに一時生成します。普段の`~/.pi/agent`設定、skills、extensions、`AGENTS.md`は読み込みません。

## dry-run

実際のモデルへ接続せず、manifestを読み、variant/instanceごとのartifactとgrader用predictions JSONLを生成します。

```bash
npm run bench -- --config configs/example.json --mode dry-run --variant cloud-fp,q2,reap-* --limit 1
# または
npm run dry-run
```

`--variant reap-*` のようなprefix wildcardでREAP群をまとめて選択できます。

## 固定20問セット

`configs/swebench-verified-20.jsonl` は SWE-bench Verified revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a` の500問から、固定seedによるSHA-256順位で選んだ20問です。再現条件とinstance一覧は `configs/swebench-verified-20.lock.json` に記録しています。対応configは `configs/swebench-verified-20.json` です。

参照リポジトリは既定で `~/benchmarks/swebench-repos/` 以下を使用します。endpointを起動・設定した後、まず1問で疎通します。

```bash
npm run bench -- \
  --config configs/swebench-verified-20.json \
  --variant q2-reap \
  --instance django__django-11163
```

## 実行

各instanceは選択variantごとに独立したgit cloneを作り、そのcloneをPi SDKの`cwd`に設定します。Pi sessionは毎回`SessionManager.inMemory(cwd)`で新規作成され、tool、system prompt、thinking level、retry/compaction設定はconfigで固定されます。

```bash
npm run bench -- \
  --config configs/example.json \
  --variant q2 \
  --instance django__django-00001
```

実行前に以下を編集してください。

- `configs/example.json` の `repositories` をローカルgit checkoutへ向ける
- `configs/example-manifest.jsonl` をdataset revisionを固定したSWE-bench manifestへ置き換える
- 各variantの`baseUrl`、`model`、`apiKeyEnv`/`apiKey`を設定する
- `cloud-fp`など外部サービスは同じモデル設定・sampling設定になるようendpoint側も固定する

長時間の実験は、agentをコンテナ内で実行するなどホストから隔離してください。Piのbash toolは指定cwdを初期位置にしますが、OSレベルのsandboxではありません。

## 保存物

variantごとに`outputDir/<variant>/`へ保存します。instanceごとのartifactには以下が含まれます。

```text
run.json          実行条件（秘密鍵はconfigに直書きしない）
events.jsonl      Pi session event stream
trajectory.jsonl  Pi messages（1行1message）
usage.json        input/output/cache tokenとcostの集計
timing.json       duration、turn数、timeout/turn-limit
patch.diff        git diff --binary
git-status.txt     終了時のgit status
```

variant直下の`predictions.jsonl`はSWE-bench graderに渡すための最小形式です。

```json
{"instance_id":"...","model_name_or_path":"q2","model_patch":"diff --git ..."}
```

SWE-benchのバージョンによってCLI引数が異なるため、使用するpinned revisionの公式graderに合わせてください。典型例は次の形です。

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path runs/example/q2/predictions.jsonl \
  --run_id deepseek-q2
```

graderのresolved結果はこのrunnerの`timing.json`へ書き戻さず、predictionsとgrader出力を別管理します。

## CLI

```text
--config <path>       JSON config（default: configs/example.json）
--variant <a,b,...>   variant選択。allまたはreap-*対応
--instance <id,...>   instance選択
--limit <n>           manifest先頭n件
--mode run|dry-run    実行または計画/artifact検証
--env-file <path>     KEY=VALUE形式のenvファイル
```

比較を再現するにはdataset manifest、model endpoint/checkpoint、Pi package version、config、grader revisionを記録し、同じmanifestを全variantへ渡してください。
