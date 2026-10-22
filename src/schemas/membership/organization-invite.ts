// src/schemas/membership/organization-invite.ts
// (設計書 01-data-model.md §2.6)
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const OrgRoleSchema = z.enum(['owner','admin','member']);
export const OrgInviteStatusSchema = z.enum(['pending','accepted','rejected','expired','revoked']);

export const CreateOrgInviteBodySchema = z.object({
  organization_id: z.string().uuid(),
  email: z.string().email().toLowerCase(),
  role: OrgRoleSchema.default('member'),
  custom_message: z.string().max(500).optional(),
});

// ---- API のリクエストボディ (#1163) ----
// POST /api/org/invites と POST /api/org/members が、招待メールを送る前に検証する。
// 上の CreateOrgInviteBodySchema は organization_id を必須にし、role に owner も許すため流用できない
// (組織は呼び出し元のプロフィールから決める。owner を招待で付与してはならない)。
// 未知のキー (古いモバイルアプリが送る password など) は取り除いて無視する。

// 前後の空白を除いて小文字にしてから形式を確かめる (RFC 5321 の上限は 254 文字)
const InviteEmailSchema = z.string().trim().toLowerCase().email().max(254);

// custom_message / nickname は null も「未指定」として受ける (以前の実装は null を黙って無視していたため)
export const CreateOrgInviteRequestBodySchema = z.object({
  email: InviteEmailSchema,
  role: z.enum(['admin', 'member']).default('member'),
  custom_message: z.string().max(500).nullish(),
});

export const AddOrgMemberRequestBodySchema = z.object({
  email: InviteEmailSchema,
  // 招待メールの宛名 (任意)。モバイルは未入力のとき空文字を送る
  nickname: z.string().trim().max(50).nullish(),
});

export const OrgInviteSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  email: z.string().email(),
  token: z.string(),
  invited_role: OrgRoleSchema,
  custom_message: z.string().nullable(),
  status: OrgInviteStatusSchema,
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
  invited_by: z.string().uuid().nullable(),
  accepted_at: z.string().datetime().nullable(),
  accepted_by: z.string().uuid().nullable(),
  rejected_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  revoked_by: z.string().uuid().nullable(),
});

export const CreateOrgInviteResponseSchema = apiResponse(z.object({
  invite: OrgInviteSchema,
  invite_url: z.string().url(),  // クライアントがコピー/メール表示するための URL
}));

// ---- GET /api/org/invites の応答 (組織の管理画面の招待の一覧 src/app/(org)/org/invites/page.tsx が読む) ----
// role は招待で付ける役割 (organization_invites.invited_role。create_org_invite が書く列)。
// 旧い role 列 (既定 'member') は create_org_invite が書かないので使わない (管理者の招待が「メンバー」と出ていた)。
// status は表示用の状態: 期限を過ぎた pending は 'expired' (DB の status が 'expired' になるのは承諾を試みたときだけのため)。
// それ以外は DB の status (取り消し・退会で伏せた招待は 'revoked'、拒否は 'rejected')。
// 表に無い値は画面が「-」で出す (#1912) ので、型は文字列のまま受ける。
export const OrgInviteListItemSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: OrgRoleSchema,
  status: z.string(),
  departmentId: z.string().nullable(),
  departmentName: z.string().nullable(),
  token: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  isExpired: z.boolean(),
  isAccepted: z.boolean(),
});

export const OrgInviteListResponseSchema = z.object({
  invites: z.array(OrgInviteListItemSchema),
});

export type OrgInviteListItem = z.infer<typeof OrgInviteListItemSchema>;
export type OrgInviteListResponse = z.infer<typeof OrgInviteListResponseSchema>;

export type OrgRole = z.infer<typeof OrgRoleSchema>;
export type OrgInviteStatus = z.infer<typeof OrgInviteStatusSchema>;
export type CreateOrgInviteBody = z.infer<typeof CreateOrgInviteBodySchema>;
export type CreateOrgInviteRequestBody = z.infer<typeof CreateOrgInviteRequestBodySchema>;
export type AddOrgMemberRequestBody = z.infer<typeof AddOrgMemberRequestBodySchema>;
export type OrgInvite = z.infer<typeof OrgInviteSchema>;
export type CreateOrgInviteResponse = z.infer<typeof CreateOrgInviteResponseSchema>;
