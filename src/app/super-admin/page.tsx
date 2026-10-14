import { redirect } from 'next/navigation';

/**
 * /super-admin の入口
 *
 * これまで /super-admin には page.tsx が無く、管理画面の「super_admin コンソール」リンク
 * (src/app/admin/layout.tsx) と、メイン画面のロール切り替え (src/app/(main)/MainLayout.tsx) が 404 になっていた。
 * super_admin の画面は /super-admin/plans などの下にあるので、入口に来た人はプラン管理へ送る
 * (layout.tsx のログイン後の戻り先も /super-admin/plans)。
 *
 * super_admin 以外の人は、同じ階層の layout.tsx が requireRole(['super_admin']) で弾く。
 * 権限の判定はそちらに任せ、ここでは重ねない。
 */
export default function SuperAdminIndexPage() {
  redirect('/super-admin/plans');
}
