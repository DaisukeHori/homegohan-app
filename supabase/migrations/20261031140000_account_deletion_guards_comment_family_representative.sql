-- migration: 20261031140000_account_deletion_guards_comment_family_representative.sql
-- 戻し方: supabase/rollbacks/20261031140000_account_deletion_guards_comment_family_representative.down.sql
-- #2150 Q4: 表 account_deletion_guards (退会の印) の本番のコメントに、家族の代表者のトリガーも印を読むことを書く。
--
-- 背景:
--   表のコメント (20261031130000_object_comments_trigger_names.sql が出し直した文) は、印を読むものとして
--   「トリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting) が組織の作成で読む」だけを書いていた。
--   20261023150000_account_deletion_family_representative_guard.sql の関数 family_groups_representative_not_deleting も
--   public.account_deletion_guards を読み、同じ migration の CREATE TRIGGER が trg_representative_not_deleting
--   (family_groups の BEFORE INSERT OR UPDATE OF representative_id = 家族の作成と代表者の変更) を作る。
--   DB で印を読むものを探す人 (pg_description) が、家族の側のトリガーを見落とさないよう、コメントに両方を書く。
--   既存の migration は編集しない (CLAUDE.md) ので、新しい migration でコメントを出し直す。新しい文は、前の文の
--   「トリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting) が組織の作成で読む」を
--   「組織の作成ではトリガー … が、家族の作成と代表者の変更ではトリガー trg_representative_not_deleting
--   (関数 family_groups_representative_not_deleting) が読む」に置き換えただけで、ほかの文字は変えない。
--   関数の本文の中の -- のコメント (20261019120000_self_dissolve.sql・20261023130000_account_deletion_owner_guard.sql) は
--   COMMENT では直せない (関数を作り直す) ので、ここでは扱わない。
--
-- 変更: COMMENT ON TABLE の 1 文だけ。表・列・行・関数・トリガー・ポリシー・権限は変えない。
-- 既存データへの影響: なし (カタログのコメントだけ)。
-- 冪等: COMMENT ON は上書きなので、2 回続けて適用してもエラーにならず同じ結果になる。
-- ロック: COMMENT ON TABLE は account_deletion_guards に SHARE UPDATE EXCLUSIVE を取る (読み書きは止めない)。
--   待ちが長引かないよう lock_timeout を付ける。
-- 確かめるテスト: tests/account-deletion-guards-comment-family-representative-migration-contract.test.ts (文面)・
--   tests/plan-stripe-product-id-guard-trigger-naming.test.ts (関数の名前を「トリガー」と呼ぶ所が無い・本番に最後に効くコメントにも無い)
-- ロールバック: supabase/rollbacks/20261031140000_account_deletion_guards_comment_family_representative.down.sql

SET LOCAL lock_timeout = '10s';

COMMENT ON TABLE public.account_deletion_guards IS
  '#1917 の続き (D73): 退会の印。begin_account_deletion_guard が退会の始め (findBlocker の前) に付け、組織の作成ではトリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting) が、家族の作成と代表者の変更ではトリガー trg_representative_not_deleting (関数 family_groups_representative_not_deleting) が読む。退会が済むと auth.users の CASCADE で消える。直接は誰も読み書きしない';
