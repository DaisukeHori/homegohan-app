// src/schemas/membership/self-dissolve.ts
// #1917 利用者の解散 (POST /api/family/dissolve・POST /api/org/dissolve) の本文・応答・RPC の戻り値 (docs/design/family/11-self-dissolve.md §13.1)
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

/** 本文の confirm は true だけを受ける (退会の { confirm: true } と同じ。誤送信で解散しない) */
const ConfirmTrueSchema = z.literal(true);

export const DissolveFamilyBodySchema = z.object({
  family_id: z.string().uuid(),
  confirm: ConfirmTrueSchema,
});

export const DissolveOrgBodySchema = z.object({
  organization_id: z.string().uuid(),
  confirm: ConfirmTrueSchema,
});

/** RPC dissolve_family_by_representative / dissolve_org_by_owner の戻り値 (jsonb)。member_user_ids は通知の宛先で、応答には入れない */
export const SelfDissolveRpcResultSchema = z.object({
  scope_id: z.string().uuid(),
  scope_name: z.string(),
  /** timestamptz を jsonb にした値 (例 2026-10-19T05:00:00.123456+00:00)。offset つき */
  dissolved_at: z.string().datetime({ offset: true }),
  member_user_ids: z.array(z.string().uuid()),
});

export const DissolveFamilyResponseSchema = apiResponse(
  z.object({
    family_id: z.string().uuid(),
    dissolved_at: z.string().datetime({ offset: true }),
  }),
);

export const DissolveOrgResponseSchema = apiResponse(
  z.object({
    organization_id: z.string().uuid(),
    dissolved_at: z.string().datetime({ offset: true }),
  }),
);

export type DissolveFamilyBody = z.infer<typeof DissolveFamilyBodySchema>;
export type DissolveOrgBody = z.infer<typeof DissolveOrgBodySchema>;
export type SelfDissolveRpcResult = z.infer<typeof SelfDissolveRpcResultSchema>;
export type DissolveFamilyResponse = z.infer<typeof DissolveFamilyResponseSchema>;
export type DissolveOrgResponse = z.infer<typeof DissolveOrgResponseSchema>;
