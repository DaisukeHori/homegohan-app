# 料理画像のジョブから画像ができるまで（2026-10-12）— #1505

本番では料理画像が一度も作られていなかった（2026-10-12 の読み取り: `meal_image_jobs` 0 件、料理の `image_status` は pending 1,251 件・ready 0 件）。
ジョブを積んでから画像ができるまでの経路を通しで洗った結果と、コードで直したこと・本番で確かめること（オーナー作業）・pending の料理の直し方をまとめる。

## 1. 原因と直したこと

| # | 箇所 | 何が起きていたか | 直したこと |
|---|---|---|---|
| 1 | Next.js の入口（`lib/meal-image-jobs.ts`） | `upsert(onConflict: 'idempotency_key', ignoreDuplicates)`。冪等キーの一意な索引 `meal_image_jobs_idempotency_pending_idx` は部分索引（`WHERE status IN ('pending','processing')`）なので、`ON CONFLICT (idempotency_key)` は索引を推論できず 42P10 で必ず失敗し、エラーも見ていなかった | #1487（PR #1504）で行ごとの insert に直した（23505 は重複として数える・1 行も積めなければ数え戻す） |
| 2 | Edge Function の入口（`supabase/functions/_shared/meal-image-jobs.ts`。献立の生成 `generate-menu-v5` / `generate-menu-v4` の `saveMealToDb` が使う） | 1 と同じ upsert が残っていた。献立の生成の料理は、ジョブが 1 行も積まれず pending のまま | #1505 で 1 と同じ積み方にした。積み方は `supabase/functions/_shared/meal-image.ts` に置き、Next.js と Edge が共用する |
| 3 | 積めなかった料理（両方の入口） | 料理を保存したあとにジョブの書き込みが失敗すると、料理は pending のまま（処理するジョブが無いので「生成中」に残る） | 書き込みに失敗した料理は、保存済みの献立の上で `image_status: 'failed'` + `image_error: 'enqueue_failed'` にする。保存し直すと積み直す（`needsImageRetry`） |
| 4 | `saveMealToDb` の処理の起こし方 | 積む料理があれば、積めたかどうかに関係なく処理を起こしていた | 待ちのジョブがあるとき（積めた行か、重複の行があるとき）だけ起こす |

## 2. 経路（ジョブを積んでから画像ができるまで）

| 段 | 何が | きっかけ | 認証 | 要る環境変数・secrets | 失敗したときの料理・ジョブ |
|---|---|---|---|---|---|
| A. 料理の保存（Web・モバイル） | `POST /api/meals`・`PATCH /api/meals/[id]`・`POST /api/meal-plans/meals`・`PATCH /api/meal-plans/meals/[id]`・AI 相談の献立の変更 | 利用者の操作 | 利用者のセッション。ジョブは service role で積む（`getAiQueueWriter()`。#1465） | Vercel: `NEXT_PUBLIC_SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY` | 見送り（安全弁・レート制限）は保存の前に `failed` + `skipped_*`（#1487）。書き込みの失敗は `failed` + `enqueue_failed`（#1505） |
| B. 献立の生成 | `/api/cron/process-menu-queue`（Vercel Cron、毎分）が `generate-menu-v5` を呼び、`saveMealToDb` が料理ごとにジョブを積む | Vercel Cron | Vercel の `CRON_SECRET`（Vercel Cron が付ける）。Edge Function は service role の鍵 | Vercel: `CRON_SECRET`・`SUPABASE_SERVICE_ROLE_KEY`。Edge: `SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`（Supabase が自動で入れる） | 書き込みの失敗は `failed` + `enqueue_failed`（#1505） |
| C. 処理を起こす | A・B が積んだ直後に `POST {SUPABASE_URL}/functions/v1/process-meal-image-jobs`（`{ plannedMealId, limit }`）を送る（`triggerMealImageJobProcessing`） | A・B の直後だけ。**定期的に待ちのジョブを拾う仕組み（pg_cron・Vercel Cron）は無い** | `Authorization: Bearer <service role の鍵>` と `apikey`。関数は `verify_jwt` が既定（有効）なので、鍵は JWT でなければゲートウェイで 401 | Next.js: `SERVICE_ROLE_JWT`（あれば）か `SUPABASE_SERVICE_ROLE_KEY`。Edge: 同じ順で Edge の環境変数 | 送れない・401・503 でも警告のログだけ。ジョブは pending のまま、料理も pending のまま（下の 4 で直す） |
| D. 画像を作る | `process-meal-image-jobs` が待ちのジョブ（その献立の分、最大 20 件）を処理中にして、Google の画像の AI で作り、Storage の `fridge-images`（公開バケット）の `generated/<planned_meal_id>/` に置き、料理を `ready` にする | C の要求 | 関数の中で、Bearer か apikey が Edge の `SERVICE_ROLE_JWT`（無ければ `SUPABASE_SERVICE_ROLE_KEY`）と一致するかを見る。**`CRON_SECRET` は使わない**（#1406 の `CRON_SECRET` が無くてもこの経路は止まらない） | Edge: `SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`・`GOOGLE_AI_STUDIO_API_KEY`（または `GOOGLE_GEN_AI_API_KEY`）。足りなければ 503 `SERVER_CONFIG_MISSING`（ログに変数名） | 同意が無い → ジョブは取り消し、料理は `failed` + 同意の理由。生成・保存の失敗 → ジョブは `failed`、料理は `failed` + 理由。料理が変わった・消えた → ジョブは取り消し |

### 残っている弱いところ（この Issue では直していない）

- **待ちのジョブを定期的に拾う仕組みが無い。** C が失敗すると、ジョブは pending のまま残る。同じ料理を保存し直すか（重複として数え、処理を起こし直す）、下の 4 の道具で処理を起こし直すと動く。
- **処理中のまま止まったジョブを取り戻さない。** D の途中で関数の実行が打ち切られると、ジョブは `processing` のまま（貸し出しの期限 `leased_until` が過ぎても）残り、料理は pending のまま。冪等キーの一意な索引は `processing` も対象なので、保存し直しても重複になって積み直されない。

## 3. 本番で確かめること（オーナー作業）

コードの変更だけでは確かめられないもの。値そのものはチャットやログに出さない。

| # | 確かめること | 場所 | 合っていないとき |
|---|---|---|---|
| O-1 | Edge Function の secrets に `GOOGLE_AI_STUDIO_API_KEY`（または `GOOGLE_GEN_AI_API_KEY`）がある | Supabase Dashboard → Edge Functions → Secrets | D が 503 になり、ジョブは pending のまま |
| O-2 | Vercel の `SERVICE_ROLE_JWT`（設定していれば）/ `SUPABASE_SERVICE_ROLE_KEY` が、Edge の `SERVICE_ROLE_JWT`（設定していれば）/ `SUPABASE_SERVICE_ROLE_KEY` と同じ service role の **JWT** である（新しい形式の secret key `sb_secret_...` ではない） | Vercel → Settings → Environment Variables、Supabase → Settings → API Keys | ゲートウェイの 401（`UNAUTHORIZED_INVALID_JWT_FORMAT` など）か、関数の 401 `{"error":"Unauthorized"}`。ジョブは pending のまま |
| O-3 | このブランチのマージのあと、GitHub Actions の「Deploy Supabase Functions」が成功している（Edge の積み方の修正は、デプロイされるまで効かない） | GitHub → Actions | 献立の生成のジョブが積まれないまま |
| O-4 | デプロイのあと、献立を 1 つ生成（または料理を 1 つ保存）して、`meal_image_jobs` に行が増え、`process-meal-image-jobs` のログに 202 が出て、料理が `ready` になる | Supabase Dashboard → Table Editor / Edge Functions → Logs | O-1・O-2 を見直す |

## 4. pending のまま残っている料理（2026-10-12 時点で 1,251 件）

保存し直せば積み直される（#1487 の `needsImageRetry`）が、利用者が全部を保存し直すことは期待できないので、積み直す道具を用意した。
本番のデータへの一括の書き込み（`meal_image_jobs` への insert と、画像の AI への送信）になるので、**`--apply` は承認のあとに実行する。**

`scripts/requeue-pending-meal-images.ts`（中身は `scripts/lib/meal-image-backfill.ts`）:

- 既定は dry-run（数えるだけ。何も書かない）。`--apply` のときだけ積み、献立ごとに `process-meal-image-jobs` を起こす。
- 対象の料理: `image_status` が `pending` か `stale`・`image_url` が無い・`image_source` が `generated_ai` か未設定・`image_subject_hash` がある。
  `image_subject_hash` が無い料理は、保存し直さないと直らないので数えるだけ（`no_subject_hash`）。
- 日付の新しい献立から、`--max-meals`（既定 50・上限 500）件まで。献立ごとに処理を起こしたあと `MEAL_IMAGE_BACKFILL_INTERVAL_MS`（既定 10 秒）待つ。
- 同じ料理のジョブが待ち・処理中なら重複として数え、行を増やさない（もう一度流しても二重に積まない）。2 の「処理を起こせなかったジョブ」も、これで処理を起こし直せる。
- 同意が無い利用者のジョブは、`process-meal-image-jobs` が AI へ送らずに取り消す。料理画像の安全弁（1 日の回数）は数えない。

```bash
# 1) 数えるだけ (対象の献立・料理の数、対象外の理由ごとの数)
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx --yes tsx@4 scripts/requeue-pending-meal-images.ts
# 2) 1 人分の 1 献立だけ積み直して、画像ができるかを確かめる
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx --yes tsx@4 scripts/requeue-pending-meal-images.ts --apply --user-id=<uuid> --max-meals=1
# 3) 少しずつ進める (例: 10 月 1 日以降の献立を 50 献立まで)
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx --yes tsx@4 scripts/requeue-pending-meal-images.ts --apply --since=2026-10-01 --max-meals=50
```

積んだジョブは `trigger_source = 'backfill:requeue-pending-meal-images'` で数えられる。
