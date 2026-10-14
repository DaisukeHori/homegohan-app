import { redirect } from "next/navigation";

/**
 * /org の入口 (#1143)
 *
 * ここにはもともと、部署一覧を見せるだけで「編集機能は準備中」と表示する旧スタブ画面
 * ((main)/org/page.tsx) があった。部署の追加・編集・削除を含む組織の管理画面は、このルートグループの
 * /org/dashboard・/org/departments などにすでにあるため、/org に来た人はダッシュボードへ送る。
 *
 * 組織の管理者 (org_role が owner / admin) 以外の人は、送り先の (org)/layout.tsx が org_role を確認して
 * /home に戻す。権限の判定はそちらに任せ、ここでは重ねない。
 *
 * 注意: ルートグループが違っても、同じ URL の page.tsx を 2 つ置くと Next.js のビルドが失敗する。
 * /org の page.tsx はこのファイルだけにすること。
 */
export default function OrgIndexPage() {
  redirect("/org/dashboard");
}
