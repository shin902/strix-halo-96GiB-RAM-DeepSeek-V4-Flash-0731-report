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
# 正式Web 30問セットを使う既定dry-run
npm run dry-run

# example configを使う場合は明示する
npm run bench -- --config configs/example.json --mode dry-run --variant cloud-fp,q2,reap-* --limit 1
```

`npm run dry-run` は `configs/swebench-multilingual-web-30.json` を使います。一方、CLIの `--config` 省略時は従来互換のため `configs/example.json` のままです。`--variant reap-*` のようなprefix wildcardでREAP群をまとめて選択できます。

## 正式Web 30問セット

正式評価には、SWE-bench MultilingualのうちJS/TS・フロントエンド/Web系OSSの4 repositoryから、pinned datasetの全30問を使います。

- `preactjs/preact`: 17問
- `vuejs/core`: 5問
- `facebook/docusaurus`: 5問
- `mrdoob/three.js`: 3問

対応ファイルは `configs/swebench-multilingual-web-30.json`、`configs/swebench-multilingual-web-30.jsonl`、`configs/swebench-multilingual-web-30.lock.json` です。datasetは `SWE-bench/SWE-bench_Multilingual` の `default` / `test`、revision `846e647b9f33c0b51b739d005d13d85493c9af09` に固定しています。lockには取得元ParquetのURL・SHA-256、選択方法、repo別件数、順序付きinstance ID、manifestの内容ハッシュを記録しています。

モデルへ渡すmanifestはharnessに必要な `repo`、`instance_id`、`base_commit`、`problem_statement` だけを含みます。gold `patch`、`test_patch`、`eval_script` は含めていないため、問題文以外の正解情報をモデル入力へ渡しません。

各repositoryのbase commitを取得済みcheckoutとして、既定では以下へ配置します。

```text
~/benchmarks/swebench-repos/preact
~/benchmarks/swebench-repos/vue
~/benchmarks/swebench-repos/docusaurus
~/benchmarks/swebench-repos/three.js
```

endpointを起動・設定した後、まず正式セットの1問で疎通します。

```bash
npm run bench -- \
  --config configs/swebench-multilingual-web-30.json \
  --variant q2-reap \
  --limit 1
```

全variant（cloud-fp、q2、q2-reap）を正式セットへ通す場合は、`--limit`を付けずに実行します。

## 旧セット（正式スコアには使用しない）

既存のSWE-bench Verified固定20問とSymPy 1問は削除・改名せず、pilot / smoke test / harness回帰確認用として残します。正式なWeb系比較の問題数やresolved率へ混ぜません。

`configs/swebench-verified-20.jsonl` は SWE-bench Verified revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a` の500問から、固定seedによるSHA-256順位で選んだ20問です。再現条件とinstance一覧は `configs/swebench-verified-20.lock.json` に記録しています。対応configは `configs/swebench-verified-20.json` です。

SymPyのE2E疎通確認には `configs/swebench-verified-single-sympy-12481.json` と `configs/swebench-verified-single-sympy-12481.jsonl` を使います。

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
  --dataset_name SWE-bench/SWE-bench_Multilingual \
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
