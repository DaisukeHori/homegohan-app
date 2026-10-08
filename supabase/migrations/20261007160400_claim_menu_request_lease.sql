-- migration: 20261007160400_claim_menu_request_lease.sql
-- #1202: 献立生成キューが「動いているワーカーの仕事」を止まったと見なして取り直し、多段階の生成を二重に処理する問題の修正
--
-- 背景:
--   claim_menu_request(p_worker_id) は cron (毎分) が呼び、待機中 (queued) の行か、止まった処理中 (processing) の行を 1 件取る。
--   「止まった」の判定が worker_acquired_at < now() - interval '5 minutes' だけだった。
--   worker_acquired_at は取った瞬間 (最初の claim) にしか書かれない。一方で Edge Function (generate-menu-v5) は
--   Step1〜6 を自分自身への再帰呼び出しでつないで進めるため、生成が 5 分を超える (Ultimate Mode など) と、
--   1 本目のチェーンが動いている最中に cron が同じ行を取り直し、2 本目の generate-menu-v5 を起動する。
--   2 本目は _continue 無しで呼ばれるので Step1 から始め直し (current_step を巻き戻す)、同じ request に 2 本が並走する。
--   Step3 (保存) へ進む直前の clearExistingPlannedMeals (Step2 の最後) が交互に動くと、片方の保存結果をもう片方が消し、
--   最終状態が不定になる。LLM の呼び出しも二重に課金される。
--   ところが Edge Function は、進捗を書くたびに updated_at を更新している (updateProgress)。
--   「生きているか」の信号は updated_at にすでに出ているのに、claim がそれを見ていなかった。
--
-- 変更 (claim_menu_request だけ。署名・戻り値・SECURITY DEFINER・search_path・所有者・実行権限は従来のまま):
--   processing の行を取り直す条件を次のとおり変える。
--     変更前: worker_acquired_at < now() - interval '5 minutes'
--     変更後: worker_acquired_at IS NOT NULL
--             AND GREATEST(worker_acquired_at, updated_at) < now() - interval '5 minutes'
--   = 「最後に生きていた時刻」(取った時刻と、最後に進捗を書いた時刻の新しいほう) から 5 分たった行だけを、止まったと見なす。
--     - 動いているチェーンは、数十秒ごとに updated_at を更新するので、5 分を超える生成でも取り直されない。
--     - 取った直後でまだ進捗が無い行は、worker_acquired_at から 5 分間は取り直されない (従来と同じ)。
--     - updated_at が NULL の行は、GREATEST が NULL を無視するので worker_acquired_at だけで判定する。
--     - worker_acquired_at が NULL の processing 行は、従来どおり取り直さない。weekly/request・v4/generate・
--       meal/generate などは status='processing' で行を作り (worker_id / worker_acquired_at は NULL のまま)、
--       generate-menu-v5 を直接呼ぶ。これらはキューの管理下に無く、updated_at だけを見る条件にすると
--       cron が横取りしてしまうので、「キューが取った行 (worker_acquired_at が入っている行)」に限る。
--   取り直し側の再開 (_continue で current_step から続ける) と、最終 status 書き込みの CAS は、同じ PR のアプリ側の変更。
--
-- 変えないもの:
--   - attempt_count < 3 の上限、queued 行の取り方、上限に達した queued 行を failed にする処理、ORDER BY created_at ASC。
--   - 並行して取りに来ても 1 本だけが取る性質 (FOR UPDATE SKIP LOCKED。条件は再評価されるので、取られた行は条件から外れる)。
--   - SET search_path TO 'public' (従来の属性のまま。本文のテーブル参照は public. で修飾した)。
--   - 実行権限: PUBLIC・anon・authenticated は不可、service_role のみ可 (cron が service role で呼ぶ)。
--     CREATE OR REPLACE は既存の権限を保つが、この migration だけで読めるよう、最後に同じ権限を明示する。
--
-- データへの影響: なし。この migration は関数の本文を差し替えるだけで、既存の行を UPDATE / DELETE しない。
--   適用後の最初の cron から新しい条件で判定する。取り直す行の集合は従来の部分集合 (GREATEST(...) < 基準時刻 なら
--   worker_acquired_at < 基準時刻 も成り立つ) なので、適用によって新たに取り直される行は無い。
--   動いている最中の処理が、取り直されなくなるだけ。
--
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT なので、何度流しても同じ結果になる。
-- 確認: tests/integration/rls/claim-menu-request-lease.test.ts (13 件。この migration の確認は L-1〜L-6・K-1〜K-4 の 10 件。
--       修正前は L-1・L-2 が失敗し、この migration の後は全件成功する。F-1〜F-3 は同じ PR の Edge Function 側の確認)
-- ロールバック: supabase/rollbacks/20261007160400_claim_menu_request_lease.down.sql
--   (戻すと #1202 の二重処理が復活する。アプリ側の変更は、DB が古い条件でも安全に動く)

CREATE OR REPLACE FUNCTION public.claim_menu_request(p_worker_id text)
  RETURNS public.weekly_menu_requests
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_row public.weekly_menu_requests;
BEGIN
  -- まず attempt_count >= 3 かつ status='queued' のレコードを failed に遷移
  UPDATE public.weekly_menu_requests
  SET status = 'failed',
      error_message = 'attempt_limit_exceeded',
      updated_at = now()
  WHERE status = 'queued'
    AND attempt_count >= 3;

  -- 通常の claim: attempt_count < 3 のみ対象
  --   queued     : そのまま取る
  --   processing : キューが取った行 (worker_acquired_at IS NOT NULL) のうち、最後に生きていた時刻
  --                GREATEST(worker_acquired_at, updated_at) から 5 分たった行だけを、止まったと見なして取り直す (#1202)。
  --                updated_at は Edge Function が進捗を書くたびに更新される (動いているチェーンの生存信号)。
  --                worker_acquired_at が NULL の行 (weekly/request など、キューを経由しない行) は対象にしない。
  UPDATE public.weekly_menu_requests
  SET status = 'processing',
      worker_id = p_worker_id,
      worker_acquired_at = now(),
      attempt_count = attempt_count + 1
  WHERE id = (
    SELECT id FROM public.weekly_menu_requests
    WHERE (
      (status = 'queued' AND attempt_count < 3)
      OR (
        status = 'processing'
        AND worker_acquired_at IS NOT NULL
        AND GREATEST(worker_acquired_at, updated_at) < now() - interval '5 minutes'
        AND attempt_count < 3
      )
    )
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_menu_request(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_menu_request(text) TO service_role;
