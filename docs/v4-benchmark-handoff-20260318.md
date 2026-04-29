# V4 Benchmark Handoff 2026-03-18

> **Status: 2026-04-29 — OBSOLETE.** 本ハンドオフは 2026-03-20 のコミット `6d716f2` で **V4 → V5 への切り替え**が行われた時点で意義を失った。V5 切り替えのコミットメッセージに「Verified: 99/100 integration tests pass, benchmarks 5/5 one_day, 5/5 one_week」とあるとおり、V5 用の新ベンチ（`scripts/diagnostics/v5-integration-test.js`、1265 行）で代替済み。
>
> 当時残課題だった `one_week` 5/20 進捗、塩分 32.4 g/dinner といった外れ値、メニュー反復は **V5 側で**設計時に対処されている（template-anchored diversity + seasonal filter + Ultimate Mode の Step4-6 栄養フィードバック）。
>
> V4 自体はまだ動作するエンジンとして残存しており、フォールバック用途として価値を持つが、ベンチマークは V5 側に集約された。以下は履歴として保持する。

## 目的

別のシステム / 別の AI が、停止したベンチマークをここから再開できるようにするための申し送りです。

## ベンチツール

- `scripts/diagnostics/v4-benchmark.js`
- 起動コマンド:

```bash
npm run diagnostic:v4-benchmark
```

## 今回の停止地点

停止時点のローカル成果物:

- ログ: `tmp/benchmarks/v4-benchmark-20260318-153420.log`
- partial JSON: `tmp/benchmarks/v4-benchmark-20260318-153420.partial.json`

停止時点の進捗:

- `one_day`
  - 20/20 成功で完了済み
  - 失敗 0
  - 平均 `42541 ms`
- `one_week`
  - 5 attempt 実行済み
  - 成功 4
  - 失敗 1
  - まだ 20 成功には未到達

## 続きはここから

そのまま再開するなら次のコマンドを使います。

```bash
BENCHMARK_SEED_FILE=tmp/benchmarks/v4-benchmark-20260318-153420.partial.json \
BENCHMARK_REPORT_FILE=tmp/benchmarks/v4-benchmark-resumed-$(date +%Y%m%d-%H%M%S).json \
npm run diagnostic:v4-benchmark
```

このコマンドは以下の挙動です。

- `one_day` は seed 側で 20/20 成功済みなのでスキップ
- `one_week` は partial JSON に入っている 5 attempt を引き継ぐ
- 20 成功に達するまで継続する
- 結果は新しい report JSON に保存する

## ここまでの観察

- 速度面
  - `one_day` は平均 42.5 秒まで落ちている
  - `one_week` は成功 run が 145〜203 秒帯
- 内容面
  - `one_day` は塩分高めの run が複数回出た
  - `one_week` でも塩分異常 run があり、特に attempt 3 で `2026-04-01 dinner sodium 32.4g` が出た
  - メニュー反復も残っていて、朝食 `卵とじうどん / 味噌汁`、昼食 `鶏の照り焼き`、夕食 `鮭系` が繰り返し出やすい

## 再開後にやること

1. `one_week` を 20 成功まで完了させる
2. 完了 report JSON を確認する
3. 速度平均と内容異常を両方まとめる
4. 特に塩分外れ値とメニュー反復を別項目で報告する
