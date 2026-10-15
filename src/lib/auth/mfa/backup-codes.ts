/**
 * 運営ロールの MFA のバックアップコード (#1176。docs/design/cross/12-operator-mfa.md §12.3)
 *
 * コードの値は画面に 1 回だけ出し、表 (public.operator_mfa_backup_codes) には SHA-256 だけを持つ。
 * 表の読み書きは service_role の client (getSupabaseAdmin() で作り、route から受け取る。自前で createClient しない)。
 * 4 関数とも、PostgREST の error を受けたら固定の文の Error を投げる (PostgREST の文を message に入れず、cause に持つ §23 N-5)。
 * route の扱いは cross/12 §17.2 (監査の起点より前なら internalError の 500、起点の後なら手順を止めて failed_step を持ち、監査を書いてから応答)。
 * 0 行は失敗ではない (consumeBackupCode は false・countRemainingBackupCodes は 0・deleteBackupCodes は 0 を返す §13.6)。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/** 発行する個数 (cross/01 §5.2 / 要件 §17.2 の 10 個) */
export const BACKUP_CODE_COUNT = 10;
/** 1 個の長さ (文字)。32 文字の字母で 10 文字 = 50 bit。レート制限 (§14.5) と合わせて総当たりを現実的でなくする */
export const BACKUP_CODE_LENGTH = 10;
/** 字母。読み間違えやすい I / O / 0 / 1 を除いた 32 文字 (2^5 なので乱数 1 byte の下位 5 bit で偏りなく選べる) */
export const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 表示のとき真ん中で区切る (5-5) */
const BACKUP_CODE_DISPLAY_GROUP = 5;
const ALPHABET_MASK = 0b11111;

/** 乱数で 1 個作る (正規化済みの 10 文字) */
export function generateBackupCode(): string {
  const bytes = randomBytes(BACKUP_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < BACKUP_CODE_LENGTH; i += 1) {
    code += BACKUP_CODE_ALPHABET[bytes[i] & ALPHABET_MASK];
  }
  return code;
}

/** 10 個作る (重複は作り直す) */
export function generateBackupCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) codes.add(generateBackupCode());
  return [...codes];
}

/** 利用者の入力を正規化する: 大文字にし、英数字以外 (区切りの - や空白) を除く */
export function normalizeBackupCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 正規化済みのコードが形として正しいか (長さと字母) */
export function isWellFormedBackupCode(normalized: string): boolean {
  if (normalized.length !== BACKUP_CODE_LENGTH) return false;
  for (const ch of normalized) if (!BACKUP_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** 保存するハッシュ。前像に user_id を入れ、利用者をまたいだ突き合わせをできなくする */
export function hashBackupCode(userId: string, normalized: string): string {
  return createHash('sha256').update(`${userId}:${normalized}`).digest('hex');
}

/** 画面に出す形 (XXXXX-XXXXX) */
export function formatBackupCode(normalized: string): string {
  return `${normalized.slice(0, BACKUP_CODE_DISPLAY_GROUP)}-${normalized.slice(BACKUP_CODE_DISPLAY_GROUP)}`;
}

// ── 表の読み書き (service_role の client) ────────────────────────────────────

const BACKUP_CODES_TABLE = 'operator_mfa_backup_codes';

/** 4 関数が投げる Error の固定の文 (PostgREST の文は cause にだけ持つ) */
const BACKUP_CODE_STORE_ERROR_MESSAGE = 'operator_mfa_backup_codes の読み書きに失敗しました';

/** 表の読み書きに使う client (getSupabaseAdmin() の戻り値をそのまま渡す) */
export interface BackupCodeStoreClient {
  from: SupabaseClient<Database>['from'];
}

function storeError(cause: unknown): Error {
  return new Error(BACKUP_CODE_STORE_ERROR_MESSAGE, { cause });
}

/** その利用者の行を使用済みも含めて全部消す (回復・解除・reset・再発行の前)。消した行数を返す */
export async function deleteBackupCodes(admin: BackupCodeStoreClient, userId: string): Promise<number> {
  const { data, error } = await admin.from(BACKUP_CODES_TABLE).delete().eq('user_id', userId).select('id');
  if (error) throw storeError(error);
  return data?.length ?? 0;
}

/** 旧行を全部消して 10 個を発行し、画面に 1 回だけ出す正規化済みのコードを返す */
export async function issueBackupCodes(admin: BackupCodeStoreClient, userId: string): Promise<string[]> {
  const { error: deleteError } = await admin.from(BACKUP_CODES_TABLE).delete().eq('user_id', userId);
  if (deleteError) throw storeError(deleteError);

  const codes = generateBackupCodes();
  const batchId = randomUUID();
  const { error: insertError } = await admin.from(BACKUP_CODES_TABLE).insert(
    codes.map((code) => ({ user_id: userId, batch_id: batchId, code_hash: hashBackupCode(userId, code) })),
  );
  if (insertError) throw storeError(insertError);
  return codes;
}

/**
 * 1 個を消費する (UPDATE ... SET used_at = now() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL RETURNING id)。
 * 消費できたら true。0 行 (無い・使用済み・同時に使われた) なら false
 */
export async function consumeBackupCode(
  admin: BackupCodeStoreClient,
  userId: string,
  normalized: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from(BACKUP_CODES_TABLE)
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('code_hash', hashBackupCode(userId, normalized))
    .is('used_at', null)
    .select('id');
  if (error) throw storeError(error);
  return (data?.length ?? 0) > 0;
}

/** 未使用 (used_at IS NULL) の残数。status の backup_codes_remaining と、reset の監査の backup_codes_before (§14.7・§17) */
export async function countRemainingBackupCodes(admin: BackupCodeStoreClient, userId: string): Promise<number> {
  const { count, error } = await admin
    .from(BACKUP_CODES_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('used_at', null);
  if (error) throw storeError(error);
  return count ?? 0;
}
