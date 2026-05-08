-- =====================================================
-- Migration: user_profiles_frozen_at
-- Source: operator/03-ui-spec.md ユーザー凍結機能
-- Purpose: 凍結状態を roles 配列への 'banned' 追加ではなく
--          専用列 frozen_at / frozen_reason / frozen_by で管理する
--          ('banned' は公式 12 ロール外のため使用禁止)
-- Idempotent: yes (IF NOT EXISTS / array_remove)
-- =====================================================

BEGIN;

-- ─── 凍結状態列の追加 ────────────────────────────────────────────────────────────

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS frozen_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS frozen_reason    TEXT NULL,
  ADD COLUMN IF NOT EXISTS frozen_by        UUID NULL REFERENCES auth.users(id);

COMMENT ON COLUMN user_profiles.frozen_at     IS '凍結日時。NULL = 凍結されていない / NOT NULL = 凍結中';
COMMENT ON COLUMN user_profiles.frozen_reason IS '凍結理由テキスト（最大 2000 文字想定）';
COMMENT ON COLUMN user_profiles.frozen_by     IS '凍結を実行した admin ユーザーの auth.users.id';

-- ─── 部分インデックス (凍結ユーザー検索用) ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_user_profiles_frozen
  ON user_profiles (user_id)
  WHERE frozen_at IS NOT NULL;

-- ─── 既存 'banned' ロールデータの cleanup ──────────────────────────────────────
-- roles 配列に 'banned' を持つユーザーがいれば frozen_at をセット + 'banned' を除去

UPDATE user_profiles
  SET
    frozen_at     = NOW(),
    frozen_reason = '(migration cleanup: ''banned'' ロール違反修正)',
    roles         = array_remove(roles, 'banned')
  WHERE 'banned' = ANY(roles);

COMMIT;
