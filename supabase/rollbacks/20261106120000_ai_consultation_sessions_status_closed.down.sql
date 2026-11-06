-- rollback: 20261106120000_ai_consultation_sessions_status_closed.sql
-- #2283 V2 の戻し口 (このファイルは supabase/rollbacks/20261106120000_ai_consultation_sessions_status_closed.down.sql。1 行目は対の migration の名前)。
-- AI 相談 (ai_consultation_sessions) の状態の制約 ai_consultation_sessions_status_check を、closed を足す前の 3 つ (active・completed・archived) に戻す。
-- 注意: 戻すと、「相談を終了」(閉じる route の status = 'closed' の書き換え) はまた 23514 で失敗し、500 を返す (適用前と同じ)。
-- closed の行の扱い: 戻すまでに閉じた相談 (status = 'closed' の行) は消さない・書き換えない (黙って行を消さない・状態を変えない)。
--   そのため NOT VALID で足し、VALIDATE しない (既存の行は確かめず、これから書く行だけが制約に従う)。
--   戻したあと、closed の行を書き換える UPDATE (どの列でも) は制約に合わず 23514 で失敗する。closed の行を active などへ
--   移すかどうかは、戻す前に別に決めて、その SQL を戻しの migration に足す (この戻し口は決めない)。
--   閉じた相談の要約の引き継ぎ (.eq('status', 'closed') の読み取り) は、残った closed の行を読み続ける。
-- 表の権限 (GRANT) には触れない (20261022190000 より後の戻し口の規律: TRUNCATE / ALL を付け直さない)。
-- 冪等: DROP CONSTRAINT IF EXISTS のあとに作る。2 回流しても同じ結果になる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.ai_consultation_sessions DROP CONSTRAINT IF EXISTS ai_consultation_sessions_status_check;

ALTER TABLE public.ai_consultation_sessions
  ADD CONSTRAINT ai_consultation_sessions_status_check CHECK (status = ANY (ARRAY[
    'active'::text,
    'completed'::text,
    'archived'::text
  ])) NOT VALID;
