/**
 * 結合テストで組織 (organizations) を作るときの「持ち主」を用意する。
 *
 * organizations.owner_id は NOT NULL (#1103 項目 10 / migration 20261017040000_organizations_owner_id_not_null.sql)。
 * 外部キーは auth.users(id) ON DELETE RESTRICT なので、持ち主のユーザーは組織より先には消せない。
 *
 * ここで作る持ち主は auth.users の行だけ (user_profiles は作らない) で、どの組織のメンバーにもならない。
 * テストが数えるメンバー・役割 (user_profiles の organization_id / org_role) には影響しない。
 * 後片付けは、組織を消した後に deletePlaceholderOrgOwner で消す (順序を間違えると RESTRICT で失敗し、例外になる)。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/** パスワードの乱数部分のバイト数 (base64url で 24 文字) */
const PASSWORD_RANDOM_BYTES = 18;
/** パスワードの規則 (英大文字・小文字・数字・記号) を満たすための固定の末尾 */
const PASSWORD_SUFFIX = 'Aa1!';

/** 組織の持ち主にするだけのユーザーを作り、その id を返す (サインインはしない) */
export async function createPlaceholderOrgOwner(admin: SupabaseClient, label: string): Promise<string> {
  const email = `org-owner-${label}-${randomUUID()}@homegohan.test`;
  const password = `${randomBytes(PASSWORD_RANDOM_BYTES).toString('base64url')}${PASSWORD_SUFFIX}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createPlaceholderOrgOwner(${label}): ${error?.message ?? 'user が返らない'}`);
  return data.user.id;
}

/** createPlaceholderOrgOwner で作ったユーザーを消す。持ち主の組織が残っていれば RESTRICT で失敗し、例外になる */
export async function deletePlaceholderOrgOwner(admin: SupabaseClient, userId: string): Promise<void> {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(`deletePlaceholderOrgOwner(${userId}): ${error.message}`);
}
