/**
 * 組織のメンバーの一覧の画面とオーナーの譲渡の画面の画面テストで、一覧の API の GET を差し替える部品 (#2073 S4)。
 *
 * 2 つの画面は、以前は user_profiles を Supabase の問い合わせで直接読んでいた (RLS で本人の行しか返らず、本番では他人が出なかった)。
 * いまは GET /api/org/members と GET /api/org/owner-transfer/candidates を呼ぶ。既存の画面テストは一覧の結果を
 * 以前の問い合わせと同じ { data, error } で書いているので、それをそのまま API の応答に直して返す:
 *   - error が null でない → 500 (画面は「読み込めませんでした」を出す)
 *   - そうでなければ 200 で { members: data } / { candidates: data } (data が null なら空の配列)
 *   - 結果を返す関数が reject したら、fetch も reject する (通信の失敗)
 */

/** 一覧の結果 (以前の Supabase の問い合わせの結果と同じ形) */
export type OrgMemberListResult = { data: unknown; error: unknown };
/** 関数なら呼ぶたびに決める (読み直しで中身を変えるため)。reject を返すと通信の失敗の筋書きになる */
export type OrgMemberListSource = OrgMemberListResult | (() => OrgMemberListResult | Promise<OrgMemberListResult>);

/** 一覧の API の経路と、応答の本文で一覧を入れるキー */
const ORG_MEMBER_LIST_APIS = [
  { path: '/api/org/members', key: 'members' },
  { path: '/api/org/owner-transfer/candidates', key: 'candidates' },
] as const;

/** HTTP の 200 / 500 (応答の状態) */
const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** 画面が読み込みの失敗のときに受け取る本文 (画面は文を出さないので中身は問わない) */
const LIST_FAILURE_BODY = { error: 'サーバーエラーが発生しました' };

/** 一覧の API の GET なら、本文で一覧を入れるキーを返す。それ以外は null */
export function orgMemberListKeyOf(input: unknown, init?: RequestInit): 'members' | 'candidates' | null {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return null;
  const pathname = new URL(String(input), 'http://localhost').pathname;
  return ORG_MEMBER_LIST_APIS.find((api) => api.path === pathname)?.key ?? null;
}

/** 一覧の結果を API の応答にする */
export async function orgMemberListResponse(
  key: 'members' | 'candidates',
  source: OrgMemberListSource,
): Promise<Response> {
  const result = await (typeof source === 'function' ? source() : source);
  if (result.error !== null && result.error !== undefined) {
    return new Response(JSON.stringify(LIST_FAILURE_BODY), {
      status: HTTP_INTERNAL_SERVER_ERROR,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ [key]: result.data ?? [] }), {
    status: HTTP_OK,
    headers: { 'content-type': 'application/json' },
  });
}
