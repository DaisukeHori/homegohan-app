/**
 * /admin/organizations — 組織管理 (一覧・検索 + 新規作成)
 * operator/03-ui-spec.md §7 準拠
 *
 * admin / super_admin だけが開ける。admin/layout.tsx は content_moderator も通すため、ここで改めて確認する
 * (確認しないと、content_moderator が開いたとき API が 403 を返し、壊れた画面になる)。
 * 画面の本体は、ブラウザ側で動く OrganizationsManager。
 */

export const dynamic = 'force-dynamic';

import { requireRoleForPage } from '@/lib/auth/page-guard';
import OrganizationsManager from './OrganizationsManager';

export default async function AdminOrganizationsPage() {
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  const actor = await requireRoleForPage(['admin', 'super_admin'], { next: '/admin/organizations' });

  // オーナーを指定しない組織の作成では、操作している運営がオーナーになる (route と同じ)。応答を受け取れなかったあとの確かめで、
  // 読み直した組織が自分の送った作成かを比べるのに使う (#2112 Z2)
  return <OrganizationsManager currentUserId={actor.id} />;
}
