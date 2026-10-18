-- migration: 20261018060000_planner_badge_award_on_weekly_menu_completed.sql
-- 戻し方: supabase/rollbacks/20261018060000_planner_badge_award_on_weekly_menu_completed.down.sql
-- #1867 「計画上手」(planner) を、AI の週の献立の生成 (1 週間分の生成) が完了 (completed) した時点で、DB のトリガーで本人に付ける。
-- オーナーの選択 (2026-10-18 17 時台、選択式): 「取れる条件を足す」— AI で週の献立を初めて作ったときにも付くようにし、説明もそれに合わせる。
--
-- 背景:
--   付ける条件は「生成が成功して献立が保存された時点で本人に付ける」。献立を保存し終えて行を completed にするのは Edge Function
--   (generate-menu-v4 / v5) などの書き手で、画面が完了をどう知るかは画面ごとに違う (Web の週間献立の画面は行の変化 (Realtime) で知り、
--   状態の確認 GET /api/ai/menu/weekly/status のポーリングは Realtime が拾えなかったときの代替。モバイルは Realtime と行の直接の読み取りで知り、
--   状態の確認を呼ばない。モバイルにはバッジの一覧の画面も無い)。読む側 (状態の確認・バッジの一覧) だけで付けると、完了を読まない画面の利用者には付かない。
--   そこで、完了を書いた時点で、書き手を見分けずに行の列だけで付ける (20261016237000_push_outbox.sql の
--   weekly_menu_requests_enqueue_push と同じ形)。状態の確認とバッジの一覧の付与は、このトリガーが付け損ねたときの保険として残る。
--
-- 付ける条件 (行の列だけで決める):
--   - status が completed 以外から completed になった更新 (失敗 failed・中止・止まった行では付けない。completed は 1 食以上を保存した状態)
--   - 週の献立の生成の行: generated_data の印 weeklyRequest が true (src/lib/ai/weekly-menu-request-origin.ts の
--     WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY。行を作るときに 1 週間分の生成の経路だけが書く。利用者は weekly_menu_requests に書けない (#1465))。
--     更新後の行 (NEW) か更新前の行 (OLD) のどちらかに印があればよい (最後の書き込みが generated_data を丸ごと書き直しても、行を作ったときの印で見分ける)
--   - 付ける相手は行の持ち主 (user_id)。家族の人数分の献立でも依頼した本人だけ
--   - user_badges は (user_id, badge_id) が主キー。ON CONFLICT DO NOTHING なので、お試しの献立の追加などで付いていれば何もしない (獲得日時も変えない)
-- 書き手の権限に依らず付けられるよう SECURITY DEFINER にする (所有者 = migration を流す postgres。user_badges には利用者の INSERT ポリシーが無い)。
-- 付与の失敗で献立の最終の書き込みを止めない: 例外は WARNING にして NEW を返す。
-- トリガー関数は呼び出しの権限を見ないので、EXECUTE は誰にも付けない (anon-definer-execute の番兵の対象)。
-- トリガー関数は PostgREST の RPC として呼べないので、src/types/database.types.ts は変わらない。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS)。

CREATE OR REPLACE FUNCTION public.award_planner_badge_on_weekly_menu_completed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  -- 付けるバッジ (badges.code)。src/lib/badges/awardable.ts の 'planner' と同じ
  c_badge_code CONSTANT text := 'planner';
  -- 週の献立の生成の印のキー。src/lib/ai/weekly-menu-request-origin.ts の WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY と同じ値
  -- (tests/planner-badge-weekly-menu-trigger-migration-contract.test.ts が突き合わせる)
  c_origin_key CONSTANT text := 'weeklyRequest';
  -- 印の値を ->> で text として取り出したときの形 (JSON の true)
  c_origin_value CONSTANT text := 'true';
  v_badge_id uuid;
BEGIN
  -- WHEN 句で絞ってあるが、関数だけでも同じ条件を守る
  IF NEW.status IS DISTINCT FROM 'completed' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF (NEW.generated_data ->> c_origin_key) IS DISTINCT FROM c_origin_value
     AND (OLD.generated_data ->> c_origin_key) IS DISTINCT FROM c_origin_value THEN
    RETURN NEW;
  END IF;

  SELECT b.id INTO v_badge_id FROM public.badges AS b WHERE b.code = c_badge_code;
  IF v_badge_id IS NULL THEN
    -- マスターに無い (seed 漏れなど)。付けられないが、気付けるよう警告を残す (awardBadge の warn と同じ扱い)
    RAISE WARNING 'award_planner_badge_on_weekly_menu_completed: badge % is not in badges (request %)', c_badge_code, NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO public.user_badges (user_id, badge_id, obtained_at)
  VALUES (NEW.user_id, v_badge_id, now())
  ON CONFLICT (user_id, badge_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'award_planner_badge_on_weekly_menu_completed: % (request %)', SQLERRM, NEW.id;
  RETURN NEW;
END;
$$;

-- 20261010123500_ops_alert_state.sql と同じ理由で完全形の REVOKE (PUBLIC と Supabase の既定の付与の両方を外す)
REVOKE ALL ON FUNCTION public.award_planner_badge_on_weekly_menu_completed() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS weekly_menu_requests_award_planner ON public.weekly_menu_requests;
CREATE TRIGGER weekly_menu_requests_award_planner
  AFTER UPDATE OF status ON public.weekly_menu_requests FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'completed')
  EXECUTE FUNCTION public.award_planner_badge_on_weekly_menu_completed();
