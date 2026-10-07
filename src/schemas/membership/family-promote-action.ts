// src/schemas/membership/family-promote-action.ts
// #1232: 子供メンバー昇格の本人同意フロー (family-invite-action.ts の書式踏襲)
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const RequestChildPromotionBodySchema = z.object({
  email: z.string().email(),
});

// URL の member_id は RPC (uuid 引数) に渡す前に形式を確かめる。
// 不正な値をそのまま渡すと uuid へのキャストで失敗し (22P02)、500 として扱われるため。
export const FamilyMemberIdParamsSchema = z.object({
  member_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'invalid member id'),
});

export const FamilyPromotionTokenParamsSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'invalid token format'),
});

export const AcceptChildPromotionBodySchema = z.object({
  share_meals: z.boolean().default(true),
  share_health: z.boolean().default(false),
  share_menu: z.boolean().default(true),
});

export const RequestChildPromotionResponseSchema = apiResponse(z.object({
  request: z.object({
    id: z.string().uuid(),
    member_id: z.string().uuid(),
    email: z.string().email(),
    status: z.literal('pending'),
    expires_at: z.string(),
  }),
}));

export const AcceptChildPromotionResponseSchema = apiResponse(z.object({
  family_id: z.string().uuid(),
  member_id: z.string().uuid(),
  role: z.literal('adult'),
}));

export const PromotionRequestActionResponseSchema = apiResponse(z.object({
  request_id: z.string().uuid(),
  status: z.enum(['rejected', 'revoked']),
}));

export type RequestChildPromotionBody = z.infer<typeof RequestChildPromotionBodySchema>;
export type AcceptChildPromotionBody = z.infer<typeof AcceptChildPromotionBodySchema>;
