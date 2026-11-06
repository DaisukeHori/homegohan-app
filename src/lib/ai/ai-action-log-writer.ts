import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';

/**
 * AI 相談の提案の記録 (ai_action_logs) へ書くためのクライアント (service role。#2283 判断待ち 8 の前段 Y1)。
 *
 * この表は、利用者 (authenticated) には読むだけにした (後段の Y2 = supabase/migrations/20261107120000_ai_action_logs_select_only.sql
 * (#2291) で RLS と GRANT を絞った)。その前に、サーバーの書き込み (自動実行の行の作成と確定・実行の API の状態の更新・却下) を
 * すべてこのクライアントへ移した。利用者のセッションのクライアント (createClient) で書くと、権限で拒まれ (42501)、
 * 行が実行中の印のまま残る。
 * 読む経路 (GET の一覧・実行の API の行の探索・画面の読み込み直し) は利用者のセッションのままでよい。
 *
 * route は、本人の確認 (supabase.auth.getUser) を通したあとで、これを使って書く。RLS が効かないので、
 * 今まで RLS が担っていた持ち主の確認をコードで必ず行う:
 * - INSERT は、相談の行を読み、その user_id が本人であること (isConsultationSessionOwnedBy) を確かめてから、
 *   その相談の id を session_id にして作る
 * - UPDATE は、行を相談と結んで読み (ai_consultation_sessions!inner(user_id))、その相談の user_id が本人であること
 *   (isAiActionLogOwnedBy) を確かめた行の id に絞る
 *
 * 書き込みの受け手は、変数名 actionLogDb で受ける (tests/ai-action-logs-service-role-writes-2283.test.ts が、
 * この表への書き込みが actionLogDb からだけであることを、ソースから確かめる)。
 */
export function getAiActionLogWriter(): SupabaseClient {
  return getSupabaseAdmin();
}

/** 相談の行の持ち主の欄 (ai_consultation_sessions.user_id) */
interface ConsultationSessionOwner {
  user_id?: unknown;
}

/** 相談の行 (ai_consultation_sessions) の持ち主が本人か。行が無い・user_id が無いときは false */
export function isConsultationSessionOwnedBy(session: ConsultationSessionOwner | null | undefined, userId: string): boolean {
  return !!session && typeof session.user_id === 'string' && session.user_id === userId;
}

/**
 * 提案の記録の行 (相談と結んで読んだもの。ai_consultation_sessions!inner(user_id)) の相談の持ち主が本人か。
 * 行が無い・相談が結ばれていないときは false
 */
export function isAiActionLogOwnedBy(
  actionLog: { ai_consultation_sessions?: ConsultationSessionOwner | null } | null | undefined,
  userId: string,
): boolean {
  return !!actionLog && isConsultationSessionOwnedBy(actionLog.ai_consultation_sessions, userId);
}
