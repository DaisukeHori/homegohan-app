import { redirect } from 'next/navigation';

/**
 * /super-admin の入口。/admin のサイドバーの『運営最上位の画面』リンク (SUPER_ADMIN_SCREEN_LABEL。src/app/admin/layout.tsx) と、
 * メイン画面のロール切り替え (src/app/(main)/MainLayout.tsx) の行き先で、プラン管理 (/super-admin/plans) へ送る。
 * super_admin の画面は /super-admin/plans などの下にある (layout.tsx のログイン後の戻り先も /super-admin/plans)。
 *
 * super_admin 以外の人は、同じ階層の layout.tsx が requireRoleForPage(['super_admin'], ...) で弾く。
 * 権限の判定はそちらに任せ、ここでは重ねない。
 */
export default function SuperAdminIndexPage() {
  redirect('/super-admin/plans');
}
