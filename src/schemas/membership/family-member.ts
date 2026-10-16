// src/schemas/membership/family-member.ts
import { z } from 'zod';
import { BIRTH_DATE_PATTERN, PARENTAL_CONSENT_VERSION_PATTERN, SIGNED_NAME_MAX_LENGTH } from '@homegohan/shared';
import { apiResponse } from '@/schemas/common';
import { FamilyRoleSchema } from './family-group';

export const FamilyMemberStatusSchema = z.enum(['active', 'removed', 'left']);

export const FamilyMemberSchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  user_id: z.string().uuid().nullable(),
  role: FamilyRoleSchema,
  display_name: z.string().nullable(),
  relationship: z.string().nullable(),
  tags: z.array(z.string()),
  share_meals: z.boolean(),
  share_health: z.boolean(),
  share_menu: z.boolean(),
  child_profile: z.record(z.string(), z.unknown()).nullable(),
  avatar_color: z.string(),
  status: FamilyMemberStatusSchema,
  joined_at: z.string().datetime(),
  removed_at: z.string().datetime().nullable(),
});

/** 保護者の同意 (子供が 18 歳未満のとき必須。18 歳以上のときは無視する) (#1173) */
export const ParentalConsentInputSchema = z
  .object({
    version: z.string().regex(PARENTAL_CONSENT_VERSION_PATTERN),
    signed_name: z.string().trim().min(1).max(SIGNED_NAME_MAX_LENGTH),
    guardian_attested: z.literal(true),
  })
  .strict();

/** 子供の呼び名の上限。現行の AddFamilyChildBodySchema の .max(60) と同じ値 (変えない)。名前を付けて置き換える */
export const CHILD_DISPLAY_NAME_MAX_LENGTH = 60;

export const AddFamilyChildBodySchema = z
  .object({
    family_id: z.string().uuid(),
    display_name: z.string().min(1).max(CHILD_DISPLAY_NAME_MAX_LENGTH),
    child_profile: z.record(z.string(), z.unknown()).default({}),
    birth_date: z.string().regex(BIRTH_DATE_PATTERN), // 暦として正しいか・未来・120 年超は route が validateBirthDate で見る
    consent: ParentalConsentInputSchema.optional(),
  })
  .strict();
export type ParentalConsentInput = z.infer<typeof ParentalConsentInputSchema>;

/** POST /api/family/members/child の 201 の data */
export const AddFamilyChildResponseDataSchema = z.object({
  member: z
    .object({
      id: z.string().uuid(),
      family_id: z.string().uuid(),
      role: z.literal('child'),
      display_name: z.string().nullable(),
      birth_date: z.string(),
    })
    .passthrough(),
  consent_recorded: z.boolean(),
});

export const PromoteChildBodySchema = z.object({
  member_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

export const RemoveFamilyMemberBodySchema = z.object({
  family_id: z.string().uuid(),
  member_id: z.string().uuid(),
});

export const LeaveFamilyResponseSchema = apiResponse(z.object({
  family_id: z.string().uuid(),
  member_id: z.string().uuid(),
  left_at: z.string().datetime(),
}));

/**
 * GET /api/family/members/names の 1 行 (#1584)。家族の画面に出すメンバーの名前だけを返す (ほかの列は返さない)。
 * name = family_members.display_name、それが無ければ本人のプロフィールの今の名前 (user_profiles.nickname)、両方無ければ null。
 */
export const FamilyMemberNameSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
  })
  .strict();

/** GET /api/family/members/names の応答の data */
export const FamilyMemberNamesDataSchema = z.object({
  members: z.array(FamilyMemberNameSchema),
});

export type FamilyMemberStatus = z.infer<typeof FamilyMemberStatusSchema>;
export type FamilyMember = z.infer<typeof FamilyMemberSchema>;
export type AddFamilyChildBody = z.infer<typeof AddFamilyChildBodySchema>;
export type PromoteChildBody = z.infer<typeof PromoteChildBodySchema>;
export type RemoveFamilyMemberBody = z.infer<typeof RemoveFamilyMemberBodySchema>;
export type LeaveFamilyResponse = z.infer<typeof LeaveFamilyResponseSchema>;
export type FamilyMemberName = z.infer<typeof FamilyMemberNameSchema>;
export type FamilyMemberNamesData = z.infer<typeof FamilyMemberNamesDataSchema>;
