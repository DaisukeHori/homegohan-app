// src/lib/api/list-order.ts
// 一覧の並びの鍵を 1 か所にまとめる (#2134 U2)。
//
// 一覧を 1 つの鍵 (作った日時・始まる日・参加した日など) だけで並べると、同じ値の行の順は DB 任せで、
// 開くたびに入れ替わりうる (ページ送りのある一覧では、ページの境目で同じ行が 2 回出る・どのページにも出ない、もありうる)。
// そこでどの一覧も、最後に一意の鍵 id の昇順を重ねて順を決める (組織のメンバーの一覧の orderOrgMemberList と同じ考え方。
// src/lib/membership/org-member-list-order.ts)。
//
// 一覧ごとの鍵は LIST_ORDERS に書き、route は orderListBy(問い合わせ, LIST_ORDERS.<一覧>) で並べる
// (route に .order( を直接書かない。tests/list-order-tiebreak-2134.test.ts が走査で守る)。
// NULL の位置は、いままでの order (nullsFirst を省いた PostgreSQL の既定: 昇順は最後・降順は最初) と同じ値を明示する。

/** PostgREST の order に渡す 1 つの並びの鍵 */
export interface ListOrderKey {
  column: string;
  options: { ascending: boolean; nullsFirst: boolean };
}

/** 1 つの一覧の並び: 読む表と、並びの鍵 (先頭ほど強い) */
export interface ListOrder {
  table: string;
  keys: readonly ListOrderKey[];
}

/** order を重ねられる問い合わせ (supabase-js の PostgrestFilterBuilder など) */
export interface OrderableQuery<Query> {
  order(column: string, options: { ascending: boolean; nullsFirst: boolean }): Query;
}

/** 最後に重ねる一意の鍵 (どの一覧の表も主キー id を持つ) */
export const ID_TIEBREAK_KEY: ListOrderKey = { column: 'id', options: { ascending: true, nullsFirst: false } };

/** 昇順 (NULL は最後。PostgreSQL の昇順の既定と同じ) */
function ascending(column: string): ListOrderKey {
  return { column, options: { ascending: true, nullsFirst: false } };
}

/** 降順 (NULL は最初。PostgreSQL の降順の既定と同じ) */
function descending(column: string): ListOrderKey {
  return { column, options: { ascending: false, nullsFirst: true } };
}

/** 並びの鍵のあとに id の昇順を重ねた一覧の並び */
function withIdTiebreak(table: string, keys: readonly ListOrderKey[]): ListOrder {
  return { table, keys: [...keys, ID_TIEBREAK_KEY] };
}

/** 一覧ごとの並び (route の名前で引く) */
export const LIST_ORDERS = {
  /** GET /api/org/my-challenges: 始まる日 (date 型) の新しい順。同じ日に始まるチャレンジは id の順 */
  orgMyChallenges: withIdTiebreak('organization_challenges', [descending('start_date')]),
  /** GET /api/org/challenges: 作った日時の新しい順 */
  orgChallenges: withIdTiebreak('organization_challenges', [descending('created_at')]),
  /** GET /api/org/invites: 作った日時の新しい順 */
  orgInvites: withIdTiebreak('organization_invites', [descending('created_at')]),
  /** GET /api/org/departments: 表示の順 → 作った日時の古い順 */
  orgDepartments: withIdTiebreak('departments', [ascending('display_order'), ascending('created_at')]),
  /** GET /api/operator/membership/audit: 記録した日時の新しい順 (ページ送りがあるので、境目の重なり・抜けも防ぐ) */
  operatorMembershipAudit: withIdTiebreak('membership_audit', [descending('created_at')]),
  /**
   * GET /api/operator/membership/org/[id]/candidates: 最終ログインの新しい順・まだログインしていない人は最後。
   * last_login_at はログインのたびにトリガー on_auth_session_created (関数 auth_session_created) が書く
   * (supabase/migrations/20261016243000_auth_history_sessions.sql)。移行の前からログインしていない人は空のまま
   */
  operatorOrgTransferCandidates: withIdTiebreak('user_profiles', [
    { column: 'last_login_at', options: { ascending: false, nullsFirst: false } },
  ]),
  /** GET /api/operator/membership/family/[id]/candidates: 家族に入った日時の古い順 */
  operatorFamilyTransferCandidates: withIdTiebreak('family_members', [ascending('joined_at')]),
} as const satisfies Record<string, ListOrder>;

/** 問い合わせに鍵の順で order を重ねる (先に重ねた鍵ほど強い。PostgREST の order=a.asc,b.asc) */
export function orderListBy<Query extends OrderableQuery<Query>>(query: Query, order: { keys: readonly ListOrderKey[] }): Query {
  return order.keys.reduce((ordered, key) => ordered.order(key.column, key.options), query);
}
