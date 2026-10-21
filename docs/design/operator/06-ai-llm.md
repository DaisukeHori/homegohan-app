# operator/ AI / LLM 設計

## 1. 目的・スコープ

ほめゴハン全機能の AI モデル選定・LLM 使用量計測・プラン別 quota・プロンプト管理・アレルゲン検証フロー・Edge Function 一覧・AI 出力の context 漏洩防止を定義する。

**対象外**: 個別 Edge Function の実装詳細 (別ドキュメント)

## 2. 関連要件

- 要件 03 §5.5 F-OP-005 LLM コスト管理
- 要件 03 §5.5.3 クォータ
- 要件 03 §5.5.4 AI モデル選定
- 要件 03 §5.5.5 ストリーミング usage 計測
- 要件 03 §5.5.6 ProposedRecipeSchema
- 要件 03 §5.5.7 アレルゲン突合
- 要件 03 §15.20.6
- 100-scenarios.md F11 (DAU/WAU/MAU) ← LLM コストと連動

## 3. AI モデル選定マトリクス

### 3.1 機能別モデル割当

| 機能 | モデル | プロバイダー | 選定理由 | 月コスト想定 (1,000 users) |
|------|-------|------------|---------|--------------------------|
| `food-recognition` (写真→食材認識) | Gemini 2.0 Flash | Google | コスト最安、画像認識品質十分 | $50 |
| `classify-photo` (写真分類) | Gemini 2.0 Flash Lite | Google | 速度重視、低コスト | $20 |
| `analyze-fridge` (冷蔵庫分析) | Gemini 2.0 Flash | Google | 画像 + テキスト複合処理 | $30 |
| `analyze-health-checkup` (健診 PDF→数値 OCR) | Gemini 2.0 Flash | Google | PDF OCR 高品質 | $10 |
| `analyze-weight-scale` (体重計 OCR) | Gemini 2.0 Flash Lite | Google | 速度重視 | $5 |
| `knowledge-gpt` (一般質問・チャット) | xAI Grok-4-1-fast-non-reasoning | xAI | latency 最速、コスト競争力 | $200 |
| `family-meal-ai-propose` (個別献立 AI 提案) | xAI Grok-4-1-fast-non-reasoning | xAI | latency 最速 | $100 |
| `family-shared-menu-generate` (共有献立生成) | xAI Grok-4 | xAI | 高品質 (複数制約の最適化) | $150 |
| `generate-week-menu` (週次献立生成) | xAI Grok-4-1-fast | xAI | バランス型 | $100 |
| `generate-day-menu` / 1 食の献立生成 (Edge Function `generate-menu-v5`。機能フラグが OFF なら `generate-menu-v4`。旧 `generate-single-meal` は #1452 で削除済み) | xAI Grok-4-1-fast-non-reasoning | xAI | 高速 | $50 |
| `industrial-doctor-advice` (産業医 AI アドバイス) | claude-3-5-sonnet-20241022 | Anthropic | 健康指導の専門性・安全性 | $80 |
| `image/generate` (献立画像生成) | Gemini Imagen | Google | コスト・品質バランス | $30 |

**選定基準**:
- 画像認識: Gemini (コスト最安、OCR 品質高)
- チャット・献立提案: xAI Grok (latency 最速、コスト中)
- 健康指導 (産業医向け): Claude Sonnet (専門性・安全性・医療倫理)
- 速度重視のリアルタイム判定: Gemini Flash Lite

### 3.2 フォールバック設定

| 主モデル | フォールバック | 条件 |
|---------|------------|------|
| xAI Grok (チャット系) | OpenAI GPT-4o-mini | xAI API エラー率 > 5% / タイムアウト |
| Gemini Flash (画像系) | OpenAI GPT-4o Vision | Gemini API エラー |
| Claude Sonnet (産業医) | なし (機能停止、人間エスカレーション) | 安全性上の理由 |

## 4. LLM 使用量計測

### 4.1 llm_usage_logs テーブル (既存拡張)

```sql
-- 既存テーブルに organization_id 列を追加
ALTER TABLE llm_usage_logs
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS family_group_id UUID REFERENCES family_groups(id),
  ADD COLUMN IF NOT EXISTS is_streaming BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS function_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS model VARCHAR(100),
  ADD COLUMN IF NOT EXISTS prompt_tokens INT,
  ADD COLUMN IF NOT EXISTS completion_tokens INT,
  ADD COLUMN IF NOT EXISTS total_tokens INT,
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS duration_ms INT;

CREATE INDEX idx_llm_usage_user_date ON llm_usage_logs(user_id, created_at::DATE);
CREATE INDEX idx_llm_usage_function ON llm_usage_logs(function_name, created_at DESC);
CREATE INDEX idx_llm_usage_org ON llm_usage_logs(organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;
```

### 4.2 使用量計測ヘルパー

```typescript
// supabase/functions/_shared/llm-usage.ts (既存ファイル拡張)

export interface LLMUsageContext {
  userId: string;
  organizationId?: string;
  familyGroupId?: string;
  functionName: string;
  model: string;
  isStreaming?: boolean;
}

export async function logLLMUsage(
  ctx: LLMUsageContext,
  usage: { prompt_tokens: number; completion_tokens: number },
  durationMs: number
): Promise<void> {
  const totalTokens = usage.prompt_tokens + usage.completion_tokens;
  const costUsd = calculateCost(totalTokens, ctx.model);

  await supabase.from('llm_usage_logs').insert({
    user_id: ctx.userId,
    organization_id: ctx.organizationId ?? null,
    family_group_id: ctx.familyGroupId ?? null,
    function_name: ctx.functionName,
    model: ctx.model,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    is_streaming: ctx.isStreaming ?? false,
    duration_ms: durationMs,
  });
}

// コスト計算 (概算、モデル別レート)
function calculateCost(tokens: number, model: string): number {
  const rates: Record<string, { input: number; output: number } | number> = {
    'grok-4-1-fast-non-reasoning': { input: 0.000005, output: 0.000020 },
    'grok-4-1-fast': { input: 0.000005, output: 0.000020 },
    'grok-4': 0.000005,
    'gemini-2.0-flash': 0.0000003,
    'gemini-2.0-flash-lite': 0.00000015,
    'claude-3-5-sonnet-20241022': 0.000015,
  };
  return tokens * (rates[model] ?? 0.000005);
}
```

### 4.3 ストリーミング応答時の usage 計測 (§5.5.5)

```typescript
// supabase/functions/_shared/llm-usage.ts
export async function logStreamingUsage(
  ctx: LLMUsageContext,
  stream: ReadableStream,
  startTime: number
): Promise<{ response: ReadableStream; usage: Promise<void> }> {
  let totalCompletionTokens = 0;
  let usageLogged = false;

  const [stream1, stream2] = stream.tee();

  // バックグラウンドでトークン数を集計 (完了時に記録)
  const usagePromise = (async () => {
    const reader = stream2.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // SSE パースしてトークン数を累積
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              totalCompletionTokens = data.usage.completion_tokens ?? totalCompletionTokens;
            }
          } catch {}
        }
      }
      buffer = lines[lines.length - 1];
    }

    // ストリーム完了時に usage を記録
    if (!usageLogged) {
      usageLogged = true;
      await logLLMUsage(ctx, {
        prompt_tokens: 0,  // ストリーミングでは別途取得
        completion_tokens: totalCompletionTokens,
      }, Date.now() - startTime);
    }
  })();

  return { response: stream1, usage: usagePromise };
}
```

## 5. プラン別 Quota

> #1149 (T40) で実装した形に合わせて書き直した (旧版は Redis の checkLLMQuota と、プランごとの日次・月次の目安の表だった)。
> 課金は無料のまま計測する段階 (全員 free) なので、月次の上限と試用中の上限は持たない (有料プランの作業 T48 で決める)。

### 5.1 1 日の上限 (DB の ai_daily_limits)

| 項目 | 内容 |
|------|------|
| 数える単位 | 利用者の 1 回の操作を 1 回 (究極モードも 1 回)。全機能の合計。写真の「オート」(判別 `classify-photo` → 解析 `analyze-*`) も 1 回 (§5.2) |
| 日の区切り | JST の暦日 (0 時に戻る) |
| 上限の値 | `public.ai_daily_limits(plan_key PK, daily_limit)`。NULL は無制限。既定は `free` = 10 の 1 行だけ |
| 行の無いプラン | `free` の行の値 (`free` の行も無ければ無制限) |
| 変更 | 運営画面 `/super-admin/llm/quotas` (GET / PATCH `/api/super-admin/llm/quotas`。super_admin のみ。監査ログ `super_admin.llm_quota.update`) |
| 上限に数えない機能 | 画面を開く・保存するだけで呼ばれる AI。`nutrition_advice_auto` (ホームの栄養のアドバイス・栄養の詳細を開いたときの栄養士のコメント) と `meal_image_auto` (料理を保存・更新したときに付ける料理画像。AI 相談の update_meal も同じ)。1 日の上限の合計には入れず、機能ごとの安全弁 (下の行) で止める。利用者が押して画像を作る操作 (`POST /api/ai/image/generate`) は `image_generation` で、上限に数える |
| 機能ごとの 1 日の上限 (上限に数える機能・#1142) | 究極モード (献立の生成で `ultimateMode: true`) は機能名 `menu_generation_ultimate` で数え、1 回で 1 日の上限の合計に 1 回・究極モードの上限に 1 回入る (両方に数える。`ai_usage_counters` の同じ 1 行なので、数え戻しも 1 回で両方から戻る)。究極モードの上限は利用者ごと・1 日 (JST) の回数で、既定は 1 回 (`AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT`。`supabase/functions/_shared/ai-usage-core.ts`)。環境変数 `AI_ULTIMATE_MODE_DAILY_LIMIT` (0 以上の整数。0 はその日は使えない。無い・形が違うときは既定の 1) で変える。Next.js (Vercel) と Edge Functions (Supabase の secrets) の両方に同じ値で入れる (片方だけだと、入口によって上限が変わる)。値は DB に持たず、呼び出し側が判定の関数に渡す。全員 (free を含む) が使える |
| 安全弁 (上限に数えない機能) | `public.ai_unmetered_daily_caps(feature PK, daily_cap)`。利用者ごと・1 日 (JST) の、機能ごとの回数。既定は `nutrition_advice_auto` = 30・`meal_image_auto` = 20 (ふつうの使い方では当たらない値)。行の無い機能は 20 (無制限にしない)。値は DB の行で変える (運営画面は無い)。上限に数えない機能を選ぶ材料 (forceRefresh・includeAdvice など) はクライアントが送る値なので、API を直接呼んで上限と無関係に AI を使えないように置く |

### 5.2 判定の実装

- 判定と記録は DB の `consume_ai_usage(p_user_id, p_feature) -> jsonb` が 1 回の呼び出しで原子的に行う
  (`pg_advisory_xact_lock` で同じ利用者・同じ日を 1 本ずつ判定し、上限に達していれば記録せずに `{ allowed: false, limit, used }`、
  達していなければ `ai_usage_counters` を +1 して `{ allowed: true, ... }`)。service_role のみ。
  上限に数えない機能は、その機能のその日の回数を安全弁と比べ、達していれば記録せずに `{ allowed: false, metered: false, limit: 安全弁, used }`
- 機能ごとの 1 日の上限がある機能 (究極モード `menu_generation_ultimate`。#1142) は、DB の `consume_ai_usage_capped(p_user_id, p_feature, p_feature_daily_cap) -> jsonb`
  (`20261014100000_ai_usage_feature_daily_cap.sql`。service_role のみ) で数える。`consume_ai_usage` と同じ鍵のロックの中で、その日のその機能の回数が
  `p_feature_daily_cap` に達していれば記録せずに `{ allowed: false, metered: true, limit: p_feature_daily_cap, used, usage_date, capped_feature }` を返し、
  達していなければ `consume_ai_usage` と同じ 1 日の上限の判定と記録をする (1 日の上限で止めたときは `capped_feature` を付けない)。
  呼び出し側 (`consumeAiUsage` / `consumeEdgeAiUsage`) は、機能ごとの上限 (`AI_ULTIMATE_MODE_DAILY_LIMIT`) がある機能だけこの関数を呼び、
  `capped_feature` を `cappedFeature` として返す。関数が失敗したときは、1 日の上限と同じくログに残して許可する
- Next.js: `consumeAiUsage(userId, feature)` (`src/lib/plan/entitlements.ts`) を AI へ送る直前に呼び、`if (!aiUsage.allowed)` で止める。
  Edge Function: ユーザーの JWT で直接呼ばれたときだけ `consumeEdgeAiUsage` (`supabase/functions/_shared/ai-usage.ts`)
- 順番は「同意の判定 (#1154) → 上限の判定と記録 → AI への送信」
- 止め方は入口ごと: 利用者が押す操作は 429 `AI_DAILY_LIMIT` (§11)、保存と AI の分析を一緒にする操作は保存だけして `aiSkipped: AI_DAILY_LIMIT`、
  料理画像の副作用は画像だけ見送る、キューに積む操作は積む時点で判定する。上限に数えない機能が安全弁で止められたときも同じ止め方
  (ホームの栄養の集計は AI の部分だけ省く、栄養士のコメントの自動の取得は 429、料理画像は画像だけ見送る)
- 料理画像 (#1487): ジョブを積むのは献立の主菜の 1 品だけ (役割 `main` / `主菜` の最初の料理、主菜の無い献立は先頭の料理。`autoImageDishIndexOf`)。ほかの料理に積もうとした種は落とし、画像の無い状態 (状態なし・subject_hash なし) にする。主菜でない料理だけを変えた保存は安全弁の 1 回を数えない (billing/03 §8.8・Q-16)。
  見送るかどうか (レート制限・同意・上限の判定) は、料理 (`planned_meals.dishes`) を保存する前に決める。
  見送るなら、ジョブを積む料理を `image_status: 'failed'` + `image_error` (`skipped_ai_limit` = 安全弁 / `skipped_rate_limit` = レート制限・判定の例外 /
  `skipped_plan` = ご利用中のプランでは自動の料理画像を作らない (`ai_plan_feature_caps` の `meal_image_auto` = 0。billing/03 §8.8))
  にしてから保存する ('pending' のまま保存すると、処理するジョブが無いので「生成中」のまま残る)。同じ料理 (subject_hash が同じ) でも、
  画像が無く待ち・更新待ち・失敗のまま (AI の画像) なら、保存し直したときにジョブを積み直す。
  ジョブを積むのは `image_source` が `generated_ai` か未設定の料理だけ。前回の料理の `image_source` が `meal_photo` / `catalog` /
  `manual_override` / `none` (と、`image_source` が無く `image_url` がある料理) なら、保存し直しても料理の中身を変えても、
  ジョブを積まずに前回の画像と状態を写し (手で付けた画像だけは、料理を変えたら `stale`)、`image_subject_hash` を付けない
  (画像の処理は料理とジョブの subject_hash が同じときだけ書くので、待ちのジョブが残っていても上書きしない)。
  前回の料理が subject_hash を持たない (写真・商品の料理、端末から直に保存した料理) ときは、前回の料理の中身から求めて同じ料理かを決める。
  subject_hash も `image_source` も無い料理を変えずに保存し直したとき (完了の切り替えなど) は積まない。
  商品を選んだ保存 (`catalogProductId`) は、料理を商品の料理 (画像は商品の画像、`image_source: 'catalog'`) にし、ジョブを作らない。
  保存する前の献立が商品の献立 (`catalog_product_id` がある・`source_type: 'catalog_product'`) なら、先頭の料理が自分の画像を持たず
  `image_source` が未設定か `generated_ai` (画像の項目の無い古い商品の料理と、それを以前の保存し直しが書き換えた形) でも、商品の料理
  (`image_source: 'catalog'`・状態なし) として扱う (更新の入口 3 つ (PATCH 2 本・AI 相談の update_meal) と save-meal は、保存する前の献立の行でこれを決めて渡す)。
  献立のカバーがあり、料理ごとの画像を持たない写真・商品・手の画像の料理 (写真の複数の料理など) があるときは、ほかの料理にもジョブを積まない
  (写真・商品の献立の料理には AI の画像を作らない。AI の作り直しで料理が変わったときを除く (#1553。下のカバーを外す (a)))。
  積むのをやめた料理は、前回と同じ料理なら前回の状態を写し、足した・変えた料理は画像なし (状態なし・subject_hash なし) にする
  新しく作る入口 (`POST /api/meals`・`POST /api/meal-plans/meals`) で送られた料理の `image_source` が `meal_photo` / `catalog` /
  `manual_override` なら、前回の料理と同じく画像と状態を保持し、ジョブを積まない (`preserveSubmittedDishImages`)。
  カバーの持ち主: 献立のカバー (`planned_meals.image_url`) を料理の画像から自動で付け替えてよいのは、いまのカバーが空か、
  献立の AI の料理 (`image_source: 'generated_ai'`) の `image_url` と一致するときだけ (`isMealCoverAutoReplaceable`)。
  写真・商品・利用者が作った画像・手で付けた画像のカバー (どの AI の料理の画像とも一致しない、空でないカバー) は、画像の処理
  (`process-meal-image-jobs`)・保存し直し (`reconcileDishImages`) のどこからも置き換えない。
  全員が `deriveMealCoverImage` を通して決める。前の料理の AI の画像だったカバーは料理の画像から選び直し、候補が無ければ空にする。
  料理が 2 品以上の献立に利用者がカバーを付けた (`PATCH` の `imageUrl`) ときは、カバーにだけ付け、ジョブは今の決まりのまま積む
  (1 品なら今までどおり料理を `manual_override` にし、ジョブを積まない)。画像の処理はカバーが変わるときだけ `image_url` を書き、
  読んだときのカバーのままの行にだけ書く。
  カバーを外すのは次の 2 つだけ (#1553)。外したあとのカバーも `deriveMealCoverImage` で料理の画像から選び直し、候補が無ければ空にする:
  (a) AI の作り直し (`save-meal` の `saveMealToDb`。`reconcileDishImages` の `regeneration`) で料理が変わったとき
  (前回と料理の数が違うか、subject_hash が違う料理がある)。中身が変わった料理は前回の写真・手で付けた画像を写さず、AI の画像のジョブを積み、
  利用者のカバー (写真・利用者の画像) を外す。料理ごとの画像を持たずカバーに頼っていた写真・商品・手の画像の料理 (写真の複数の料理の、
  中身が同じまま残った料理など) も、AI の画像の料理 (`generated_ai`・`'pending'`・subject_hash 付き) にしてジョブを積む
  (カバーが空・ジョブが 0 で、画像の無い写真の料理だけが残る献立を作らない。空のカバーには、あとでできた AI の料理の画像が付く)。
  自分の画像を持つ同じ料理 (1 品の写真など) は画像を残し、カバーの候補になる。
  料理が同じまま (同じ数・同じ中身) なら外さない。商品の献立 (`isCatalogProductMeal`) は外さない
  (作り直しても商品とのつながりは外さないので、商品の料理・商品の画像のまま)。
  (b) 料理が 2 品以上の献立の `PATCH` に `image_url` / `imageUrl` の `null` が来たとき (`buildDishImagePayload` の `clearCover`)。
  料理の画像 (AI の画像があれば) に戻し、候補が無ければ空にする (写真・手の画像の料理は AI の画像に回さない。写真の複数の料理の献立は、
  カバーが空になり料理は写真の料理のまま。待ちの AI の料理があれば、あとでできた画像がカバーに付く)。料理が 1 品の献立は今までどおり何も変えない
  料理 (`dishes`) も、読んだときの `updated_at` を条件にして書き、0 行なら読み直して自分の料理の画像だけを当て直す (#1527。上限
  `MEAL_DISH_WRITE_MAX_ATTEMPTS` 回で諦めて失敗にする)。積めなかった料理の印・失敗の印も同じ書き方 (`writePlannedMealDishesWithOptimisticLock`) で書く (#1532・#1553)
  ジョブは行ごとの insert で積む (冪等キーの一意な索引は待ち・処理中だけの部分索引なので、`ON CONFLICT (idempotency_key)` の upsert は使えない)。
  同じ料理のジョブが待ち・処理中なら一意制約の違反 (23505) を重複として数え、1 行も積めなかったとき (重複・書き込みの失敗) は数えた 1 回を戻す。
  献立の保存に失敗したときも戻す
- 料理画像のジョブの積み方 (#1505): Next.js (`lib/meal-image-jobs.ts`) と Edge Function (`supabase/functions/_shared/meal-image-jobs.ts`。
  献立の生成 `generate-menu-v5` / `generate-menu-v4` の `saveMealToDb`) は、同じ積み方 (`supabase/functions/_shared/meal-image.ts` の
  `buildMealImageJobRecords` / `insertMealImageJobRecords`) を使う。料理を保存したあとにジョブの書き込みが失敗した料理 (23505 以外のエラー・例外) は、
  保存済みの献立の上で `image_status: 'failed'` + `image_error: 'enqueue_failed'` にする (同じ料理で、画像が無く待ち・更新待ちの、
  `image_source` が `generated_ai` か未設定の料理だけ。写真・商品・手の画像の料理と、商品の献立の画像の項目の無い古い商品の料理は変えない。
  書くのは料理だけで、献立のカバーには触れない)。
  重複 (23505) の料理は待ちのまま (待ち・処理中のジョブが画像を作る)。`saveMealToDb` が処理 (`process-meal-image-jobs`) を起こすのは、積めた行か重複の行があるときだけ。
  待ったままの料理の積み直し (`scripts/requeue-pending-meal-images.ts`) は、保存し直しが積まない料理 (商品の献立の古い商品の料理・
  カバーが料理ごとの画像を持たない写真・商品・手の画像の料理のものである献立の料理) を、同じ共通の判定 (`asCatalogMealDish`・
  `isMealCoverHeldByImagelessPreservedDish`) で積まない。経路・本番で確かめること・積み直しの手順は `docs/operations/meal-image-pipeline.md`
- 写真の「オート」: 判別 (`POST /api/ai/classify-photo`) が 1 回数え、数え済みの印 `aiUsageGrant` を応答で返す
  (`g1.<UNIX 秒>.<印の ID>.<HMAC-SHA256>`。署名の対象は機能名・利用者 ID・発行時刻・印の ID、鍵は service role key、有効は 10 分)。
  画面は続く解析 (`analyze-meal-photo` / `analyze-fridge` / `analyze-health-checkup` / `analyze-weight-scale`) の本文の `aiUsageGrant` に入れて送る。
  解析は署名を確かめ、DB の `claim_ai_usage_grant` で印を使用済みにできたときだけ数えない (印は 1 回だけ使える。使用済みの記録は
  `ai_usage_grant_claims`)。印が無い・偽物・期限切れ・他人の印・使用済みなら数える。判別だけを無料にする形は採らない
  (判別は `includeMealAnalysis` で解析の結果まで返すので、抜け道になる)
- 数えたあと、AI へ送る前に DB の処理が失敗したとき (生成のリクエストの行の insert の失敗など) は `refund_ai_usage` で 1 回を戻す。AI へ送ったあとの失敗では戻さない
- DB の関数が失敗したとき (エラー・未適用・3 秒を超える) は、ログに残して許可する (判定の失敗で AI を止めない)

### 5.3 異常検知

利用者ごとの使い過ぎは、1 日の上限 (§5.1。押した操作) と、上限に数えない機能の安全弁 (§5.1 の `ai_unmetered_daily_caps`) が DB の判定で止める。
異常な使い方の通知 (Slack など) と、利用者ごとに上限を自動で下げる仕組みは無い (Redis の上書きの鍵も使っていない)。

## 6. アレルゲン突合フロー (§5.5.7)

### 6.1 ProposedRecipeSchema (Zod)

> **注意**: `ProposedRecipeSchema` の canonical 定義は **family/04-meal-request-flow.md §8** を参照。
> 個別献立フローのドメイン主管であるため、family/04 の定義を唯一の正とする。
> 本ファイルでは重複定義を保持しない。

### 6.2 アレルゲン突合フロー

```typescript
// supabase/functions/_shared/allergy.ts

const MAJOR_ALLERGENS = [
  '卵', '乳', '小麦', '落花生', 'えび', 'かに', 'そば', 'くるみ', // 特定原材料 8 種
  'あわび', 'いか', 'いくら', 'オレンジ', 'カシューナッツ', 'キウイフルーツ',
  '牛肉', 'ごま', 'さけ', 'さば', '大豆', '鶏肉', 'バナナ', '豚肉',
  'まつたけ', 'もも', 'やまいも', 'りんご', 'ゼラチン', 'アーモンド',
]; // 特定原材料に準ずるもの含む

export interface AllergenCheckResult {
  safe: boolean;
  hits: Array<{ ingredient: string; allergen: string }>;
}

export function detectAllergenHits(
  recipe: ProposedRecipe,
  memberAllergens: string[]
): AllergenCheckResult {
  const hits: AllergenCheckResult['hits'] = [];

  for (const ingredient of recipe.ingredients) {
    for (const allergen of memberAllergens) {
      // 完全一致 + 部分一致 (例: 「牛乳」に「乳」がヒット)
      if (
        ingredient.name.includes(allergen) ||
        (ingredient.allergen_tags ?? []).includes(allergen)
      ) {
        hits.push({ ingredient: ingredient.name, allergen });
      }
    }
  }

  return { safe: hits.length === 0, hits };
}
```

### 6.3 AI 提案 → アレルゲン突合 → 再生成ループ

```typescript
// supabase/functions/family-meal-ai-propose/index.ts
async function proposeWithAllergenCheck(
  constraints: MealConstraints,
  memberAllergens: string[],
  maxRetries = 3
): Promise<ProposedRecipe> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 1. AI に献立提案を依頼
    const rawResponse = await callXaiGrok(buildPrompt(constraints, attempt));

    // 2. スキーマ検証
    const parsed = ProposedRecipeSchema.safeParse(rawResponse);
    if (!parsed.success) {
      console.warn(`Attempt ${attempt + 1}: Schema validation failed`, parsed.error);
      continue;
    }

    // 3. アレルゲン突合
    const allergenCheck = detectAllergenHits(parsed.data, memberAllergens);
    if (allergenCheck.safe) {
      return parsed.data;
    }

    console.warn(
      `Attempt ${attempt + 1}: Allergen hits detected: ${JSON.stringify(allergenCheck.hits)}`
    );
  }

  // 3 回失敗 → フォールバック (人間が決める UI へ)
  throw new Error('AI_ALLERGY_FALLBACK');
}
```

**フォールバック**: `throw new Error('AI_ALLERGY_FALLBACK')` → フロントエンドで「AI が安全な提案を作れませんでした。手動で入力してください」を表示。

## 7. プロンプト管理

### 7.1 ディレクトリ構成

```
supabase/functions/
├── _shared/
│   └── prompts/
│       ├── family-meal-ai-propose/
│       │   ├── system.ja.md
│       │   └── user.ja.md
│       ├── family-shared-menu-generate/
│       │   ├── system.ja.md
│       │   └── user.ja.md
│       ├── industrial-doctor-advice/
│       │   ├── system.ja.md     ← 厳格な医療倫理・免責事項含む
│       │   └── user.ja.md
│       ├── knowledge-gpt/
│       │   ├── system.ja.md
│       │   └── user.ja.md
│       └── food-recognition/
│           └── user.ja.md
```

### 7.2 プロンプトテンプレート例 (family-meal-ai-propose)

```markdown
<!-- supabase/functions/_shared/prompts/family-meal-ai-propose/system.ja.md -->
あなたは家族の食事提案AIアシスタントです。

## 重要な制約
- 提案するレシピに、以下のアレルゲンを含む食材を使用してはなりません: {{ALLERGENS}}
- アレルゲンが含まれる場合は、必ず代替食材を提案してください
- 医療的な栄養アドバイスは行わないでください (一般的な食事提案のみ)

## 出力形式
以下のJSONスキーマに従って、必ず JSON のみで応答してください:
{{SCHEMA}}
```

### 7.3 プロンプトバージョン管理

- Git で管理 (PR レビュー必須)
- 大きな変更は `feature_flags` で段階ロールアウト
- 産業医向けプロンプト (`industrial-doctor-advice`) は必ず super_admin が承認

## 8. AI Edge Function 一覧

| Edge Function | モデル | 認証 | quota 対象 | 説明 |
|--------------|-------|-----|-----------|------|
| `family-meal-ai-propose` | xAI Grok-4-1-fast-non-reasoning | JWT | ✓ | 個別献立 AI 提案 + アレルゲン突合 |
| `family-shared-menu-generate` | xAI Grok-4 | JWT | ✓ | 家族全員制約和集合での献立生成 |
| `industrial-doctor-advice` | claude-3-5-sonnet-20241022 | JWT (org_industrial_doctor) | ✓ | 産業医向け AI アドバイス |
| `knowledge-gpt` | xAI Grok-4-1-fast-non-reasoning | JWT | ✓ | 一般質問・栄養アドバイス |
| `generate-week-menu` | xAI Grok-4-1-fast | JWT | ✓ | 週次献立生成 |
| `generate-day-menu` | xAI Grok-4-1-fast-non-reasoning | JWT | ✓ | 日次献立生成 |
| `food-recognition` | Gemini 2.0 Flash | JWT | ✓ | 食事写真→食材認識 |
| `classify-photo` | Gemini 2.0 Flash Lite | JWT | ✓ | 写真分類 |
| `analyze-fridge` | Gemini 2.0 Flash | JWT | ✓ | 冷蔵庫内食材認識 |
| `analyze-health-checkup` | Gemini 2.0 Flash | JWT | ✓ | 健診 PDF→数値 OCR |
| `analyze-weight-scale` | Gemini 2.0 Flash Lite | JWT | ✓ | 体重計 OCR |
| `stripe-price-sync` | - | Service Role | - | Stripe Price 同期 |
| `notify-push` | - | - | - | 作らない (`mobile/06-push-send.md`。Push 通知の送信は Next の worker `GET /api/cron/push-outbox` で、AI を使わない) |
| `notify-email` | - | Service Role | - | Resend 一斉送信 |
| `scan-file` | - | Service Role | - | ClamAV ウイルススキャン |

## 9. AI 出力 context 漏洩防止

### 9.1 必須の組織・家族 ID 絞り込み

全 AI Edge Function は、呼び出し元の context を必ず **サーバー側で検証**する:

```typescript
// supabase/functions/_shared/context-guard.ts

/**
 * AI Edge Function に渡す context を検証する。
 * フロントエンドからの入力は信用せず、DB から自分で取得する。
 */
export async function validateAndLoadContext(
  userId: string,
  requestedContext: {
    familyGroupId?: string;
    organizationId?: string;
  }
): Promise<SafeContext> {
  const supabase = createSupabaseServiceClient();

  // family_group_id の検証: ユーザーが本当にそのグループのメンバーか
  if (requestedContext.familyGroupId) {
    const { data: membership } = await supabase
      .from('family_members')
      .select('id')
      .eq('family_group_id', requestedContext.familyGroupId)
      .eq('user_id', userId)
      .single();

    if (!membership) {
      throw new Error('CONTEXT_GUARD_FAMILY_ACCESS_DENIED');
    }
  }

  // organization_id の検証: ユーザーが本当にその組織のメンバーか
  if (requestedContext.organizationId) {
    const { data: orgMembership } = await supabase
      .from('user_profiles')
      .select('organization_id')
      .eq('id', userId)
      .single();

    if (orgMembership?.organization_id !== requestedContext.organizationId) {
      throw new Error('CONTEXT_GUARD_ORG_ACCESS_DENIED');
    }
  }

  return {
    userId,
    familyGroupId: requestedContext.familyGroupId,
    organizationId: requestedContext.organizationId,
  };
}
```

### 9.2 産業医 context 漏洩防止 (特に重要)

`industrial-doctor-advice` Edge Function:
- `organization_id` はフロントエンドから受け取らず、`user_profiles.organization_id` から取得
- 対象 `user_id` が同一組織のメンバーであることを DB で確認
- consent (`consent_org_health_data = TRUE`) を確認
- family_group_id は **一切渡さない** (産業医は家族データにアクセス不可)

```typescript
// supabase/functions/industrial-doctor-advice/index.ts
Deno.serve(async (req) => {
  const startTime = Date.now();
  const { targetUserId, adviceRequest } = await req.json();

  // JWT からログイン中の産業医の user_id を取得
  const supabase = createSupabaseClientWithAuth(req.headers.get('Authorization')!);
  const { data: { user: doctorUser } } = await supabase.auth.getUser();
  if (!doctorUser) return new Response('Unauthorized', { status: 401 });

  // 産業医の組織 ID を取得 (信頼できる source)
  const { data: doctorProfile } = await supabase
    .from('user_profiles')
    .select('organization_id, roles')
    .eq('id', doctorUser.id)
    .single();

  if (!doctorProfile?.roles?.includes('org_industrial_doctor')) {
    return new Response('Forbidden', { status: 403 });
  }

  // 対象ユーザーが同一組織 + consent 確認 (DB で検証、フロントエンド入力は信用しない)
  const { data: targetProfile } = await supabase
    .from('user_profiles')
    .select('organization_id, consent_org_health_data')
    .eq('id', targetUserId)
    .single();

  if (
    targetProfile?.organization_id !== doctorProfile.organization_id ||
    !targetProfile?.consent_org_health_data
  ) {
    return new Response('Access denied', { status: 403 });
  }

  // AI 呼び出し (organization_id を LLM に渡さない)
  const response = await callClaude(buildMedicalPrompt(adviceRequest));
  await logLLMUsage({
    userId: doctorUser.id,
    organizationId: doctorProfile.organization_id,
    functionName: 'industrial-doctor-advice',
    model: 'claude-3-5-sonnet-20241022',
  }, response.usage, Date.now() - startTime);

  return new Response(JSON.stringify(response.content), { headers: { 'Content-Type': 'application/json' } });
});
```

## 10. シーケンス — family-meal-ai-propose (アレルゲン突合含む)

```mermaid
sequenceDiagram
  participant Client
  participant EF as Edge Function family-meal-ai-propose
  participant Guard as context-guard
  participant DB as Supabase DB
  participant xAI as xAI Grok API
  participant LLMLog as llm_usage_logs

  Client->>EF: POST { family_group_id, request_id }
  EF->>Guard: validateAndLoadContext(userId, { familyGroupId })
  Guard->>DB: SELECT family_members WHERE user_id=xxx
  DB-->>Guard: membership確認
  EF->>DB: SELECT family_members.dietary_restrictions
  DB-->>EF: allergens list
  EF->>DB: SELECT family_meal_requests WHERE id=xxx
  DB-->>EF: meal request (constraints)

  loop 最大 3 回
    EF->>xAI: chat.completions (システムプロンプト + 制約)
    xAI-->>EF: ProposedRecipe JSON
    EF->>EF: ProposedRecipeSchema.parse()
    EF->>EF: detectAllergenHits(recipe, allergens)
    alt アレルゲンなし
      EF->>DB: UPDATE family_meal_requests SET proposed_recipe=xxx
      EF->>LLMLog: INSERT (tokens, cost)
      EF->>Client: 200 { recipe: ProposedRecipe }
    else アレルゲンあり
      Note over EF: 再生成 (プロンプトに除外食材を追加)
    end
  end

  alt 3 回失敗
    EF->>Client: 422 { error: 'AI_ALLERGY_FALLBACK' }
    Note over Client: 手動入力 UI にフォールバック
  end
```

## 11. エラーハンドリング

| エラー | コード | 対処 |
|-------|--------|------|
| 1 日の上限に達した (#1149) | `AI_DAILY_LIMIT` | 429 + `{ error: 「今日の AI の利用回数の上限 (N 回) に達しました。明日 0 時から使えます。」, code, limit, retryAfter }` + `Retry-After` (次の JST 0 時までの秒数) |
| 究極モードの 1 日の上限に達した (#1142。機能ごとの上限) | `AI_DAILY_LIMIT` | 429 + `{ error: 「今日の究極モードの利用回数の上限 (N 回) に達しました。明日 0 時から使えます。」, code, limit, cappedFeature: 'menu_generation_ultimate', retryAfter }` + `Retry-After`。状態・コードは 1 日の上限と同じで、文と `cappedFeature` だけが違う (究極モードを使わない生成は、1 日の上限まで使える)。文は `aiUltimateModeDailyLimitMessage` (`supabase/functions/_shared/ai-daily-limit.ts`。Web・モバイル・Edge Function 共用) |
| 上限に数えない機能の安全弁に達した (#1487。栄養士のコメントの自動の取得) | `AI_DAILY_LIMIT` | 429 + `{ error: 「今日はこれ以上、自動のコメントを作れません。明日また表示されます。」, code, safetyCap: true, retryAfter }` + `Retry-After`。回数 (limit) は出さない (安全弁の回数は明示の上限と別のもので、数字が食い違って見えるため)。文は `AI_AUTO_SAFETY_CAP_MESSAGE` (Web・モバイル共用) |
| アレルゲン 3 回失敗 | `AI_ALLERGY_FALLBACK` | 422 + フロントエンドで手動入力 UI に切替 |
| context 漏洩試行 | `CONTEXT_GUARD_*` | 403 + 監査ログ記録 |
| xAI API タイムアウト | `LLM_TIMEOUT` | フォールバックモデルで再試行 |
| JSON parse 失敗 | `LLM_INVALID_OUTPUT` | 再生成 (max_retries 以内) |
| Claude API エラー (産業医) | `LLM_DOCTOR_UNAVAILABLE` | 503 + 「AI アドバイスが一時的に利用できません。産業医に直接ご相談ください」 |

## 12. テスト方針

- **Unit**:
  - `detectAllergenHits()`: 各特定原材料のヒット/非ヒット
  - `ProposedRecipeSchema.parse()`: 正常系・異常系
  - `calculateCost()`: モデル別コスト計算
  - `consumeAiUsage()` / `refundAiUsage()` / 数え済みの印 (`issueAiUsageGrant` / `redeemAiUsageGrant`): `src/__tests__/lib/plan/entitlements.test.ts`
  - 写真の「オート」が 1 回に数えられること: `tests/ai-usage-photo-auto-grant.test.ts`
- **Integration** (Supabase Local):
  - `validateAndLoadContext()` の組織 ID 不一致 → 403 確認
  - ストリーミング usage ログの正確な記録
  - 1 日の上限・安全弁・数え済みの印の DB の関数 (境目・JST の日の境目・同時実行・権限): `tests/integration/rls/ai-daily-limit-rpc.test.ts`
- **E2E**:
  - アレルゲン突合: 卵アレルギー設定 → 卵を含む提案 → 自動再生成 → 卵なし提案
  - 上限: 入口ごとの止め方 (429 / AI の部分だけ省く / 画像だけ見送る) は `tests/ai-consent-enforcement-routes.test.ts` が route を実際に呼んで確かめる

## 13. 既存実装との関連

- `supabase/functions/_shared/llm-usage.ts`: 既存ファイルに `organization_id` / `family_group_id` 列追加
- `supabase/functions/knowledge-gpt/`: 既存 — ユーザーの JWT で直接呼ばれたときだけ `consumeEdgeAiUsage` で上限を判定する (service role で呼ぶ AI 相談の経路は、Next.js が数え済み)
- `supabase/functions/food-recognition/`: 既存 — context guard を追加

## 14. 未解決事項

- xAI Grok-4 の正式 API エンドポイントが変更された場合のフォールバック先 → `feature_flags` で切替できるよう設計済み
- `industrial-doctor-advice` の Claude API レート制限 (Rate Limit: 100 req/min) は組織 Pro の利用規模次第では上限引き上げ申請が必要
- LLM プロンプトの多言語対応 (英語) は Phase 2 で `prompts/{function}/{locale}.md` で管理
