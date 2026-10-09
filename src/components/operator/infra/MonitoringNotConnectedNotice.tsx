/**
 * インフラ監視 (アラート・メトリクス) の「未接続」の案内 (#1180)
 *
 * infra_alerts / infra_metrics には、書き込む処理 (収集用の cron / Webhook) がリポジトリに無く、
 * 本番では常に空になる。空の一覧に「未解決のアラートはありません」と出すと、監視が動いていて問題が無いように
 * 見えてしまうため、「未接続」と明示し、実際の状態を見られる各サービスのダッシュボードへの導線を出す。
 *
 * 注意: これは「収集処理がまだ無い」ことを前提にした案内で、データの有無では出し分けていない。
 * 収集処理 (cron / Webhook) を作るときは、この案内を外すか、収集が動いているかを見て出し分けること
 * (出し分けないと、収集が動いて本当に「問題なし」のときも「未接続」と出てしまう)。
 */
import { PreparingNotice } from '@/components/operator/PreparingNotice';

/** 画面に出す主なメッセージ */
export const MONITORING_NOT_CONNECTED_MESSAGE = '未接続: 監視データの収集は設定されていません';

/** 実際の状態を見られる各サービスのダッシュボード */
export const MONITORING_DASHBOARD_LINKS = [
  { label: 'Vercel ダッシュボード', href: 'https://vercel.com/dashboard' },
  { label: 'Supabase ダッシュボード', href: 'https://supabase.com/dashboard' },
] as const;

export function MonitoringNotConnectedNotice() {
  return (
    <PreparingNotice title={MONITORING_NOT_CONNECTED_MESSAGE} tone="dark">
      <p>アラートやメトリクスを集める処理がまだ無いため、この画面は空です。空であることは「問題が無い」という意味ではありません。</p>
      <p>実際の状態は、各サービスのダッシュボードで確認してください。</p>
      <ul className="flex flex-wrap gap-4 pt-1">
        {MONITORING_DASHBOARD_LINKS.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-amber-300 underline hover:text-amber-200"
            >
              {link.label} ↗
            </a>
          </li>
        ))}
      </ul>
    </PreparingNotice>
  );
}
