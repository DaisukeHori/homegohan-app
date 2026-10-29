// src/schemas/membership/organization-member-name.ts
// 組織の管理画面が「ほかのメンバー」について読む項目 (#2073 S4)。
//
// user_profiles の SELECT の RLS は本人の行だけなので、組織のメンバーの一覧 (GET /api/org/members) と
// オーナーの譲渡の候補 (GET /api/org/owner-transfer/candidates) は、route が呼び出した人を確かめたあとに
// service_role で読む。そのとき返すのは、プライバシーポリシー第9条 5 項 (「組織の管理者に表示されるのは、
// メンバーの表示名、組織内の役割、参加した日、…だけです」) に書いた項目と、行を見分ける id だけにする。
// アイコン・メールアドレス・年齢・健康・そのほかの列は返さない (足すなら第9条の文を先に直す)。
import { z } from 'zod';

/**
 * service_role で読む列。この 4 つ以外を select しない (列を足すと tests/legal-text-1901.test.ts の T-32 が赤になる)。
 * 順は id・表示名 (nickname)・組織内の役割 (org_role)・参加した日 (joined_org_at)
 */
export const ORG_MEMBER_NAME_COLUMNS = 'id, nickname, org_role, joined_org_at';

/**
 * 1 人分。z.object は知らないキーを取り除くので、parse したあとの行はこの 4 つのキーだけを持つ
 * (select の列を誤って足しても、応答には出さない二重の守り)。
 * org_role は所属している行では NULL にならない (CHECK user_profiles_org_consistency)
 */
export const OrgMemberNameSchema = z.object({
  id: z.string(),
  nickname: z.string().nullable(),
  org_role: z.string(),
  joined_org_at: z.string().nullable(),
});

/** GET /api/org/members の 200 の本文 */
export const OrgMemberNamesResponseSchema = z.object({
  members: z.array(OrgMemberNameSchema),
});

/** GET /api/org/owner-transfer/candidates の 200 の本文 */
export const OwnerTransferCandidatesResponseSchema = z.object({
  candidates: z.array(OrgMemberNameSchema),
});

export type OrgMemberName = z.infer<typeof OrgMemberNameSchema>;
export type OrgMemberNamesResponse = z.infer<typeof OrgMemberNamesResponseSchema>;
export type OwnerTransferCandidatesResponse = z.infer<typeof OwnerTransferCandidatesResponseSchema>;
