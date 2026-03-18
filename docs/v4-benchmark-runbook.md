# V4 Benchmark Runbook

## 目的

`generate-menu-v4` を実 Supabase / 実 Edge Function で複数回実行し、以下を確認するための診断ツールです。

- 1日生成と1週間生成の平均所要時間
- Step 1 / Step 2 / Step 3 の壁時計時間
- `llm_usage_logs` ベースの LLM セクション別時間
- `meal_nutrition_debug_logs` ベースの保存処理時間
- 生成された献立内容と栄養の異常傾向

## ツール本体

- `scripts/diagnostics/v4-benchmark.js`

## 前提条件

- リポジトリ直下に `.env.local` があること
- `.env.local` に以下が入っていること
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` または `SERVICE_ROLE_JWT`
- 実 Supabase の auth admin と Edge Function を叩けること

## 実行方法

### 通常実行

```bash
npm run diagnostic:v4-benchmark
```

### レポート JSON を保存しながら実行

```bash
BENCHMARK_REPORT_FILE=tmp/benchmarks/v4-benchmark-$(date +%Y%m%d-%H%M%S).json \
npm run diagnostic:v4-benchmark
```

### 中断済みの partial JSON から再開

```bash
BENCHMARK_SEED_FILE=tmp/benchmarks/v4-benchmark-20260318-153420.partial.json \
BENCHMARK_REPORT_FILE=tmp/benchmarks/v4-benchmark-resumed-$(date +%Y%m%d-%H%M%S).json \
npm run diagnostic:v4-benchmark
```

`BENCHMARK_SEED_FILE` は次のどちらでも読み込めます。

- `runsByScenario` を持つ partial JSON
- `scenarios[].runs` を持つ完了済み report JSON

## 既定のシナリオ

スクリプト内で次の 2 シナリオを固定で持っています。

- `one_day`
  - 1日 x 朝昼夕の 3 スロット
  - 成功 20 回まで回す
  - 最大 40 attempt
- `one_week`
  - 7日 x 朝昼夕の 21 スロット
  - 成功 20 回まで回す
  - 最大 40 attempt

## 出力

### 標準出力

以下の行単位ログが出ます。

- `[scenario-start]`
- `[run-result]`
- `[scenario-summary]`
- `[benchmark-report]`
- `[benchmark-complete]`

### 保存される内容

各 run で以下を集計します。

- 総所要時間
- `step1_wall_ms`
- `step2_wall_ms`
- `step3_wall_ms`
- `fixes_detected`
- `fixes_applied`
- `planned_meal_count`
- `llm_usage_logs` の section 別時間 / token
- `meal_nutrition_debug_logs` の slot timing
- 献立内容プレビュー
- 内容警告
  - `meal_sodium_high`
  - `day_sodium_high`
  - `day_calorie_outlier`
  - そのほか欠損系

## cleanup の挙動

各 attempt ごとに一時ユーザーを作成し、完了後に以下を削除します。

- `meal_image_jobs`
- `meal_nutrition_debug_logs`
- `llm_usage_logs`
- `planned_meals`
- `weekly_menu_requests`
- `user_profiles`
- `pantry_items`
- `user_daily_meals`
- auth user

そのため、通常実行では DB に計測用データを残しません。

## 中断時の扱い

Ctrl+C で止めても、それまで標準出力に出た `[run-result]` はログファイルから復元できます。

partial JSON は次のように作っておくと再開に使えます。

```bash
node - <<'NODE'
const fs = require('fs');
const path = 'tmp/benchmarks/v4-benchmark-YYYYMMDD-HHMMSS.log';
const out = path.replace(/\.log$/, '.partial.json');
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
const runs = [];
const scenarioSummaries = [];
for (const line of lines) {
  if (line.startsWith('[run-result] ')) {
    try { runs.push(JSON.parse(line.slice('[run-result] '.length))); } catch {}
  }
  if (line.startsWith('[scenario-summary] ')) {
    try { scenarioSummaries.push(JSON.parse(line.slice('[scenario-summary] '.length))); } catch {}
  }
}
const runsByScenario = runs.reduce((acc, run) => {
  (acc[run.scenario] ||= []).push(run);
  return acc;
}, {});
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), sourceLog: path, runsByScenario, scenarioSummaries }, null, 2));
console.log(out);
NODE
```

## 読み方

- 速度だけを見るなら `scenario-summary.total_duration_ms.avg`
- Step ごとの重さを見るなら `step1_wall_ms`, `step2_wall_ms`, `step3_wall_ms`
- LLM の実時間を見るなら `summary.usage`
- 保存側の重さを見るなら `summary.debug`
- 献立や栄養の異常傾向を見るなら `content.warning_count`, `content.warning_codes`, 各 run の `content_preview`

## 注意

- これは mock ではなく実データベース / 実 Edge Function を叩く診断です
- 実行時間は長く、1日生成 20 回だけでも数十分、1週間生成まで含めると数時間かかることがあります
- 失敗 run が混じるため、平均を見るときは `completed` 数も必ず確認してください
