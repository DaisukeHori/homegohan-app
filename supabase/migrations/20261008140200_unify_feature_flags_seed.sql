-- migration: 20261008140200_unify_feature_flags_seed.sql
-- #1148: 機能フラグを feature_flags テーブル (運営画面で ON/OFF できる新しい仕組み) に一本化する。その最初の中身を入れる。
--
-- 背景:
--   機能フラグの置き場が 2 つあった。
--     (旧) system_settings の key = 'feature_flags' (1 行の JSON)。献立生成の 5 つの API とAI 相談のアクション実行が読んでいた
--          (src/lib/menu-generation-feature-flags.ts の loadFeatureFlags)。
--     (新) feature_flags テーブル。運営画面 (/super-admin/flags) と API (/api/super-admin/flags) が書き換える。
--          ただし、新しい側を読んでアプリの動きを変えるコードは、まだ 1 つも無かった。
--   旧は、ログイン中のユーザー自身の権限で system_settings を読んでいた。system_settings を SELECT できるのは
--   admin / super_admin だけ (RLS) なので、一般のユーザーの操作では値が読めず、いつも既定値 (ON) になっていた。
--   つまり、旧の値を変えても、一般のユーザーには効かなかった。新しい仕組みはサーバー側 (service_role) で読むので、全員に効く。
--
--   同じ PR で、アプリ側を次のとおり新しい仕組みに切り替える (旧の読み込み処理 loadFeatureFlags は削除する)。
--     - 献立生成の API 5 本 + AI 相談のアクション実行: menu_generation_v5_wrapped / menu_generation_v5_direct
--     - AI 相談の API: ai_chat_enabled (緊急停止スイッチ。OFF のとき 503)
--     - ミドルウェア: maintenance_mode (ON のとき、運営 (admin / super_admin) 以外にメンテナンス中の画面を出す)
--   この migration は、その 4 つのフラグの行を feature_flags に作る。
--
-- 変更 (feature_flags に 4 行を INSERT する。表の定義・RLS・権限は変えない):
--   key                         enabled の初期値
--   menu_generation_v5_wrapped  旧 system_settings の値 (JSON の true / false のときだけ引き継ぐ。無ければ ON)
--   menu_generation_v5_direct   同上
--   ai_chat_enabled             ON 固定 (緊急停止スイッチ。通常は ON のまま。AI への送信を止めるためのものではない)
--   maintenance_mode            OFF 固定
--
--   引き継ぎのルール (本番の挙動をデプロイで変えないため):
--     - menu_generation_v5_*: 旧の system_settings.feature_flags に、その名前の JSON の true / false があれば、その値で作る。
--       行が無い・オブジェクトでない・その名前が無い・true / false 以外 (文字列・数値・null など) のときは ON (旧のコードの既定値)。
--       true / false 以外は引き継がない: 旧は JavaScript の Boolean() で解釈しており ("false" という文字列でも ON になる)、
--       意図の分からない値を引き継いで全員の挙動を変えるより、既定値に倒す方が安全なため。
--       引き継いだ値が既定値 (ON) と違うときと、true / false 以外を見つけたときは、実行ログ (NOTICE) に残す。
--     - ai_chat_enabled / maintenance_mode: 旧の値は引き継がない。この 2 つは、これまでどのコードも読んでおらず
--       (DEFAULT の定義にだけあった)、system_settings に何が入っていても効いていなかった。
--       もし試しに入れた値 (ai_chat_enabled = false / maintenance_mode = true) が残っていて、それを引き継ぐと、
--       デプロイした瞬間に AI 相談が止まる・サイト全体がメンテナンス中になる。それを避けるため、
--       ai_chat_enabled は ON、maintenance_mode は OFF で作る。
--     - 旧の system_settings.feature_flags の行は消さない・書き換えない (もう読まれないだけ。ロールバックでそのまま使える)。
--
--   rollout_strategy / constraints は NULL (全ユーザーが対象)。created_by も NULL。
--   description に「#1148 で作った」ことを書く。ロールバックは、この文面と一致する行だけを消す。
--
-- 本番のデータへの影響:
--   feature_flags に最大 4 行が増えるだけ。既存の行は 1 行も書き換えない (ON CONFLICT (key) DO NOTHING)。
--   本番の feature_flags に同じ key の行がすでにあれば、その行はそのまま残り、この migration は何もしない。
--   既存の行の UPDATE / DELETE は含まない。
--   system_settings は読むだけ (書かない)。
--   本番の挙動への影響: 旧の system_settings.feature_flags が無い、または既定値と同じなら、変化なし (献立生成は v5、AI 相談は ON、メンテナンスは OFF)。
--     menu_generation_v5_* が OFF (false) で入っている場合だけ、一般のユーザーの献立生成が v5 から v4 に切り替わる
--     (旧は admin / super_admin の操作にしか効いていなかったため)。本番で次の SELECT を流して確かめてから merge すること (読み取り専用):
--       SELECT value FROM public.system_settings WHERE key = 'feature_flags';
--
-- 反映の遅れ: アプリはフラグの値をサーバーのメモリに最大 30 秒覚える。運営画面で切り替えても、全員に反映されるまで最大 30 秒かかる。
-- 読み出しに失敗した・行が無いときは、ai_chat_enabled = ON / maintenance_mode = OFF / menu_generation_v5_* = ON として動く (止めない側)。
--
-- 冪等: 何度流しても同じ結果になる。2 回目以降は、すでにある行に触れず、足りない行だけを作る。
--   (運営画面でフラグを切り替えたあとに流し直しても、切り替えは元に戻らない。)
-- 権限: GRANT / REVOKE はしない。feature_flags の RLS (super_admin だけ) も変えない。アプリはサーバー側 (service_role) で読む。
-- 確認: tests/integration/security/feature-flags-seed.test.ts
-- ロールバック: supabase/rollbacks/20261008140200_unify_feature_flags_seed.down.sql
-- マージ順: version の順 (この migration は 20261008140100 の後)。

DO $$
DECLARE
  v_settings jsonb;
  v_wrapped  boolean := true;
  v_direct   boolean := true;
BEGIN
  -- 旧: system_settings の key = 'feature_flags' (値は JSON のオブジェクト)。行が無ければ v_settings は NULL のまま
  SELECT s.value INTO v_settings
  FROM public.system_settings AS s
  WHERE s.key = 'feature_flags';

  IF v_settings IS NOT NULL AND jsonb_typeof(v_settings) = 'object' THEN
    IF jsonb_typeof(v_settings -> 'menu_generation_v5_wrapped') = 'boolean' THEN
      v_wrapped := (v_settings ->> 'menu_generation_v5_wrapped')::boolean;
    ELSIF (v_settings -> 'menu_generation_v5_wrapped') IS NOT NULL THEN
      RAISE NOTICE 'system_settings.feature_flags の menu_generation_v5_wrapped は true / false ではないため引き継がず、ON にします (型: %)',
        jsonb_typeof(v_settings -> 'menu_generation_v5_wrapped');
    END IF;

    IF jsonb_typeof(v_settings -> 'menu_generation_v5_direct') = 'boolean' THEN
      v_direct := (v_settings ->> 'menu_generation_v5_direct')::boolean;
    ELSIF (v_settings -> 'menu_generation_v5_direct') IS NOT NULL THEN
      RAISE NOTICE 'system_settings.feature_flags の menu_generation_v5_direct は true / false ではないため引き継がず、ON にします (型: %)',
        jsonb_typeof(v_settings -> 'menu_generation_v5_direct');
    END IF;
  END IF;

  IF NOT v_wrapped THEN
    RAISE NOTICE 'menu_generation_v5_wrapped = false を system_settings から feature_flags に引き継ぎます (献立生成は v4 になります)';
  END IF;
  IF NOT v_direct THEN
    RAISE NOTICE 'menu_generation_v5_direct = false を system_settings から feature_flags に引き継ぎます (/api/ai/menu/v4/generate は v4 になります)';
  END IF;

  INSERT INTO public.feature_flags (key, description, enabled)
  VALUES
    (
      'ai_chat_enabled',
      'AI 相談チャットの緊急停止スイッチ。通常は ON のままにする。OFF にすると AI 相談の API が 503 を返す。読み出しに失敗したときは ON として動く。(#1148 で作成)',
      true
    ),
    (
      'maintenance_mode',
      'メンテナンスモード。ON にすると、運営 (admin / super_admin) 以外にメンテナンス中の画面を出す。読み出しに失敗したときは OFF として動く。(#1148 で作成)',
      false
    ),
    (
      'menu_generation_v5_wrapped',
      '献立生成のエンジン切り替え (週間・1 日・1 食・AI 相談のアクション)。ON で v5、OFF で v4。(#1148 で作成。以前は system_settings の feature_flags)',
      v_wrapped
    ),
    (
      'menu_generation_v5_direct',
      '汎用の献立生成 API (/api/ai/menu/v4/generate) のエンジン切り替え。ON で v5、OFF で v4。(#1148 で作成。以前は system_settings の feature_flags)',
      v_direct
    )
  ON CONFLICT (key) DO NOTHING;
END
$$;
