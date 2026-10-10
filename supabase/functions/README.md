# Supabase Edge Functions

このディレクトリには Supabase Edge Functions（Deno ランタイム）が格納されています。

## 接続情報

| 項目 | 値 |
|------|-----|
| Project ID | `flmeolcfutuwwbjmzyoz` |
| URL | `https://flmeolcfutuwwbjmzyoz.supabase.co` |
| ANON_KEY | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsbWVvbGNmdXR1d3diam16eW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NzAxODYsImV4cCI6MjA3OTU0NjE4Nn0.VVxUxKexNeN6dUiAMDkCNlnIoXa-F5rfBqHPBDcwdnU` |

### Functions呼び出し例

```bash
curl -X POST "https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/<function-name>" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsbWVvbGNmdXR1d3diam16eW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NzAxODYsImV4cCI6MjA3OTU0NjE4Nn0.VVxUxKexNeN6dUiAMDkCNlnIoXa-F5rfBqHPBDcwdnU" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

## デプロイ方法

### 依存関係の固定ルール

- `supabase/functions/deno.json` を Edge Functions 用の共有設定として使います
- `deno.lock` は Supabase 側が lockfile v5 を読めないため commit しません
- 依存関係は `supabase/functions/deno.json` の `imports` に exact version で固定します
- 関数ファイルの中で `jsr:` や `npm:` を直接 import しません
- 関数ごとの `deno.json` は、共有設定で表現できない事情があるときだけ追加します

### 自動デプロイ（推奨）

**GitHub Actions による自動デプロイが設定されています。**

#### PR からの反映

自動マージの仕組みはありません (2026-10-08 のオーナー判断で廃止)。PR の CI を確認してから手動でマージします。

```
作業ブランチに push → PR を作成 → CI を確認
    ↓ 手動でマージ
main 更新
    ↓ 自動
Supabase Functions デプロイ
```

#### main ブランチへの直接プッシュ

`main` ブランチに `supabase/functions/**` 配下の変更がpushされると、自動的に Supabase にデプロイされます。

```
main へ push → GitHub Actions → Supabase Functions デプロイ
```

ワークフロー: `.github/workflows/deploy-supabase-functions.yml`

この README を含む `supabase/functions/**` 配下の更新は、自動デプロイのトリガー対象です。`supabase/config.toml`（関数ごとの `verify_jwt`）を変えただけの push も対象です（#1406）。

### 手動デプロイ

ローカルから手動でデプロイする場合：

```bash
# 全関数をデプロイ
supabase functions deploy --project-ref flmeolcfutuwwbjmzyoz

# 特定の関数のみデプロイ
supabase functions deploy <function-name> --project-ref flmeolcfutuwwbjmzyoz
```

`--no-verify-jwt` は付けません。付けると、指定したすべての関数でゲートウェイの JWT 検証が外れます。関数ごとの設定は `supabase/config.toml` から読まれます（下の「ゲートウェイの JWT 検証（verify_jwt）」）。

### ゲートウェイの JWT 検証（verify_jwt）

Supabase のゲートウェイは、既定で `Authorization: Bearer` が JWT かどうかを確かめ、JWT でなければ関数に届く前に HTTP 401（`UNAUTHORIZED_INVALID_JWT_FORMAT`）を返します。pg_cron が送る `app_cron_secret`（Edge Function 側の `CRON_SECRET`）はランダムな文字列で JWT ではないので、pg_cron から呼ぶ関数はゲートウェイの検証を外し（`supabase/config.toml` の `[functions.<name>]` に `verify_jwt = false`）、認証を関数の先頭の `requireServiceRole`（`_shared/auth.ts`）に任せます（#1406）。

`supabase functions deploy`（名前を指定しない全体のデプロイ。GitHub Actions もこの形）は、`supabase/config.toml` の `verify_jwt` を関数ごとに読みます（supabase CLI 2.62.10 の `internal/functions/deploy/deploy.go` の `GetFunctionConfig`。指定が無い関数は `true`）。

`verify_jwt = false` にしてよいのは、先頭で自前の認証（`requireServiceRole` / `requireAuth` / `auth.getUser`）をする関数だけです。`tests/edge-function-verify-jwt.test.ts` が、`config.toml` の一覧と関数の先頭の認証、migration の pg_net の呼び出し先を突き合わせます。

pg_cron やサーバーの内部から、利用者の JWT でない Bearer（秘密）で呼ばれる関数:

| 関数 | 呼び出し元 | 送る Bearer | 関数の中の認証 | `verify_jwt` |
|---|---|---|---|---|
| `calculate-segment-stats` | pg_cron のジョブ `calculate-segment-stats`（`public.invoke_calculate_segment_stats()`）/ `POST /api/comparison/trigger` | Vault の `app_cron_secret`（JWT でない）/ service role key | `requireServiceRole` | `false` |
| `import-seven-eleven-catalog` / `import-familymart-catalog` / `import-lawson-catalog` / `import-natural-lawson-catalog` / `import-ministop-catalog` | pg_cron（`public.invoke_catalog_import()`）/ `POST /api/admin/catalog/import` | Vault の `app_cron_secret`（JWT でない）/ service role key | `requireServiceRole`（`_shared/catalog/import-runner.ts`） | `false` |
| `import-convenience-catalog` | リポジトリ内に無い（上と同じ取り込み処理） | — | `requireServiceRole`（同上） | `false` |
| `aggregate-org-stats` | リポジトリ内に無い（停止中 #1325。本番に古い pg_cron のジョブが残っていれば `app_cron_secret`） | （`app_cron_secret`） | `requireServiceRole`（そのあと 410） | `false` |
| `regenerate-embeddings` | `POST /api/super-admin/embeddings/regenerate` | service role key（`CRON_SECRET` でも可） | service role key の完全一致、または `requireServiceRole` | `false` |
| `stripe-price-sync` | `POST /api/super-admin/plans/[id]/price-change` | service role key（`CRON_SECRET` でも可） | service role key の完全一致、または `requireServiceRole` | `false` |
| `knowledge-gpt` | 相談 AI の API（`/api/ai/consultation/sessions/[sessionId]/messages`） | service role key / 利用者の JWT | service role key の完全一致、または `auth.getUser` | `false`（以前から） |
| `generate-menu-v5` / `generate-menu-v4` | 献立生成の API・`/api/cron/process-menu-queue`・関数自身の続きの呼び出し | service role key / 利用者の JWT | 関数の中で service role key の完全一致、または `auth.getUser` | 既定（`true`）。JWT しか受け付けないので変えない |
| `process-meal-image-jobs` | `_shared/meal-image-jobs.ts`（献立生成の関数から） | service role key | service role key の完全一致 | 既定（`true`）。同上 |
| `regenerate-shopping-list-v2` | `POST /api/shopping-list/regenerate` | service role key / 利用者の JWT | service role key の完全一致、または `requireAuth` | 既定（`true`）。同上 |

既定（`true`）のままの関数は、service role key（JWT）か利用者の JWT しか受け付けないため、ゲートウェイの検証を通ります。`CRON_SECRET` のような JWT でない秘密を受け付ける関数（`requireServiceRole` を使う関数）を足したら、`config.toml` にも `verify_jwt = false` を足してください（足し忘れはテストが赤にします）。

## 関数一覧

| 関数名 | 説明 |
|--------|------|
| `generate-menu-v5` | 献立生成 v5（**本番主系**）。テンプレート起点の生成で、多様性チェックと栄養の外れ値の再生成つき。呼び分けは下の「献立生成 v4 と v5 の使い分け」を参照 |
| `generate-menu-v4` | 献立生成 v4（**非推奨**）。feature flag OFF 時のフォールバック。ただし `POST /api/ai/nutrition-analysis` は、フラグに関係なく今も直接呼ぶ。また v5 が共通部品を import しているため削除不可。詳しくは下の「献立生成 v4 と v5 の使い分け」を参照 |
| `knowledge-gpt` | 知識検索・レシピ検索 |
| `normalize-shopping-list` | 買い物リスト正規化 |
| `analyze-meal-photo` | 食事写真分析（Gemini） |
| `analyze-fridge` | 冷蔵庫写真分析（OpenAI Vision） |
| `analyze-health-photo` | 健康写真分析 |
| `generate-health-insights` | 健康インサイト生成 |
| `create-derived-recipe` | 派生レシピ作成 |
| `aggregate-org-stats` | 組織統計集約。**停止中**（オーナー判断 #1325）。認証（`requireServiceRole`）のあと、何もせず HTTP 410（`DISABLED`）を返すだけで、集計処理は削除済み。デプロイ先から関数を消さないよう、ディレクトリは残している。呼び出し元（画面のボタン・API ルート）も無い。本番に呼び出す `pg_cron` のジョブが残っていれば、migration `20261008130000_stop_aggregate_org_stats_cron.sql` が登録解除する |
| `calculate-segment-stats` | セグメント統計計算 (比較ランキング)。pg_cron のジョブ `calculate-segment-stats` が 1 時間ごと (毎時 5 分) に daily / weekly / monthly を呼ぶ。期間が切り替わった直後の回 (JST 0 時台) は、本文 `previousPeriod: true` で直前の期間も集計し直す。間隔の変え方は `ENV_SETUP.md` の「比較ランキングの集計の間隔」。手動は `POST /api/comparison/trigger` (super_admin だけ)。#1406 |
| `backfill-ingredient-embeddings` | 材料埋め込みバックフィル |
| `regenerate-embeddings` | 埋め込み再生成 |
| `regenerate-shopping-list-v2` | 買い物リスト再生成 v2 |
| `import-convenience-catalog` | Firecrawl scrape + OpenAI fallback でコンビニ商品カタログを取り込む |
| `import-seven-eleven-catalog` | `import-convenience-catalog` と同じ取り込み処理を、セブン-イレブン（`seven_eleven_jp`）に固定したもの |
| `import-familymart-catalog` | 同上。ファミリーマート（`familymart_jp`）に固定 |
| `import-lawson-catalog` | 同上。ローソン（`lawson_jp`）に固定 |
| `import-natural-lawson-catalog` | 同上。ナチュラルローソン（`natural_lawson_jp`）に固定 |
| `import-ministop-catalog` | 同上。ミニストップ（`ministop_jp`）に固定 |
| `generate-hint` | 食事データ（自炊率・平均カロリーなど）から短いヒントを AI で生成する。ユーザーの JWT で認証する。**現在、アプリ内に呼び出し元は無い**。以前は `POST /api/ai/hint`（週間献立ページから呼ばれる）が呼んでいたが、関数の戻り値を使わず、ルート内で作る既定のヒントを返していたため、AI の費用が無駄になっていた。#1327 で、このルートから関数を呼ばないようにした（ルートは AI を使わず、既定のヒントだけを返す）。関数はデプロイされたままで、`supabase/config.toml` で `verify_jwt = false`（認証は関数内の `requireAuth` で行う）のため、ユーザーの JWT があれば直接呼べる。**注意**: 生成結果を `user_hints` に upsert するコードはあるが、本番スキーマ（`supabase/baseline/prod_schema.sql`、2026-10-07 取得）に `user_hints` テーブルは無く、保存されない。upsert の `error` を見ていないため、失敗してもログに残らない。関数そのものの扱い（無効化・削除、直接呼び出しへのレート制限）は、#1153 とあわせて別途決める |
| `process-meal-image-jobs` | 料理画像の生成ジョブ（`meal_image_jobs`）を処理する。Google GenAI で画像を作って保存し、`planned_meals` に反映する。内部専用で、献立の生成・保存・編集のあとに起動される |
| `stripe-price-sync` | プランの価格変更時に、Stripe に新しい Price を作り、旧 Price を無効化する（無効化に失敗しても続行する）。月額・年額を 1 回の呼び出しで受け取り、`{ month, year }` を返す。旧 Price は同じ期間（月額 / 年額）のものだけ無効化する。価格変更は新規契約のみ（`applies_to` は `new_only` だけ）。内部専用（呼び出し元: `POST /api/super-admin/plans/[id]/price-change`） |

チェーン別の `import-*-catalog`（5 関数）はバッチ専用の関数です。呼び出し元は、DB 関数 `invoke_catalog_import()`（呼べる関数名は許可リスト方式）と、管理者用 API の `POST /api/admin/catalog/import`（admin / super_admin が手動で実行する）です。

### 献立生成 v4 と v5 の使い分け

2026-10-07 時点の `main` の実コードで確認した内容です。

- **本番主系は `generate-menu-v5`** です。`generate-menu-v4` は `@deprecated` ですが、**まだ削除できません**（理由は後述）。
- 多くの API は、v4 と v5 のどちらを呼ぶかを feature flag で決めます（フラグに関係なく固定のものは下の表を参照）。フラグは `menu_generation_v5_wrapped` と `menu_generation_v5_direct` の 2 つで、コード上の既定値はどちらも `true`（ON ＝ v5）です（`src/lib/menu-generation-feature-flags.ts` の `DEFAULT_FEATURE_FLAGS`）。
- どちらのエンジンで動いたかは、通常は `weekly_menu_requests.mode`（`v5` / `v4`）で分かります。ただし `/api/ai/menu/` 配下の `weekly/request`・`meal/generate`・`meal/regenerate` は、まず `weekly` / `single` / `regenerate` で行を作り、そのあとで `v5` / `v4` に書き換えます。書き換え（UPDATE）の成否はコード上で確認していないため、失敗した行は元の値のまま残ります。

#### 呼び出し元とエンジンの対応

| 呼び出し元 | 切り替えフラグ | フラグ ON（既定） | フラグ OFF |
|-----------|---------------|------------------|-----------|
| `POST /api/ai/menu/weekly/request`（週間献立） | `menu_generation_v5_wrapped` | v5 | v4 |
| `POST /api/ai/menu/meal/generate`（1 食の新規生成） | `menu_generation_v5_wrapped` | v5 | v4 |
| `POST /api/ai/menu/meal/regenerate`（1 食の作り直し） | `menu_generation_v5_wrapped` | v5 | v4 |
| `POST /api/ai/menu/day/regenerate`（1 日の作り直し） | `menu_generation_v5_wrapped` | v5 | v4 |
| AI 相談のアクション実行（`src/lib/ai/consultation-action-executor.ts`。`/api/ai/consultation/**` から呼ばれる） | `menu_generation_v5_wrapped` | v5 | v4 |
| `POST /api/ai/menu/v4/generate`（汎用の献立生成。URL は v4 だが、ON の間は v5 を呼ぶ） | `menu_generation_v5_direct` | v5 | v4 |
| `POST /api/ai/menu/v5/generate`（キューに積む）→ cron `GET /api/cron/process-menu-queue` が実行 | なし | v5（固定） | v5（固定） |
| `POST /api/ai/nutrition-analysis`（ホーム画面で AI の栄養提案を実行したとき） | なし | **v4（固定）** | **v4（固定）** |

#### v4 を削除できない理由

1. `POST /api/ai/nutrition-analysis` が、フラグに関係なく v4 を直接呼びます（Web は `src/hooks/useHomeData.ts`、モバイルは `apps/mobile/src/hooks/useHomeData.ts` の `executeNutritionSuggestion` から呼ばれます）。
2. v5 と `_shared/save-meal.ts` が、`generate-menu-v4/` にある共通部品を import しています。`index.ts` 以外は消せません。
   - `step-utils.ts`（v5 と `_shared/save-meal.ts` が使用）
   - `reference-menu-utils.ts`（v5 が使用）
   - `context-utils.ts`（v5 が使用）

#### v4 を廃止するときの手順

1. 上の「削除できない理由」の 1 と 2 を先に解消します（`nutrition-analysis` の呼び先を v5 に替える、共通部品を `_shared/` などへ移す）。
2. 各 API ルートなどにある v4 の分岐（`callGenerateMenuV4WithRetry` など）と、`generate-menu-v4/index.ts` を削除します。
3. v4 を前提にしているテストとスクリプトを直します。
   - `tests/embedding-contracts.test.ts` は、`generate-menu-v4/index.ts` を `fs.readFileSync` で読んで、`search_menu_examples` の引数名を確かめています。ファイルを消すと失敗するので、読む対象を `generate-menu-v5/index.ts` に替えます（v5 も同じ RPC を同じ引数名で呼んでいます）。
   - `scripts/smoke-generate-menu-v4.mjs` は、デプロイ済みの `generate-menu-v4` を HTTP で直接呼ぶ、手動のスモークスクリプトです（CI や `package.json` からは呼ばれていません）。v5 向けに直すか、削除します。
   - 共通部品を別の場所へ移した場合は、それを import している `tests/v4-supabase-functions.test.ts`・`tests/reference-menu-utils.test.ts`・`tests/context-utils.test.ts`・`tests/embedding-contracts.test.ts` の import 先も直します。
4. リポジトリからディレクトリを消しても、本番にデプロイ済みの `generate-menu-v4` は消えません。`deploy-supabase-functions.yml` は、関数をデプロイする（`supabase functions deploy`）だけで、削除はしないためです。本番から外すには、呼び出し元が残っていないことを確認したうえで、別に `supabase functions delete generate-menu-v4 --project-ref flmeolcfutuwwbjmzyoz` を実行します。

#### フラグの値の決まり方（注意）

- `loadFeatureFlags()` は、`system_settings` の `key = 'feature_flags'` の行を読み、コード上の既定値に DB の値を上書きして使います。行が読めないときは既定値のままです。値は `PUT /api/super-admin/settings`（super_admin 限定）で書き換えられます。
- 上の API ルートは、**ログインしているユーザー自身のセッション**でこの行を読みます。`system_settings` を SELECT できるのは `admin` / `super_admin` だけです（RLS。本番スキーマのスナップショット `supabase/baseline/prod_schema.sql` の `Admins can view system settings`）。そのため**一般ユーザーの操作では DB の値は読めず、常に既定値（ON ＝ v5）になります**。
- 結果として、DB 上でフラグを OFF にしても、v4 に切り替わるのは admin / super_admin 自身の操作だけです。一般ユーザー全員を v4 に戻す手段としては、現状は使えません。

#### 名前が紛らわしいもの

- `POST /api/ai/menu/v4/generate`: URL は v4 ですが、`menu_generation_v5_direct` が ON の間は v5 を呼びます。
- `src/lib/generate-menu-v4-retry.ts` の `invokeGenerateMenuV4WithRetry`: 名前は v4 ですが、中身は汎用のリトライ関数です（`consultation-action-executor.ts` では v5 の呼び出しにも使います）。そのため v5 の呼び出しが失敗しても、エラーメッセージは `generate-menu-v4 failed after ...` と出ます。
- `_shared/v4-fast-llm.ts` / `_shared/v4-nutrition-adapter.ts`: 名前は v4 ですが、v5 も使う共通部品です。

#### 呼び出し元を再確認するには

```bash
# Next.js 側: フラグ判定と、v4 / v5 の呼び出し元（テストは除く）
grep -rn "generate-menu-v[45]\|menu_generation_v5" src --include=*.ts --include=*.tsx --exclude-dir=__tests__

# Edge Functions 側: v4 ディレクトリの共通部品を import している行
grep -rn 'from "../generate-menu-v4/' supabase/functions --include=*.ts
```

## ディレクトリ構成

```
supabase/functions/
├── _shared/                 # 共有ユーティリティ（全関数から参照可能）
│   ├── auth.ts             # 認証ヘルパー（requireAuth: ユーザーの JWT、requireServiceRole: cron 用の共有シークレットか service role key。await 必須）
│   ├── cron-secret.ts      # cron 用シークレットの照合（Next.js の src/lib/cron-auth.ts と共用。import なし・Deno/Node 固有 API なし。入れ替え中は CRON_SECRET_PREVIOUS も受け付ける。手順は ENV_SETUP.md）
│   ├── cors.ts             # CORS設定（許可したオリジンにだけ CORS ヘッダーを返す。下の「CORS」を参照）
│   ├── db-logger.ts        # ログ記録
│   ├── log-sanitizer.ts    # ログ保存前の秘密情報マスキング・切り詰め（Next.js の src/lib/db-logger.ts と共用。import なし・Deno/Node 固有 API なし）
│   ├── bulk-query.ts       # 集計バッチ向けの PostgREST の読み書き（失敗を例外にする・1 回の応答の上限 1000 行を超えて全件を取る・.in() の ids の分割）
│   ├── allergy.ts          # アレルギー処理
│   ├── nutrition-*.ts      # 栄養計算関連
│   ├── meal-generator.ts   # 献立生成ロジック
│   └── ...
├── <function-name>/
│   ├── index.ts            # エントリポイント（必須）
│   └── deno.json           # Deno設定（オプション）
└── README.md               # このファイル
```

## 開発ガイド

### 新しい関数の作成

```bash
# 新規関数ディレクトリ作成
mkdir supabase/functions/<function-name>

# index.ts を作成（必須）
touch supabase/functions/<function-name>/index.ts
```

### 基本テンプレート

利用者の JWT で認証する関数（ブラウザからも呼ばれうる関数）のテンプレートです。バッチ専用の関数には CORS を付けません（下の「CORS」を参照）。

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  // Origin はリクエストごとに違うので、ハンドラの先頭で作る
  const corsHeaders = getCorsHeaders(req);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { data } = await req.json();

    // ロジック実装

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
```

### CORS

CORS はブラウザだけが強制する仕組みです。Next.js の API ルートや cron など、サーバーからの呼び出しには影響しません。

- 利用者の JWT で認証する関数は、`_shared/cors.ts` の `getCorsHeaders(req)` を使います。リクエストの `Origin` が許可リストに完全一致したときだけ `Access-Control-Allow-Origin` を返し、どの応答にも `Vary: Origin` を付けます。`*`（全オリジン許可）は使いません。
- 許可するオリジンは、環境変数 `ALLOWED_ORIGINS`（カンマ区切り）で決めます。未設定のときは `https://homegohan.app` と `https://homegohan-app.vercel.app` です。設定すると既定値は置き換わります。
- バッチ専用の関数（service role key や `CRON_SECRET` で認証する関数）は、ブラウザから呼ばれないので CORS を付けません。`aggregate-org-stats`、`calculate-segment-stats`、`regenerate-embeddings`、`stripe-price-sync`、`backfill-ingredient-embeddings`、`create-derived-recipe`、`import-*-catalog` が該当します。
- ブラウザから Edge Function を直接呼ばないでください。権限の確認が要る処理は、Next.js の API ルートで確認してから、サーバーから Edge Function を呼びます（例: 管理者用のコンビニカタログ取り込みは `POST /api/admin/catalog/import` を経由します）。
- モバイルアプリの WebView が読み込むのは Web アプリ自身（`EXPO_PUBLIC_WEB_URL`）のページなので、そこから呼ぶときの `Origin` も Web アプリのオリジンです。ネイティブ側の `fetch` は `Origin` を付けません。
- 新しい関数を足すときは、`tests/edge-function-cors.test.ts` が、`Access-Control-Allow-Origin: *`（ワイルドカード）を書き込んでいないか、CORS ヘッダーを `_shared/cors.ts` 以外に直書きしていないか、バッチ専用の関数に CORS を付けていないかを検査します。`requireServiceRole` を使う関数を足したら同じテストの `BATCH_ONLY_SOURCES` に、`_shared/cors.ts` を使う関数を足したら `USER_FACING_SOURCES` に、一覧として足してください。

### ローカルでのテスト

```bash
# Supabase ローカル環境起動
supabase start

# 関数をローカルで実行
supabase functions serve <function-name>
```

ブラウザ（`http://localhost:3000` など）から直接呼ぶ必要がある場合だけ、`ALLOWED_ORIGINS` にそのオリジンを足してください（`ALLOWED_ORIGINS=http://localhost:3000` を書いた env ファイルを、`supabase functions serve --env-file <ファイル>` で渡します。コミットしないこと）。

## 環境変数

Supabase Dashboard → Edge Functions → 対象関数 → Settings で設定。

主な環境変数：
- `ALLOWED_ORIGINS` - CORS で許可するオリジン（カンマ区切り、スキーム付き・末尾スラッシュなし）。未設定時は `https://homegohan.app,https://homegohan-app.vercel.app`。`*` と `null` は無視される
- `OPENAI_API_KEY` - OpenAI API キー（LLM補助処理用）
- `FIRECRAWL_BASE_URL` - Firecrawl API のベース URL。未指定時は `https://api.firecrawl.dev/v2`
- `FIRECRAWL_API_KEY` - Firecrawl Cloud または Bearer 保護された self-host 用キー
- `FIRECRAWL_AUTH_TOKEN` - self-host 接続時の任意 auth token。設定時は `FIRECRAWL_API_KEY` より優先
- `FIRECRAWL_AUTH_HEADER` - self-host が独自ヘッダを要求する場合のヘッダ名。既定は `Authorization`
- `FIRECRAWL_AUTH_SCHEME` - auth header の scheme。既定は `Bearer`。生 token を送りたい場合は空文字
- `AIMLAPI_API_KEY` - dataset embeddings 用 Voyage API キー
- `GOOGLE_AI_API_KEY` - Gemini API キー
- `PERPLEXITY_API_KEY` - 低信頼な標準料理の栄養相場補助用キー

### Firecrawl self-host

コンビニ catalog importer は Firecrawl の `/scrape` だけを使います。`Agent` や `Browser` には依存しません。

- Firecrawl Cloud の場合: `FIRECRAWL_BASE_URL` は未指定でよく、`FIRECRAWL_API_KEY` を設定します
- Firecrawl self-host の場合: `FIRECRAWL_BASE_URL` を self-host URL に向けます
- self-host が認証なしなら token は不要です
- self-host で `formats: ["markdown", { type: "json", ... }]` を使うため、Firecrawl 側には JSON extraction 用の LLM provider 設定が必要です

## 注意事項

- `_shared/` ディレクトリは関数としてデプロイされません
- 各関数は独立した Deno プロセスで実行されます
- コールドスタートを考慮した設計を推奨
