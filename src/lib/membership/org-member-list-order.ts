// src/lib/membership/org-member-list-order.ts
// 組織のメンバーの名前の一覧の並び (#2128 V3)。
//
// 組織のメンバーの一覧 (GET /api/org/members) とオーナーの譲渡の候補 (GET /api/org/owner-transfer/candidates) は、
// 参加した日 (user_profiles.joined_org_at) の古い順に並べる。joined_org_at は date 型なので、同じ日に入った人
// (運営が作った組織のオーナーと、同じ日に入ったメンバーなど) が並びの鍵で区別できず、読み込みのたびに順が入れ替わりえた。
// そこで DB の並び (PostgREST の order を重ねる) を次の 3 つの鍵で決める:
//   1. 参加した日の古い順。参加した日が空の行 (承認待ちなど) は最後 (PostgreSQL の昇順の既定と同じ。明示する)
//   2. 同じ日は組織内の役割の順で、オーナー → 管理者 → メンバー。org_role は enum org_role_enum
//      (宣言の順は 'owner', 'admin', 'member') で、PostgreSQL は enum を宣言の順で並べるので、昇順がこの順になる
//      (宣言の順は tests/org-member-list-order-2128.test.ts が migration と突き合わせる)
//   3. その中は id の順 (一意の鍵で終えるので、同じ日・同じ役割の人の順も変わらない)

import { orderListBy, type OrderableQuery } from '@/lib/api/list-order';

/** PostgREST の order に渡す 1 つの並びの鍵 */
export interface OrgMemberListOrderKey {
  column: 'joined_org_at' | 'org_role' | 'id';
  options: { ascending: boolean; nullsFirst: boolean };
}

/** 組織のメンバーの名前の一覧の並びの鍵 (先頭ほど強い) */
export const ORG_MEMBER_LIST_ORDER: readonly OrgMemberListOrderKey[] = [
  { column: 'joined_org_at', options: { ascending: true, nullsFirst: false } },
  { column: 'org_role', options: { ascending: true, nullsFirst: false } },
  { column: 'id', options: { ascending: true, nullsFirst: false } },
];

/** 問い合わせに ORG_MEMBER_LIST_ORDER の順で order を重ねる (重ね方はほかの一覧と同じ orderListBy。src/lib/api/list-order.ts) */
export function orderOrgMemberList<Query extends OrderableQuery<Query>>(query: Query): Query {
  return orderListBy(query, { keys: ORG_MEMBER_LIST_ORDER });
}
