# 21 — Migration SQL 完全形

> 関連: [08-state-db](./08-state-db.md) / [17-security](./17-security.md) / operator/01-data-model.md (canonical)

---

## 1. ファイル配置

```
supabase/migrations/2026XXXXXXXXXX_handson_tour.sql
```

`XXXXXXXXXX` は適用時刻 `date +%Y%m%d%H%M%S` で生成 (例: `20260507143000`)。

---

## 2. Migration SQL (commit-ready 完全形)

```sql
-- =====================================================
-- Migration: handson_tour (initial introduction)
-- Date: 2026-05-XX
-- Source: docs/design/family/09-onboarding-handson-tour/
-- Phase: 1 (DB)
-- Idempotent: yes (IF NOT EXISTS / ON CONFLICT)
-- =====================================================

BEGIN;

-- =========================================
-- 1. user_profiles 拡張: 2 列追加
-- =========================================

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS handson_tour_completed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS handson_tour_skipped_at   TIMESTAMPTZ NULL;

COMMENT ON COLUMN user_profiles.handson_tour_completed_at IS
  '初回ハンズオンチュートリアル完了日時 (family/09)。NULL = 未完走';

COMMENT ON COLUMN user_profiles.handson_tour_skipped_at IS
  '初回ハンズオンチュートリアル明示スキップ or auto-skip 日時 (family/09)';

-- 部分インデックス: 表示判定の高速化 (pending な user のみ index に乗る)
CREATE INDEX IF NOT EXISTS idx_user_profiles_handson_tour_pending
  ON user_profiles (user_id)
  WHERE handson_tour_completed_at IS NULL AND handson_tour_skipped_at IS NULL;


-- =========================================
-- 2. meal_logs 拡張: is_sandbox 列追加
-- =========================================

ALTER TABLE meal_logs
  ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN meal_logs.is_sandbox IS
  'true = ハンズオンチュートリアル中の sandbox 投入 (family/09)';

-- 部分インデックス: 通常 UI のクエリ高速化
CREATE INDEX IF NOT EXISTS idx_meal_logs_user_non_sandbox
  ON meal_logs (user_id, eaten_at DESC)
  WHERE is_sandbox = false;

-- 部分 UNIQUE 制約: ハンズオン中の二重 INSERT 防止
-- (user_id, is_sandbox=true) の組合せは 1 行のみ
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_sandbox_meal
  ON meal_logs (user_id)
  WHERE is_sandbox = true;


-- =========================================
-- 3. weekly_menus 拡張: is_sandbox 列追加
-- =========================================

ALTER TABLE weekly_menus
  ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN weekly_menus.is_sandbox IS
  'true = ハンズオンチュートリアル中の sandbox 投入 (family/09)';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_sandbox_menu
  ON weekly_menus (user_id)
  WHERE is_sandbox = true;


-- =========================================
-- 4. badges seed: tutorial_complete 追加
-- =========================================

INSERT INTO badges (code, name, description, condition_json)
VALUES (
  'tutorial_complete',
  '使い方マスター',
  'はじめての使い方ガイドを最後まで完走',
  '{"type":"event","event":"handson_tour_completed"}'::jsonb
)
ON CONFLICT (code) DO NOTHING;


-- =========================================
-- 5. RPC 関数: 既存活動チェック
-- =========================================

CREATE OR REPLACE FUNCTION user_has_non_sandbox_activity(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM meal_logs WHERE user_id = p_user_id AND is_sandbox = false LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM weekly_menus WHERE user_id = p_user_id AND is_sandbox = false LIMIT 1
  );
END;
$$;

COMMENT ON FUNCTION user_has_non_sandbox_activity IS
  'ハンズオンチュートリアルの condition C 判定: ユーザーが既に non-sandbox の食事記録 or 献立を持つか';


-- =========================================
-- 6. RPC 関数: 卒業処理 (atomicな)
-- =========================================

CREATE OR REPLACE FUNCTION complete_handson_tour(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completed_at timestamptz;
  v_was_already boolean;
  v_badge_id uuid;
  v_badge_name text;
  v_badge_icon_url text;
  v_badge_obtained_at timestamptz;
BEGIN
  -- 1. user_profiles UPDATE (冪等)
  UPDATE user_profiles
  SET handson_tour_completed_at = COALESCE(handson_tour_completed_at, now())
  WHERE user_id = p_user_id
  RETURNING handson_tour_completed_at INTO v_completed_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  -- 既に過去に完了済みかどうか (1 秒以前なら "already")
  v_was_already := (v_completed_at < now() - INTERVAL '1 second');

  -- 2. badges から tutorial_complete を取得
  SELECT id, name, icon_url INTO v_badge_id, v_badge_name, v_badge_icon_url
  FROM badges WHERE code = 'tutorial_complete';

  IF v_badge_id IS NULL THEN
    RAISE EXCEPTION 'badge_not_found';
  END IF;

  -- 3. user_badges INSERT (冪等)
  INSERT INTO user_badges (user_id, badge_id, obtained_at)
  VALUES (p_user_id, v_badge_id, now())
  ON CONFLICT (user_id, badge_id) DO NOTHING;

  -- 4. user_badges から取得 (新規 or 既存)
  SELECT obtained_at INTO v_badge_obtained_at
  FROM user_badges WHERE user_id = p_user_id AND badge_id = v_badge_id;

  -- 5. レスポンス JSON 構築
  RETURN jsonb_build_object(
    'completed_at', v_completed_at,
    'badge_awarded', jsonb_build_object(
      'code', 'tutorial_complete',
      'name', v_badge_name,
      'obtained_at', v_badge_obtained_at,
      'icon_url', v_badge_icon_url
    ),
    'already_completed', v_was_already
  );
END;
$$;

COMMENT ON FUNCTION complete_handson_tour IS
  'ハンズオンチュートリアルの卒業処理: profile UPDATE + tutorial_complete バッジ INSERT を atomic に実行 (family/09)';


-- =========================================
-- 7. (任意) DB トリガー: sandbox 偽装防止 (defense in depth)
-- =========================================

-- v1 では実装せず、コメントアウト。v2 で必要なら有効化。
-- CREATE OR REPLACE FUNCTION check_meal_logs_sandbox_eligibility() ... 略

COMMIT;

-- =====================================================
-- Migration End
-- =====================================================
```

---

## 3. ロールバック SQL

```sql
-- =====================================================
-- Migration Rollback: handson_tour
-- Date: 2026-05-XX
-- =====================================================

BEGIN;

-- 1. RPC 関数を DROP
DROP FUNCTION IF EXISTS complete_handson_tour(uuid);
DROP FUNCTION IF EXISTS user_has_non_sandbox_activity(uuid);

-- 2. インデックスを DROP
DROP INDEX IF EXISTS uniq_user_sandbox_menu;
DROP INDEX IF EXISTS uniq_user_sandbox_meal;
DROP INDEX IF EXISTS idx_meal_logs_user_non_sandbox;
DROP INDEX IF EXISTS idx_user_profiles_handson_tour_pending;

-- 3. 既存 user_badges から tutorial_complete を削除 (existence check 後)
DELETE FROM user_badges
WHERE badge_id IN (SELECT id FROM badges WHERE code = 'tutorial_complete');

-- 4. badges から tutorial_complete を削除
DELETE FROM badges WHERE code = 'tutorial_complete';

-- 5. weekly_menus から is_sandbox 列を削除
ALTER TABLE weekly_menus DROP COLUMN IF EXISTS is_sandbox;

-- 6. meal_logs から is_sandbox 列を削除
ALTER TABLE meal_logs DROP COLUMN IF EXISTS is_sandbox;

-- 7. user_profiles から 2 列を削除
ALTER TABLE user_profiles
  DROP COLUMN IF EXISTS handson_tour_completed_at,
  DROP COLUMN IF EXISTS handson_tour_skipped_at;

COMMIT;
```

---

## 4. テスト用 seed

開発環境で動作確認用:

```sql
-- =====================================================
-- Test Seed: handson_tour (開発・E2E 用)
-- =====================================================

-- 新規ユーザー (ハンズオン未完了、対象)
INSERT INTO users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'e2e-tour-new-user@homegohan.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, nickname, gender, age, height_cm, weight_kg, nutrition_goal, onboarding_completed_at, roles) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'テスト 太郎',
  'male',
  30,
  170,
  65,
  'maintain',
  now() - INTERVAL '5 minutes',
  ARRAY['user']::text[]
)
ON CONFLICT (user_id) DO NOTHING;

-- ハンズオン完了済ユーザー (force=1 シナリオ用)
INSERT INTO users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'e2e-tour-completed@homegohan.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, nickname, ..., handson_tour_completed_at) VALUES (
  '22222222-2222-2222-2222-222222222222',
  'テスト 花子',
  ...,
  now() - INTERVAL '7 days'
)
ON CONFLICT (user_id) DO NOTHING;

-- admin ロールユーザー
INSERT INTO users (id, email) VALUES
  ('33333333-3333-3333-3333-333333333333', 'e2e-tour-admin@homegohan.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, nickname, ..., roles) VALUES (
  '33333333-3333-3333-3333-333333333333',
  'テスト 管理者',
  ...,
  ARRAY['user', 'admin']::text[]
)
ON CONFLICT (user_id) DO NOTHING;
```

---

## 5. RLS テスト用クエリ

```sql
-- 自分の handson_tour_completed_at を読める
SELECT handson_tour_completed_at FROM user_profiles WHERE user_id = auth.uid();

-- 他人のは読めない (RLS で空)
SELECT handson_tour_completed_at FROM user_profiles
WHERE user_id != auth.uid()
LIMIT 5;

-- admin ロールなら他人も読める
SELECT user_id, handson_tour_completed_at FROM user_profiles
WHERE handson_tour_completed_at IS NOT NULL
LIMIT 10;
```

---

## 6. 検証クエリ (post-migration)

```sql
-- 1. 列が追加されているか
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'user_profiles' AND column_name LIKE 'handson_tour%';
-- 期待: 2 行

SELECT column_name FROM information_schema.columns
WHERE table_name = 'meal_logs' AND column_name = 'is_sandbox';
-- 期待: 1 行

SELECT column_name FROM information_schema.columns
WHERE table_name = 'weekly_menus' AND column_name = 'is_sandbox';
-- 期待: 1 行

-- 2. インデックスが追加されているか
SELECT indexname FROM pg_indexes
WHERE tablename IN ('user_profiles', 'meal_logs', 'weekly_menus')
  AND (indexname LIKE '%handson_tour%' OR indexname LIKE '%sandbox%');
-- 期待: 4 件 (idx_user_profiles_handson_tour_pending, idx_meal_logs_user_non_sandbox, uniq_user_sandbox_meal, uniq_user_sandbox_menu)

-- 3. tutorial_complete バッジが seed されているか
SELECT code, name FROM badges WHERE code = 'tutorial_complete';
-- 期待: 1 行

-- 4. RPC 関数が動作するか
SELECT user_has_non_sandbox_activity('11111111-1111-1111-1111-111111111111'::uuid);
-- 期待: false (新規ユーザーは活動なし)
```

---

## 7. パフォーマンス検証

```sql
-- インデックスを使うか (EXPLAIN)
EXPLAIN ANALYZE
SELECT user_id FROM user_profiles
WHERE handson_tour_completed_at IS NULL AND handson_tour_skipped_at IS NULL
LIMIT 100;
-- 期待: Index Scan using idx_user_profiles_handson_tour_pending

EXPLAIN ANALYZE
SELECT * FROM meal_logs
WHERE user_id = '11111111-1111-1111-1111-111111111111'
ORDER BY eaten_at DESC
LIMIT 20;
-- 期待: Index Scan using idx_meal_logs_user_non_sandbox (or 既存 PK)
```

---

## 8. 失敗時の対処

### 8.1 migration 失敗時

```sql
-- ROLLBACK は migration ファイル全体に対して自動 (BEGIN/COMMIT 区切り)
-- 部分的な変更を残さないため、必ず BEGIN/COMMIT で囲む
```

### 8.2 ロールバック失敗時

```sql
-- 各 DROP IF EXISTS で冪等
-- もし IF EXISTS なしの場合は手動で確認:
SELECT column_name FROM information_schema.columns
WHERE table_name='user_profiles' AND column_name='handson_tour_completed_at';
-- 存在すれば DROP 実行
```

### 8.3 unique 制約違反

ロールバック後 (column 復元) に既存データに重複 sandbox 行があると INSERT エラー:

```sql
-- 重複検出
SELECT user_id, COUNT(*) FROM meal_logs
WHERE is_sandbox = true GROUP BY user_id HAVING COUNT(*) > 1;

-- 重複削除 (古い方を残す)
DELETE FROM meal_logs ml
WHERE is_sandbox = true
AND id NOT IN (
  SELECT MIN(id) FROM meal_logs
  WHERE is_sandbox = true
  GROUP BY user_id
);
```

---

## 9. 注意事項

### 9.1 RPC 関数の実行権限

`SECURITY DEFINER` で定義しているので、関数所有者の権限で実行される。`SET search_path = public` でセキュリティ強化。

API 経由でのみ呼び出すため、直接の REST API 公開はしない:

```sql
-- 関数を anon ロールから直接呼べないようにする
REVOKE EXECUTE ON FUNCTION user_has_non_sandbox_activity(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION user_has_non_sandbox_activity(uuid) TO service_role;
```

### 9.2 既存データへの影響

- 既存ユーザーの user_profiles 行は影響なし (新規列は NULL default)
- 既存 meal_logs / weekly_menus 行の `is_sandbox` は false (DEFAULT)
- 既存 user_badges / badges に新規 1 行追加のみ (重複なし)

### 9.3 デプロイタイミング

- migration 適用は API デプロイより**前**に行う
- 後にすると、新しい API コードが古い DB スキーマを参照してエラー
- 逆順 (API 先 → migration 後) も避ける (DB を見る側が混乱)

正しい順序:
1. migration 適用 (DB スキーマ更新)
2. API デプロイ (新スキーマを使うコード)
3. UI デプロイ (新 API を呼ぶ UI)

ロールバック時は逆順:
1. UI ロールバック
2. API ロールバック
3. DB ロールバック

---

## 10. テストケース (migration)

### 10.1 idempotency
- 同じ migration を 2 回実行 → エラーなし、結果同じ

### 10.2 ロールバック → 再 migration
- migration → ロールバック → migration → 結果元通り

### 10.3 既存データ保護
- migration 前に作成した user_profiles 行が migration 後も存在
- handson_tour_completed_at が NULL になっていることを確認

---

## 11. 残不確実性 (§99 連携)

- [ ] migration 適用タイミング (Phase 1 の最初に手動 vs CI で自動)
- [ ] `user_badges (user_id, badge_id)` PRIMARY KEY 構成の確認 (operator/01 既存スキーマ)
- [ ] `badges` テーブルの `code` 列の UNIQUE 制約 (ON CONFLICT 用)
- [ ] DB トリガー (defense in depth) を v1 で有効化するか
- [ ] migration ファイル名の命名規則 (timestamp + 説明、既存に合わせる)
