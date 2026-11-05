/**
 * モバイルの AI 相談 (src/components/ai/AIAdvisorSheet.tsx) で、新しい相談の作成 (POST) の応答が時間切れになったあとに、
 * 読み直した一覧から作れていた相談を探す判定 (#2275 T2)。
 *
 * 作成はサーバーで済んでいることがある。以前のモバイルは時間切れの一文 (SESSION_CREATE_TIMEOUT_MESSAGE) をすぐ出すだけで、
 * 一覧を読み直さなかったので、利用者がもう一度『新しい相談を始める』を押すと空の相談がもう 1 つできた。Web の AI 相談
 * (src/components/AIChatBubble.tsx) は #2265 Q2・#2272 S2 で、時間切れなら一覧を読み直し、作成を始める前に見えていなかった
 * 相談を選ぶ (sessionCreatedSince)。モバイルはルートの src/ を import できない (リポジトリ直下の .easignore が /src/ を除外し、
 * EAS のビルドのアーカイブに入らない) ので、同じ判定をここに写して持つ。判定が Web と一致することは
 * tests/mobile-ai-session-created-since-2275.test.ts が Web の関数と同じ入力で突き合わせて確かめる。
 */

/** 判定に使う相談の項目 (一覧の GET /api/ai/consultation/sessions?status=all の 1 件。Web の Session と同じ名前の項目) */
export type CreatedSessionCandidate = {
  id: string;
  messageCount: number;
  status?: string;
};

/**
 * 新しい相談の作成の応答が返らなかったあとに読み直した一覧 (sessions) から、作成を始める前に見えていた相談 (knownIds。一覧に出た
 * 相談と、この画面で作れた相談) に無い、終了していない・メッセージの無い相談を探す (Web の sessionCreatedSince と同じ判定)。
 * 一覧は更新の新しい順なので、先頭の 1 つを選ぶ
 */
export function sessionCreatedSince<S extends CreatedSessionCandidate>(
  sessions: readonly S[],
  knownIds: ReadonlySet<string>,
): S | undefined {
  return sessions.find((s) => !knownIds.has(s.id) && s.status !== "closed" && s.messageCount === 0);
}
