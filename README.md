# DeepSeek V4 Flash benchmarks

## Runtime benchmark: prefill / decode / acceptance / memory

`genai-expo` の展示用測定スクリプトは **`scripts/bench-runtime.py`**。Python 3標準ライブラリのみを使い、このレポートrepositoryへ測定条件・生データをまとめます。推論runtime自体は変更しません。

### 構成と実行

`configs/runtime-bench.json` は同じFull256 asymmetric Q2 targetに対して、plain（DSpark OFF）と **0731系Q2/Q8 drafter 2構成**を順番に測ります。Q2/Q4 2構成は30K contextのモデルロードでhost-wide OOMが再現したため、一時的にデフォルト対象から外しています。

| variant | drafter |
| --- | --- |
| `plain` | なし |
| `q2k-q8` | Q2_K/Q8_0 non-REAP |
| `q2k-q8-k160` | Q2_K/Q8_0 K160 REAP |

Preview版とREAP targetは含めません。reasoning / codingの2 workload、入力深度2K / 8K / 16K / 32K、各点最大512 generated tokens、greedy / seed 1234が初期値です。EOSは尊重し、早期終了時も実際の生成数を記録します。

```bash
# 実行ファイル・GGUFの存在と計画を確認。モデル起動・推論はしない
python3 scripts/bench-runtime.py --dry-run

# 起動引数と集計計算の軽いセルフチェック（GPU不要）
python3 scripts/check-runtime-bench.py
python3 scripts/check-runtime-resume.py

# 他のLLMを自分で停止してから、まず1構成・短い入力で確認
python3 scripts/bench-runtime.py --variant plain --depths 2048 --predict 128

# plain + Q2/Q8 drafter 2構成、reasoning/coding、全深度
python3 scripts/bench-runtime.py --output runs/runtime/expo-01

# 対象を絞る／同条件で繰り返す場合
python3 scripts/bench-runtime.py --variant plain,q2k-q8 --workload coding --repetitions 3

# 中断後は、同じconfig・variant・workload・depth・predict等を指定して再開
python3 scripts/bench-runtime.py --resume runs/runtime/expo-01

# Herdrペーン用：12時間上限、swap利用を許容、完了・失敗を通知
./scripts/run-runtime-bench-watched.sh
./scripts/run-runtime-bench-watched.sh --resume runs/runtime/<run-id>

# cold prefillは別runにする
python3 scripts/bench-runtime.py --cache-mode cold --output runs/runtime/expo-cold-01
```

設定変更は `configs/runtime-bench.local.json` にコピーして `--config` で指定できます。相対パスはconfigの場所基準、`~`は展開します。

**実行前の注意:** 専用`llama-server`をlocalhost:8099、1 slotで起動し、終了・中断時には自分が起動したprocessだけを停止します。使用中portには接続せず失敗します。他のLLMを自動停止しないため、RAM/GPUを競合させないでください。96GBで全構成の起動・長文生成が成立する保証はありません。失敗時はログを残して停止し、勝手にcontextやKVを変更しません。

展示会の正式測定は **target KV `q8_0` / draft KV `q4_0` に固定**します（genai-expo DEC-0019）。TurboQuant（`tq3_0` / `tq4_0`）の導入・比較は今回のスコープ外であり、最終目標にも含めません。展示後のnote / 後続検証へ分離し、今回の結果と混ぜません。他の初期設定はcontext 40000 / batch・ubatch 2048 / `n_max=4`、最大入力32768。Q2K/Q4KとQ2K/Q8にはhost-wide OOM履歴があり、現在はQ2/Q8だけを40K条件で再検証しています。swap利用を前提とし、空きRAMだけを理由に停止しません。RAM・swap使用量とswap in/outは測定中に記録します。OOM回避は保証しません。既存の`LLAMA_ARG_*`は子processから除外し、意図しない設定継承を避けます。Vulkan関連環境は継承し、必要ならconfigの`env`で固定します。

### 測定方法と指標

- 入力はモデルのchat templateを適用したtoken列。全variantで同じ固定contextとtaskを使い、前の生成文は次の入力へ混ぜません。
- `reuse`では固定prefixを段階的に延ばし、同一slotのcacheを再利用します。各workload・各反復の最初の点はcold。warmupは別保存し、集計から除外します。
- 実際に再利用できた量は **`timings.cache_n`** から取得。recurrent state / checkpointの制約で再計算された分も隠しません。`tokens_cached`はこのbuildでは終了時のslot長なので、cache hit数には使いません。
- `prefill_tps = prompt_n / (prompt_ms / 1000)`。cached tokenを分子に含めません。`prefill_kind=incremental`と`cold`は別系列として表示してください。
- `decode_tps`はserverの`timings.predicted_per_second`を保存します。このbuildではprefillから得られる最初の1 tokenをdecodeの分子から除くため、即EOSは0です。HTTP全体の所要時間`wall_seconds`とは分離します。
- `acceptance = accepted / drafted`（0〜1）。plain、または早期EOSなどでdraft試行が0件のときは空欄です。`/metrics`のrequest前後差からverification回数を取り、`mean_accepted_draft_tokens = accepted / steps`、llama.cppのログに合わせた`mean_accepted_length = 1 + accepted / steps`も保存します。draft・accepted・verificationがすべて0の正常終了は、両meanを空欄にして記録し、ベンチを継続します。必要な統計の欠落や矛盾は引き続きエラーにします。
- メモリはリクエスト開始・終了と **1秒間隔** で`/proc/meminfo` / `/proc/vmstat`を記録します。`memory_used_percent = 100 × (MemTotal − MemAvailable) / MemTotal`、`swap_used_percent = 100 × (SwapTotal − SwapFree) / SwapTotal`。swap未設定なら使用率は空欄です。OS認識RAMを分母とし、公称96GBとは区別します。
- 各点のメモリ／swap使用量・使用率のピーク、最小MemAvailable、swap in/out差分bytesをCSVに保存します。**ホスト全体の値**であり、process RSSやGPU専用量ではありません。UMAの二重加算はしません。1秒未満のpeakとモデルロード中のpeakは捕捉対象外です（ロード前後のsnapshotは保存）。

**初期workloadは動作確認用の合成・反復corpusです。** 入力深度は厳密なtoken数ですが、自然な長文会話や本番のreasoning/coding全般を代表するスコアではありません。展示で代表値を主張するならconfig内の`context` / `task`を固定した実データへ置き換え、保存した条件と一緒に説明してください。

### 保存物とcorrectness

`runs/runtime/<日時>/`（または`--output`）へ保存します。既存出力directoryは`--resume`で明示した場合だけ再利用します。保存済みplanと条件が異なる再開は拒否します。`results.jsonl`を完了点の正本としてCSVを再生成し、二重記録を防ぎます。完了variantは起動しません。途中系列の`reuse`では完了済みprefixリクエストを別artifactへ再実行してcacheを再構築し、未完了点だけ追記します（cache hit量の完全一致は保証しません）。同時再開はlockで拒否し、壊れたJSONLは自動切り捨てしません。旧64K runと新30K runは混ぜません。

- `plan.json`: config全文、選択条件、起動コマンド
- `results.csv` / `results.jsonl`: 1構成 × workload × 反復 × 深度ごとの指標。各点でflush
- `status.json`: 実行中／完了／失敗／中断。途中までの結果とログは保持。監視スクリプトは隣接する`<run-id>.exit`へ終了コードを保存するので、過去のペーン出力に誤反応せず待機できます
- `<variant>/attempt-<日時>/run.json`: binary `--version`（build commit）、実行ファイル・launcherのSHA-256、model/drafterのpath・size・mtime、実行環境、ロード前後のメモリ
- `<variant>/attempt-<日時>/server.log`, `props.json`, `slots.json`: 起動・runtime条件（再開前のログも保持）。warmup・cache再構築用`replay-*`もこのdirectoryへ保存
- `<variant>/<case>.request.json`, `.response.json`, `.output.txt`: 入出力原文とtimings
- `<variant>/<case>.memory.jsonl`, `.metrics-before.txt`, `.metrics-after.txt`: メモリ時系列とspeculation counter原文

巨大GGUF全体のハッシュ計算は自動では行いません。正式な再現性に必要なmodel hashやdriverの配布versionは別途記録してください。`runs/`はGit管理外なので、採用結果はレビューしてから別途保存します。

同じrunにplainがあれば、入力・samplingの同一性を確認し、生成token／textの完全一致をCSVに併記します。反復末尾の簡易警告も出しますが、**速度測定完了＝correctness合格ではありません**。batch差による不一致もあり得ます。`quality_review`は常に`unreviewed`とし、長文ループ・日本語品質・OOMを出力原文とログで確認するまで実用性能と断定しません。

## SWE-bench harness

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

### 正式評価の実行・報告方針

- 各instanceの上限は **100 turns / 1時間** とする。
- 正式評価は各variant・各instanceにつきまず1回実行し、全30問を一律3回反復しない。
- endpoint障害など評価不能な実行だけを再実行する。`timeout`、`turn-limit`、空patchはモデルの結果として保持し、結果を改善する目的では差し替えない。
- 再実行した場合は初回結果を削除せず、理由と試行番号を分けて保存する。同一結果として平均化するのは、事前に反復評価対象として固定した試行だけにする。
- variant比較ではresolved率に加え、patch生成率、`timeout` / `turn-limit`率、wall-clock、turn数、input/output token数を保存・報告する。速度指標を出す場合は算出方法を明記し、少なくともoutput tokens / wall-clockを実効値として区別する。
- 公式graderの出力はagent artifactと同じrun IDへ紐づけ、instance単位のresolved判定と集計結果を残す。grader未実行のrunをresolved扱いしない。

実行条件は各instanceの`run.json`、終了状態とwall-clock・turn数は`timing.json`、token数は`usage.json`へ自動保存されます。variantに`runtime`を設定した場合は、外部runtimeのrepository、commit、実行ファイル、起動コマンドなども`run.json`へ保存されます（現行q2設定は暫定値）。公式grader結果と最終比較表・グラフは別途生成して紐づけます。

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

中断後は`--resume`を付けると、`timing.json`が`completed`のinstanceを再実行せず、保存済みpatchをpredictionsへ含めて残りだけを実行します。

```bash
npm run bench -- \
  --config configs/swebench-multilingual-web-30.json \
  --variant q2 \
  --resume
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

### Dockerのディスク使用量

SWE-bench公式graderはinstanceごとのDocker imageを自動削除しないため、30問を一括実行するとイメージが蓄積します。ローカル実行では、非空patchを1問ずつgraderへ渡し、各instance終了直後にこの実行が作成したimageだけを削除するwrapperを使ってください。

```bash
PYTHON_BIN="$HOME/.cache/genai-expo-swebench-venv/bin/python" \
  scripts/run-swebench-grader-serial.sh \
  --dataset "$HOME/.cache/genai-expo-grader/test-00000-of-00001.parquet" \
  --predictions runs/swebench-multilingual-web-30/cloud-fp/predictions.jsonl \
  --run-id genai-expo-cloud-fp-web30 \
  --report-dir runs/swebench-multilingual-web-30/cloud-fp/grader
```

wrapperは開始前に存在した`swebench/sweb.eval.*` imageを保持し、新規作成分だけを各instance後と中断時に削除します。別のSWE-bench評価と同時に実行しないでください。これにより公式graderのログ・集計reportは維持しつつ、imageの累積を防ぎます。

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
