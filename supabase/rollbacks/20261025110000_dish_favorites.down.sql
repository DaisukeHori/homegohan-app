-- rollback: 20261025110000_dish_favorites.sql
-- 献立の料理のお気に入りの表を外す。本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。
-- ⚠️ 先にアプリを戻すこと: src/modules/dish-favorites/server.ts (route 4 本) と個人データの書き出し (ACCOUNT_EXPORT_TABLES) が表を読む
--    (表が無いと、お気に入りの一覧・♥ の状態・保存・削除と、書き出しが 500 になる)。
-- 影響: 保存していたお気に入りはすべて消える。
-- 何度流しても同じ結果になる (DROP ... IF EXISTS。ポリシー・索引・トリガーは表と一緒に消える)。
-- anon / authenticated への GRANT は書かない (cross/02 §3.4)。

SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS public.dish_favorites;
