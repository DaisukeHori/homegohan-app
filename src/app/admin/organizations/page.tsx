/**
 * /admin/organizations — 組織管理 (一覧・検索 + 新規作成)
 * operator/03-ui-spec.md §7 準拠
 *
 * admin / super_admin だけが開ける。admin/layout.tsx は content_moderator も通すため、ここで改めて確認する
 * (確認しないと、content_moderator が開いたとき API が 403 を返し、壊れた画面になる)。
 * 画面の本体は、ブラウザ側で動く OrganizationsManager。
 */

export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import OrganizationsManager from './OrganizationsManager';

export default async function AdminOrganizationsPage() {
  try {
    await requireRole(['admin', 'super_admin']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  return <OrganizationsManager />;
}
