-- rollback: 20261008200100_unify_feature_flags_seed.sql
-- この migration が feature_flags に作った 4 行 (ai_chat_enabled / maintenance_mode / menu_generation_v5_wrapped /
-- menu_generation_v5_direct) を消す。表・RLS・権限・system_settings には触れない。
--
-- 消すのは、key と description の両方が migration が書いた文面と一致する行だけ。
--   - migration より前から本番にあった同じ key の行 (ON CONFLICT DO NOTHING で触らなかった行) は、description が違うので消えない。
--   - 運営画面で description を書き換えた行は、migration が作った行でも消えずに残る。残った行は、運営画面 (/super-admin/flags) から手で消せる。
--   - enabled を切り替えただけの行は、description が同じなので消える (切り替えた状態も一緒に消える)。
--
-- 先にアプリのデプロイを戻すこと。このロールバックを先に当てても、新しいアプリは「行が無い」ときの既定値
-- (ai_chat_enabled = ON / maintenance_mode = OFF / menu_generation_v5_* = ON) で動き続けるので止まらないが、
-- 運営画面で切り替えた状態 (たとえばメンテナンスモード ON) は失われる。
-- 古いアプリは feature_flags ではなく system_settings.feature_flags を読む (その行はこの migration では変えていない)。
--
-- 何度流しても同じ結果になる (冪等)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

DELETE FROM public.feature_flags AS f
USING (
  VALUES
    (
      'ai_chat_enabled',
      'AI 相談チャットの緊急停止スイッチ。通常は ON のままにする。OFF にすると AI 相談の API が 503 を返す。読み出しに失敗したときは ON として動く。(#1148 で作成)'
    ),
    (
      'maintenance_mode',
      'メンテナンスモード。ON にすると、運営 (admin / super_admin) 以外にメンテナンス中の画面を出す。読み出しに失敗したときは OFF として動く。(#1148 で作成)'
    ),
    (
      'menu_generation_v5_wrapped',
      '献立生成のエンジン切り替え (週間・1 日・1 食・AI 相談のアクション)。ON で v5、OFF で v4。(#1148 で作成。以前は system_settings の feature_flags)'
    ),
    (
      'menu_generation_v5_direct',
      '汎用の献立生成 API (/api/ai/menu/v4/generate) のエンジン切り替え。ON で v5、OFF で v4。(#1148 で作成。以前は system_settings の feature_flags)'
    )
) AS seeded (key, description)
WHERE f.key = seeded.key
  AND f.description = seeded.description;
