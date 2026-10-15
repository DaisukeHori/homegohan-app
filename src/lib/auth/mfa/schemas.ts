/**
 * 運営ロールの MFA の自己サービス API (/api/auth/mfa/*) の本文と応答の Zod (#1176。docs/design/cross/12-operator-mfa.md §14)
 *
 * route は返す値をこの型で作り、画面の通信の facade (src/lib/auth/mfa/client.ts §15.1) が 2xx の本文をこれで読む。
 * client component からも import されるので、zod (と、段 C で使う @/lib/api/null-character) 以外を import しない
 * (node:crypto を持つ backup-codes.ts も import しない。バックアップコードの個数 BACKUP_CODE_COUNT は応答の Zod では見ず、route の単体テストで見る)。
 * 段 B で MfaUnenrollResponseSchema / MfaBackupCodesResponseSchema、段 C で MfaResetBodySchema / MfaResetResponseSchema などを足す (§22.3)。
 */
import { z } from 'zod';

// ── GET /api/auth/mfa/status (§14.1) ─────────────────────────────────────────

export const MfaStatusResponseSchema = z.object({
  ok: z.literal(true),
  required: z.literal(true),
  enrolled: z.boolean(),
  aal: z.enum(['aal1', 'aal2']),
  factor: z.object({ id: z.string(), friendly_name: z.string().nullable(), created_at: z.string() }).nullable(),
  backup_codes_remaining: z.number().int().nonnegative(),
  enforce_from: z.string().nullable(),
  grace: z.boolean(),
});
export type MfaStatusResponse = z.infer<typeof MfaStatusResponseSchema>;

// ── POST /api/auth/mfa/enroll (§14.2) ────────────────────────────────────────

/** POST /api/auth/mfa/enroll の 200 (段 A) */
export const MfaEnrollResponseSchema = z.object({
  ok: z.literal(true),
  factor_id: z.string().min(1),
  qr_code_svg: z.string().min(1),
  secret: z.string().min(1),
  uri: z.string().min(1),
});
export type MfaEnrollResponse = z.infer<typeof MfaEnrollResponseSchema>;

// ── POST /api/auth/mfa/verify (§14.3) ────────────────────────────────────────

/** 認証アプリの 6 桁 */
export const TOTP_CODE_PATTERN = /^\d{6}$/;

export const MfaVerifyBodySchema = z.object({
  factor_id: z.uuid(),
  code: z.string().regex(TOTP_CODE_PATTERN),
});
export type MfaVerifyBody = z.infer<typeof MfaVerifyBodySchema>;

/**
 * POST /api/auth/mfa/verify の 200 (段 A)。backup_codes は登録 (unverified の factor の verify) で、コードの発行に成功したときだけ・
 * formatBackupCode 済み (XXXXX-XXXXX)。発行に失敗した登録は backup_codes の無い 200 (cross/12 §14.3・§17.2)
 */
export const MfaVerifyResponseSchema = z.object({
  ok: z.literal(true),
  aal: z.literal('aal2'),
  backup_codes: z.array(z.string().min(1)).optional(),
});
export type MfaVerifyResponse = z.infer<typeof MfaVerifyResponseSchema>;

// ── POST /api/auth/mfa/recover (§14.5) ───────────────────────────────────────

/** 入力は区切り・小文字を許す (正規化は normalizeBackupCode)。長さの上限は打ち間違いの余地 (区切り 2 つ分) */
export const BACKUP_CODE_INPUT_MAX_LENGTH = 12;

export const MfaRecoverBodySchema = z.object({
  code: z.string().min(1).max(BACKUP_CODE_INPUT_MAX_LENGTH),
});
export type MfaRecoverBody = z.infer<typeof MfaRecoverBodySchema>;

/** 回復の後に画面が移る先 (回復の route が本人の全セッションを終えているので、ログインからやり直して登録へ) */
export const MFA_RECOVER_NEXT_PATH = '/login?next=%2Fsettings%2Fsecurity%2Fmfa%2Fsetup';

/** POST /api/auth/mfa/recover の 200 (段 A)。route は next に MFA_RECOVER_NEXT_PATH を入れる */
export const MfaRecoverResponseSchema = z.object({
  ok: z.literal(true),
  next: z.string().min(1),
});
export type MfaRecoverResponse = z.infer<typeof MfaRecoverResponseSchema>;

// ── DELETE /api/auth/mfa/factors/{id} (§14.4。段 B) ──────────────────────────

/**
 * DELETE /api/auth/mfa/factors/{id} の 200 (段 B)。aal はこの応答の後の Cookie の access_token の claim:
 * refresh できれば aal1・refresh に失敗したら aal2 のまま (解除は済んでいる。§14.4・§17.2)。画面はどちらでも setup へ進む
 */
export const MfaUnenrollResponseSchema = z.object({
  ok: z.literal(true),
  aal: z.enum(['aal1', 'aal2']),
});
export type MfaUnenrollResponse = z.infer<typeof MfaUnenrollResponseSchema>;

// ── POST /api/auth/mfa/backup-codes (§14.6。段 B) ────────────────────────────

/** POST /api/auth/mfa/backup-codes の 200 (段 B)。backup_codes は formatBackupCode 済み (XXXXX-XXXXX) */
export const MfaBackupCodesResponseSchema = z.object({
  ok: z.literal(true),
  backup_codes: z.array(z.string().min(1)),
});
export type MfaBackupCodesResponse = z.infer<typeof MfaBackupCodesResponseSchema>;
