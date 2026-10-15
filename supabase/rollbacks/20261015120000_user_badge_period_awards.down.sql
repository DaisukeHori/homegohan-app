-- rollback: 20261015120000_user_badge_period_awards.sql
-- 表 public.user_badge_period_awards (比較ランキングのバッジを取った期間。#1528) を消す。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻す順:
--   1. 先に、この表に書く Edge Function calculate-segment-stats を、表に書かない版へ戻してデプロイする
--      (表を先に消すと、確定の回 (JST 0:05) と再試行 (0:20・0:35) が「表が無い」で 500 になる)。
--   2. そのあとで、この内容を流す。
--   GET /api/badges は表を読めなくても一覧を返す (期間を添えないだけ) ので、Web を先に戻す必要は無い。
--
-- 影響:
--   - 期間ごとの記録 (2 回目以降に取った期間を含む) は消え、戻せない。user_badges (最初に取ったバッジの行) は残る。
--
-- 何度流しても同じ結果になる (DROP TABLE IF EXISTS。表のポリシー・権限も表と一緒に消える)。

DROP TABLE IF EXISTS public.user_badge_period_awards;
