-- rollback: 20261007112200_retire_legacy_promote_child_to_user.sql
-- このロールバックは意図的に何もしない。
-- 20261007112200 は、本人の同意なしに既存ユーザーを家族へ編入できた promote_child_to_user (#1232) を
-- 常に拒否する墓標に置き換え、(uuid, uuid) の旧版を消すもの。元に戻すと脆弱性が再燃するため、戻さない。
-- 子供メンバーの昇格は request_child_promotion → accept_child_promotion (本人同意フロー) で行う。

SELECT 1;
