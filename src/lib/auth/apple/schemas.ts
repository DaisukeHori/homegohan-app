/**
 * Apple の交換・失効の API の応答の形 (docs/design/mobile/08-sign-in-with-apple.md §11.3)。
 */
import { z } from 'zod';
import { APPLE_AUTHORIZATION_CODE_MAX_LENGTH } from '@homegohan/shared';

/** POST /api/auth/apple/authorization の本文 (長さの上限は packages/shared の定数と同じ値) */
export const AppleAuthorizationBodySchema = z.object({
  authorization_code: z.string().min(1).max(APPLE_AUTHORIZATION_CODE_MAX_LENGTH),
});
export type AppleAuthorizationBody = z.infer<typeof AppleAuthorizationBodySchema>;

/** /auth/token の 200 (F-14)。使うのは refresh_token だけ */
export const AppleTokenResponseSchema = z.object({
  refresh_token: z.string().min(1),
  access_token: z.string().optional(),
  id_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});

/** /auth/token・/auth/revoke の 4xx の本文 (F-14 の ErrorResponse) */
export const AppleErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/** route の 200 の本文 */
export const AppleAuthorizationResponseSchema = z.discriminatedUnion('stored', [
  z.object({ stored: z.literal(true) }),
  z.object({ stored: z.literal(false), reason: z.literal('not_configured') }),
]);
export type AppleAuthorizationResponse = z.infer<typeof AppleAuthorizationResponseSchema>;
