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
| 5 | Next.js の 5 か所の入口・積み直しの道具の処理の起こし方（#1532） | Next.js は積めた行が 0 でも処理を起こしていた（空振りの呼び出し）。limit は積もうとした料理の数だった | `saveMealToDb` と同じく、積めた行か重複の行があるときだけ起こす。limit はその数（`countMealImageJobsToProcess`。書き込みに失敗した行は数えない） |
| 6 | Next.js の 4 本の HTTP の入口の `request_id`（#1532） | `x-request-id` ヘッダをそのまま `meal_image_jobs.request_id`（uuid の列）に入れていた。uuid でない値だと insert が 22P02 で失敗し、料理が `failed` + `enqueue_failed` になっていた | uuid の形式のときだけ入れ、それ以外は null（`uuidOrNull`。保存は失敗にしない） |
| 7 | 積めなかった料理の印付け（`markEnqueueFailedDishesInMeal`。#1532） | 献立の料理を読んでから、条件なしで書き直していた。そのあいだにワーカーが書いたほかの料理の画像を巻き戻しえた | 読んだときの `updated_at` の行にだけ書き、0 行なら読み直して当て直す（D と同じ `writePlannedMealDishesWithOptimisticLock`。上限 `MEAL_DISH_WRITE_MAX_ATTEMPTS`） |
| 8 | 画像の処理の端の経路（`process-meal-image-jobs`。#1553） | ①料理を失敗の印にできない（`MEAL_DISH_WRITE_MAX_ATTEMPTS` 回負けた・読めなかった）と `console.warn` だけで、料理が `pending`（生成中）のまま残ったことをジョブから追えなかった ②最初の献立の読み取りのエラーも「献立が消えた」としてジョブを取り消していた ③書き込みを諦めた・書かずにやめたジョブのアップロード済みの画像が Storage に残っていた | ①料理は条件なしで書かず（#1527 の排他を保つ）、`app_logs` に error で残し、ジョブの `last_error` に `dish left pending` を足す（`last_error LIKE '%dish left pending%'` で探せる。料理は保存し直すか 4 の道具で積み直す） ②読み取りを書くときと同じ `readMealSnapshot` にし、エラーはジョブを `failed`、行が無いときだけ取り消す ③諦めた（`MealDishWriteExhaustedError`）・書かずにやめたときだけ、そのジョブの `generated/<planned_meal_id>/<job_id>-<ts>.png` の 1 ファイルを消す（`isOwnJobUploadPath`。消せなくても結果は変えず warn のログだけ。書き込みのエラーでは書けたか分からないので消さない） |

## 2. 経路（ジョブを積んでから画像ができるまで）

| 段 | 何が | きっかけ | 認証 | 要る環境変数・secrets | 失敗したときの料理・ジョブ |
|---|---|---|---|---|---|
| A. 料理の保存（Web・モバイル） | `POST /api/meals`・`PATCH /api/meals/[id]`・`POST /api/meal-plans/meals`・`PATCH /api/meal-plans/meals/[id]`・AI 相談の献立の変更 | 利用者の操作。積むのは献立の主菜の 1 品だけ（ほかの料理だけを変えた保存は数えない。billing/03 Q-16） | 利用者のセッション。ジョブは service role で積む（`getAiQueueWriter()`。#1465） | Vercel: `NEXT_PUBLIC_SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY` | 見送り（安全弁・レート制限・ご利用中のプランで作らない `skipped_plan`）は保存の前に `failed` + `skipped_*`（#1487・billing/03）。書き込みの失敗は `failed` + `enqueue_failed`（#1505） |
| B. 献立の生成 | `/api/cron/process-menu-queue`（Vercel Cron、毎分）が `generate-menu-v5` を呼び、`saveMealToDb` が各食の主菜の 1 品にだけジョブを積む（billing/03 Q-16） | Vercel Cron | Vercel の `CRON_SECRET`（Vercel Cron が付ける）。Edge Function は service role の鍵 | Vercel: `CRON_SECRET`・`SUPABASE_SERVICE_ROLE_KEY`。Edge: `SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`（Supabase が自動で入れる） | 書き込みの失敗は `failed` + `enqueue_failed`（#1505） |
| C. 処理を起こす | A・B が積んだ直後に `POST {SUPABASE_URL}/functions/v1/process-meal-image-jobs`（`{ plannedMealId, limit }`）を送る（`triggerMealImageJobProcessing`）。`limit` は積めた行と、同じ料理の**待ち**のジョブ（重複）の数（`countMealImageJobsToProcess`。処理中の重複は数えない。#1561） | A・B の直後 | `Authorization: Bearer <service role の鍵>` と `apikey`。鍵は service role の **JWT**（関数は `verify_jwt = false` だが、関数の中で鍵と完全一致で照らし合わせる） | Next.js: `SERVICE_ROLE_JWT`（あれば）か `SUPABASE_SERVICE_ROLE_KEY`。Edge: 同じ順で Edge の環境変数 | 送れない・401・503 でも警告のログだけ。ジョブは pending のまま残り、C' が拾う |
| C'. 待ちのジョブを定期に拾う（#1561） | pg_cron のジョブ `process-pending-meal-image-jobs`（毎時 2, 7, 12, … 分。5 分ごと）が `public.invoke_process_meal_image_jobs()` を呼ぶ。最後の更新から 1 分を過ぎた待ちのジョブがあれば、`process-meal-image-jobs` を `{ limit: 5 }` で 1 回呼ぶ（無ければ何も送らない） | 5 分ごと | Vault の `app_cron_secret` を `Authorization: Bearer` に付ける。関数の中の `requireServiceRole` が Edge Function secrets の `CRON_SECRET` と照らし合わせる | Vault: `app_cron_secret`。Edge: `CRON_SECRET`（同じ値。ENV_SETUP.md） | Vault に無い → ジョブの実行が `failed`（`cron.job_run_details`）。Edge の `CRON_SECRET` が未設定 → 503 `Service not configured`、合わない → 401（応答は `net._http_response`）。どれもジョブは pending のまま |
| C''. 止まったジョブを取り戻す（#1561） | pg_cron のジョブ `requeue-stale-meal-image-jobs`（毎時 0, 5, 10, … 分）が `public.requeue_stale_meal_image_jobs()` を呼ぶ。`processing` のまま、貸し出しの期限（`leased_until`）から 5 分より長く過ぎたジョブの `attempt_count` を 1 足し、3 回に届いたら `failed`（料理が生成中で同じ料理なら `failed` + 理由）、届かなければ `pending` に戻す。`last_error` は `lease expired` で始まる | 5 分ごと | SQL だけ（秘密を使わない） | なし | — |
| D. 画像を作る | `process-meal-image-jobs` が待ちのジョブ（その献立の分、最大 20 件）を処理中にして、Google の画像の AI で作り、Storage の `fridge-images`（非公開バケット。表示は署名付き URL。#1365）の `generated/<planned_meal_id>/` に置き、料理を `ready` にする。献立のカバー（`planned_meals.image_url`）は、カバーの持ち主の決まり（`applyGeneratedDishImage` → `writeGeneratedDishImage`。#1525）で、空か AI の料理の画像だったときだけ付け替える（写真・商品・利用者のカバーは置き換えない）。料理（と失敗の印）は、読んだときの行（`updated_at`）のままの場合にだけ書き、そのあいだに別のワーカーや利用者が書いていたら読み直して当て直す（#1527。ほかの料理の画像を巻き戻さない） | C・C' の要求 | 関数の中で、Bearer か apikey が Edge の `SERVICE_ROLE_JWT`（無ければ `SUPABASE_SERVICE_ROLE_KEY`）と一致するかを見る。一致しなければ `requireServiceRole` で Bearer を `CRON_SECRET` と照らし合わせる（C' の経路。#1561）。C の経路は `CRON_SECRET` が無くても止まらない | Edge: `SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`・`GOOGLE_AI_STUDIO_API_KEY`（または `GOOGLE_GEN_AI_API_KEY`）。足りなければ 503 `SERVER_CONFIG_MISSING`（ログに変数名） | 同意が無い → ジョブは取り消し、料理は `failed` + 同意の理由。生成・保存の失敗 → ジョブは `failed`、料理は `failed` + 理由。料理が変わった・消えた → ジョブは取り消し |

### 待ちのジョブ・止まったジョブ（#1561 で直した）

- **待ちのジョブは C' が 5 分ごとに拾う。** C が失敗しても、ジョブは pending のまま残り、C' が `process-meal-image-jobs` を起こす（Vault の `app_cron_secret` と Edge の `CRON_SECRET` がそろっているとき。#1406 のオーナー作業）。1 回 5 件なので、1 時間に 60 件まで。同じ料理を保存し直したときも、重複が待ちなら処理を起こし直す。
- **処理中のまま止まったジョブは C'' が取り戻す。** D の途中で関数の実行が打ち切られると、ジョブは `processing` のまま残る。冪等キーの一意な索引 `meal_image_jobs_idempotency_pending_idx` は `processing` も対象なので、そのあいだは保存し直しても積み直しの道具を流しても重複（23505）になる。C'' が pending に戻せば（重複は待ちとして数えられ、C' か C が拾う）、failed にすれば（索引から外れる）、保存し直しで積み直せる。索引そのものは変えない（処理中の行を外すと、同じ料理のジョブを 2 つ同時に処理して画像を 2 回作れてしまう）。
- 取り戻したジョブは `SELECT id, status, attempt_count, last_error FROM meal_image_jobs WHERE last_error LIKE 'lease expired%' ORDER BY updated_at DESC LIMIT 20;` で探せる（読み取りのみ）。ジョブの実行の結果は `SELECT j.jobname, d.status, d.start_time, d.return_message FROM cron.job_run_details AS d JOIN cron.job AS j USING (jobid) WHERE j.jobname IN ('requeue-stale-meal-image-jobs', 'process-pending-meal-image-jobs') ORDER BY d.start_time DESC LIMIT 10;`。
- 費用: C' は、A・B のほかに 4 の道具が `--no-trigger` で積んだジョブも拾って画像を作る（秘密がそろったあと）。

## 3. 本番で確かめること（オーナー作業）

コードの変更だけでは確かめられないもの。値そのものはチャットやログに出さない。

| # | 確かめること | 場所 | 合っていないとき |
|---|---|---|---|
| O-1 | Edge Function の secrets に `GOOGLE_AI_STUDIO_API_KEY`（または `GOOGLE_GEN_AI_API_KEY`）がある | Supabase Dashboard → Edge Functions → Secrets | D が 503 になり、ジョブは pending のまま |
| O-2 | Vercel の `SERVICE_ROLE_JWT`（設定していれば）/ `SUPABASE_SERVICE_ROLE_KEY` が、Edge の `SERVICE_ROLE_JWT`（設定していれば）/ `SUPABASE_SERVICE_ROLE_KEY` と同じ service role の **JWT** である（新しい形式の secret key `sb_secret_...` ではない） | Vercel → Settings → Environment Variables、Supabase → Settings → API Keys | 関数の 401 `{"error":"Unauthorized"}`（Edge の `CRON_SECRET` が未設定なら 503 `{"error":"Service not configured"}`。#1561 で関数を `verify_jwt = false` にしたので、ゲートウェイの 401 は出ない）。ジョブは pending のまま（C' が拾う） |
| O-5 | Vault の `app_cron_secret` と Edge Function secrets の `CRON_SECRET` が同じ値で入っている（#1406 のオーナー作業。ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」）。#1561 の migration の適用と、`process-meal-image-jobs`（`verify_jwt = false` の版）のデプロイのあと | Supabase Dashboard → Vault / Edge Functions → Secrets | C' が待ちのジョブを拾えない（上の C' の行）。C'' は秘密が無くても動く |
| O-3 | このブランチのマージのあと、GitHub Actions の「Deploy Supabase Functions」が成功している（Edge の積み方の修正は、デプロイされるまで効かない） | GitHub → Actions | 献立の生成のジョブが積まれないまま |
| O-4 | デプロイのあと、献立を 1 つ生成（または料理を 1 つ保存）して、`meal_image_jobs` に行が増え、`process-meal-image-jobs` のログに 202 が出て、料理が `ready` になる | Supabase Dashboard → Table Editor / Edge Functions → Logs | O-1・O-2 を見直す |

## 4. pending のまま残っている料理（2026-10-12 時点で 1,251 件）

保存し直せば積み直される（#1487 の `needsImageRetry`）が、利用者が全部を保存し直すことは期待できないので、積み直す道具を用意した。
本番のデータへの一括の書き込み（`meal_image_jobs` への insert と、画像の AI への送信）になるので、**`--apply` は承認のあとに実行する。**

`scripts/requeue-pending-meal-images.ts`（中身は `scripts/lib/meal-image-backfill.ts`）:

- 既定は dry-run（数えるだけ。何も書かない）。`--apply` のときだけ積み、献立ごとに `process-meal-image-jobs` を起こす。
- 対象の料理: `image_status` が `pending` か `stale`・`image_url` が無い・`image_source` が `generated_ai` か未設定・`image_subject_hash` がある。
  献立の主菜 (自動の料理画像を作る 1 品) であること。主菜でない待ちの料理は `not_auto_image_dish` で数えるだけ (billing/03 Q-16)。
  `image_subject_hash` が無い料理は、保存し直さないと直らないので数えるだけ（`no_subject_hash`）。
  保存し直し（`reconcileDishImages`）が AI の画像のジョブを積まない料理は、同じ共通の判定で積まない（#1514）: 商品の献立の、画像の項目の無い古い商品の料理（`asCatalogMealDish`。`catalog_meal_dish`）と、献立のカバーが料理ごとの画像を持たない写真・商品・手の画像の料理のものである献立の料理（`isMealCoverHeldByImagelessPreservedDish`。`meal_cover_preserved`）。
  ジョブを積めなかった料理は `failed` + `enqueue_failed` にするが、写真・商品・手の画像の料理は変えない。道具は献立のカバーに書かない。
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
