-- rollback: 20261007160700_apply_coupon_rpc.sql
-- public.apply_coupon (#1224) を消す。テーブル・制約・インデックス・データは migration で一切変えていないので、戻すものは関数だけ。
--
-- 先に Web のデプロイ (src/lib/plan/coupon.ts の applyCoupon が apply_coupon を呼ぶ版) を #1224 より前の版に戻すこと。
-- 先にこのロールバックを当てると、POST /api/super-admin/coupons/[id]/apply が 500 になる
-- (PostgREST の PGRST202: Could not find the function)。
-- 戻したあとは、per_user_limit / 組織上限の check-then-act の競合と、旧 redemption の終了〜新規 INSERT の非原子性が復活する (#1224)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。
--
-- 何度流しても同じ結果になる (冪等)。この関数で作られた redemption / uses_count は通常のデータなので残る。

DROP FUNCTION IF EXISTS public.apply_coupon(UUID, TEXT, UUID, UUID);
