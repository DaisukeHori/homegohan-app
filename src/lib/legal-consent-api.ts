/**
 * 同意ゲート (#1442) の API の本文の Zod スキーマ (正本)。
 * 値の定義は packages/shared/src/legal-consent-api.ts (サーバー・Web・モバイル共用) にあり、ここはその形を Zod で固定するだけ。
 * GET /api/legal/status の route が応答を作ったあとに parse し (status の応答は gaps (#1173) を含む)、テスト (tests/legal-consent-api-schema.test.ts・middleware の表) が
 * middleware の 403 の本文と status の応答をこれで確かめる。zod を packages/shared に持ち込まない (モバイルのバンドルに入れない) ので、ここに置く。
 */
import { z } from 'zod';
import {
  LEGAL_CONSENT_GAP_VALUES,
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  LEGAL_DOCUMENT_TYPES,
  LEGAL_VERSION_PATTERN,
} from '@homegohan/shared';

/** 施行日 (YYYY-MM-DD)。legal-versions.ts の effectiveDate の形式 */
const EFFECTIVE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 403 LEGAL_CONSENT_REQUIRED の本文。キーは error と code の 2 つだけ (strict) */
export const LegalConsentRequiredBodySchema = z
  .object({
    error: z.literal(LEGAL_CONSENT_REQUIRED_MESSAGE),
    code: z.literal(LEGAL_CONSENT_REQUIRED_CODE),
  })
  .strict();

export type LegalConsentRequiredBodyShape = z.infer<typeof LegalConsentRequiredBodySchema>;

const LegalConsentCurrentDocumentSchema = z
  .object({
    version: z.string().regex(LEGAL_VERSION_PATTERN),
    effective_date: z.string().regex(EFFECTIVE_DATE_PATTERN),
  })
  .strict();

/** GET /api/legal/status の応答 */
export const LegalConsentStatusSchema = z
  .object({
    enforced: z.boolean(),
    accepted: z.boolean(),
    required: z.boolean(),
    outdated: z.array(z.enum(LEGAL_DOCUMENT_TYPES)),
    gaps: z.array(z.enum(LEGAL_CONSENT_GAP_VALUES)),
    current: z
      .object({
        terms_of_service: LegalConsentCurrentDocumentSchema,
        privacy_policy: LegalConsentCurrentDocumentSchema,
      })
      .strict(),
    accepted_versions: z
      .object({
        terms_version: z.string().nullable(),
        privacy_version: z.string().nullable(),
      })
      .strict(),
  })
  .strict()
  // required は enforced と accepted から決まる値。食い違う応答を正本として通さない
  .refine((value) => value.required === (value.enforced && !value.accepted), {
    message: 'required は enforced && !accepted と一致すること',
  })
  // accepted は gaps が空であることと同じ (#1173)。食い違う応答を正本として通さない
  .refine((value) => value.accepted === (value.gaps.length === 0), {
    message: 'accepted は gaps が空であることと一致すること',
  });

export type LegalConsentStatusShape = z.infer<typeof LegalConsentStatusSchema>;
