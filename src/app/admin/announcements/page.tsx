/**
 * /admin/announcements — お知らせ管理 (一覧 + 新規作成)
 * operator/03-ui-spec.md §21 準拠
 *
 * admin / super_admin だけが開ける。admin/layout.tsx は content_moderator も通すため、ここで改めて確認する
 * (確認しないと、content_moderator が開いたとき API が 403 を返し、壊れた画面になる)。
 * 画面の本体は、ブラウザ側で動く AnnouncementsManager。
 */

export const dynamic = 'force-dynamic';

import { requireRoleForPage } from '@/lib/auth/page-guard';
import AnnouncementsManager from './AnnouncementsManager';

export default async function AdminAnnouncementsPage() {
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  await requireRoleForPage(['admin', 'super_admin'], { next: '/admin/announcements' });

  return <AnnouncementsManager />;
}
