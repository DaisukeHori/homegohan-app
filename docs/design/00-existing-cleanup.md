# 既存実装のクリーンアップ計画

PR #797 で要件定義を書き直したため、中途半端な既存実装を削除し、要件通りに新規構築する。**実運用前のため安全に削除可能**。

## 削除対象 (新規構築するため不要)

### Web App: 管理 UI (全 13 ページ)

```
src/app/(admin)/                # admin 系全削除、要件 03 §9 で再構築
├── admin/page.tsx
├── admin/users/page.tsx
├── admin/organizations/page.tsx
├── admin/moderation/page.tsx
├── admin/audit-logs/page.tsx
├── admin/inquiries/page.tsx
└── admin/announcements/page.tsx

src/app/(super-admin)/          # super_admin 系全削除、要件 03 §9.4 で再構築
├── super-admin/page.tsx
├── super-admin/admins/page.tsx
├── super-admin/database/page.tsx
├── super-admin/feature-flags/page.tsx
├── super-admin/llm-usage/page.tsx
└── super-admin/settings/page.tsx
```

### Web App: 管理系 API (全 13 系統)

```
src/app/api/admin/              # 要件 03 §8 で再構築
├── announcements/
├── audit-logs/
├── catalog/
├── inquiries/
├── moderation/
├── organizations/
├── stats/
└── users/

src/app/api/super-admin/        # 要件 03 §8.5 で再構築
├── admins/
├── db-stats/
├── embeddings/
├── feature-flags/
├── llm-usage/
└── settings/
```

### Web App: 旧パスの API (要件で命名変更)

```
src/app/api/org/users/          # → /api/org/members に統合 (要件 02 §8.2)
src/app/api/org/settings/       # → /api/org/me に変更 (要件 02 §8.1.2)
src/app/api/org/stats/          # → /api/org/dashboard に統合 (要件 02 §F-ORG-007)
src/app/api/org/departments/    # 旧 PUT/DELETE クエリ形式 → PATCH/DELETE path 形式 (要件 02 §8.3)
```

### Web App: family API (要件と乖離が大きいため再構築)

```
src/app/api/family/groups/      # レスポンス形状が要件と異なる、認可も owner のみ
src/app/api/family/members/     # height→height_cm リネーム、role 列追加、admin 認可必要
```

### Web App: 壊れている / 旧スキーマ依存

```
src/app/api/account/export/     # 旧 meal_plans (20260109 で DROP 済) を参照、本番で 500
src/lib/plan-limits.ts          # user_profiles.plan 単一列依存、複数組織+plan_key 体系に未対応
```

### DB スキーマ: 本番ダッシュボード直接適用された中途半端テーブル

これらは Supabase ダッシュボード経由で本番に直接適用されており migration ファイルがない。**実運用前のため DROP TABLE ... CASCADE で削除し、要件 §11.0 に従って再構築**:

```sql
-- 削除対象 (順序: 依存先から)
DROP TABLE IF EXISTS family_invites CASCADE;
DROP TABLE IF EXISTS family_members CASCADE;
DROP TABLE IF EXISTS family_groups CASCADE;
DROP TABLE IF EXISTS organization_invites CASCADE;
DROP TABLE IF EXISTS organization_challenges CASCADE;
DROP TABLE IF EXISTS org_members CASCADE;
DROP TABLE IF EXISTS departments CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP TABLE IF EXISTS admin_audit_logs CASCADE;
```

## 保持対象 (これらは再利用、削除禁止)

### マスターデータ・AI 学習資産

```
supabase/migrations/
├── 20251126124224_create_meal_planner_tables.sql           # planned_meals 基盤
├── 20251230074519_create_dataset_tables_for_menu_v2.sql    # dataset_recipes
├── 20251230090000_add_ingredients_and_derived_recipes.sql  # dataset_ingredients
├── 20260102000001_create_app_logs.sql
├── 20260102000002_create_embedding_jobs.sql
├── 20260103000000_add_nutrition_v2_functions.sql           # 栄養計算 RPC
├── 20260109000000_date_based_model_migration.sql           # user_daily_meals
├── 20260110000000_create_ingredient_match_cache.sql
├── 20260111000000_health_checkups.sql
├── 20260111120000_add_search_recipes_hybrid.sql            # pgvector 検索
├── 20260112000000_photo_system.sql                          # food_recognitions
├── 20260112100000_performance_os_v3.sql                     # user_performance_checkins
├── 20260316030000_create_catalog_tables.sql
├── 20260430160000_db_audit_fixes.sql
├── 20260430170000_user_push_tokens.sql
└── 20260430270000_add_user_profiles_roles.sql
```

### Edge Functions (完成度の高い AI 機能)

```
supabase/functions/
├── knowledge-gpt/              # ストリーミング対応、SSE 完備
├── generate-menu-v5/           # 献立生成 (家族モード追加で再利用)
├── food-recognition/           # 食事写真→食材
├── generate-hint/              # AI ヒント
├── analyze-meal-photo/
├── analyze-fridge/
├── analyze-health-checkup/     # 健診 PDF OCR
├── classify-photo/
└── _shared/                    # llm-usage, allergy 検証
```

### Web App: ドメインロジック (要件で再利用)

```
src/app/api/meal-plans/         # 献立計画 (個人) — 要件で family と連携
src/app/api/meals/              # 食事記録 — 既存維持
src/app/api/food-recognition/   # AI 認識 — 既存維持
src/app/api/health/             # 健診 — 既存維持
src/app/api/nutrition/          # 栄養計算 — 既存維持
src/app/api/recipes/            # レシピ — 既存維持
src/app/api/cron/               # cron framework — 既存維持
```

### Web App: UI コンポーネント (汎用)

```
src/components/                 # menu, recipe, calendar, modal, etc.
src/components/web/             # WebView ハイブリッド
```

### Mobile App

```
apps/mobile/                    # WebView + ネイティブ機能、再利用
```

### 認証・基盤

```
supabase auth (auth.users, auth.identities)  # 既存維持
src/lib/supabase/                              # クライアント設定
src/middleware.ts                              # セッション同期
```

## 削除手順

### Step 1-1: ファイル削除 (PR で実施)

```bash
git rm -r src/app/\(admin\)/
git rm -r src/app/\(super-admin\)/
git rm -r src/app/api/admin/
git rm -r src/app/api/super-admin/
git rm -r src/app/api/org/users/
git rm -r src/app/api/org/settings/
git rm -r src/app/api/org/stats/
git rm -r src/app/api/org/departments/
git rm -r src/app/api/family/groups/
git rm -r src/app/api/family/members/
git rm -r src/app/api/account/export/
git rm src/lib/plan-limits.ts
```

### Step 1-2: DB クリーンアップ (Supabase SQL Editor で実施)

```sql
-- 既存のテストデータがある場合は事前に SELECT で確認
-- 削除対象に依存する RLS / トリガー / インデックスは CASCADE で除去される
DROP TABLE IF EXISTS family_invites CASCADE;
DROP TABLE IF EXISTS family_members CASCADE;
DROP TABLE IF EXISTS family_groups CASCADE;
DROP TABLE IF EXISTS organization_invites CASCADE;
DROP TABLE IF EXISTS organization_challenges CASCADE;
DROP TABLE IF EXISTS org_members CASCADE;
DROP TABLE IF EXISTS departments CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP TABLE IF EXISTS admin_audit_logs CASCADE;
```

### Step 1-3: 依存先の修正

ファイル削除に伴い、import 切れが発生する箇所を修正:

```
src/app/api/account/delete/route.ts    # family_groups CASCADE 参照を削除
src/app/api/account/profile/route.ts   # plan-limits 参照を削除
src/app/(main)/menu/...                # plan-limits 参照を削除 (各 page で使用箇所確認)
```

### Step 1-4: テスト破棄

既存 E2E テストの一部が削除対象 API を参照しているため、削除 or 後で再構築:

```
tests/e2e/r10-org-pantry-deep.spec.ts          # /api/org/users 参照
tests/e2e/w5-13-new-features-adversarial.spec.ts  # /api/org/settings 参照
tests/e2e/w5-12-admin-adversarial.spec.ts      # /api/admin/* 参照
tests/e2e/wave5-w56-settings-account-profile-adversarial.spec.ts  # plan-limits 経由
```

これらは Step 2 (設計書) 完了後、新 API に対するテストとして書き直す。

## ロールバック計画

万が一削除を取り消したい場合: `git revert` で削除コミットを巻き戻す。DB は Supabase ダッシュボードで再作成。

ただし、**実運用前で失うデータが無いため、ロールバック必要性は限定的**。

## 完了基準

- [ ] 上記ファイルの `git rm` 完了
- [ ] DB の DROP TABLE 完了 (Supabase 本番)
- [ ] 依存先の import 切れ修正完了
- [ ] `npm run build` がエラーなく通る
- [ ] 既存 E2E (smoke) が通る (削除対象を参照しないもの)
