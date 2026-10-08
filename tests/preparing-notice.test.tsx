/**
 * #1126 #1128 #1180 #1125: 「準備中」「未接続」の案内ボックス (src/components/operator/PreparingNotice.tsx ほか)
 *
 * 運営画面の、まだ動いていない機能の案内に使う共通部品。ここでは、部品そのものの約束を確かめる。
 *   - 見出し (title) と補足 (children) を出す。補足が無ければ補足の枠を作らない
 *   - 暗い画面用 (dark) は、背景を塗りつぶした (不透明な) 色にする。
 *     super-admin の layout の背景は明るい (bg-slate-50) ので、背景が透ける色 (bg-amber-900/20 など) にすると、
 *     明るい琥珀色の文字が背景に溶けて読めなくなる (色から計算したコントラスト比は、透ける背景で約 1.2、
 *     不透明な bg-slate-800 で約 10。読みやすさの目安は 4.5 以上)
 *   - インフラ監視の案内は、Vercel / Supabase のダッシュボードへのリンクを別タブで開く
 * 画面ごとの出し分けは tests/admin-preparing-pages.test.tsx と tests/super-admin-preparing-pages.test.tsx。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PreparingNotice } from '@/components/operator/PreparingNotice';
import {
  BillingNotStartedNotice,
  BILLING_NOT_STARTED_MESSAGE,
} from '@/components/operator/finance/BillingNotStartedNotice';
import {
  MonitoringNotConnectedNotice,
  MONITORING_DASHBOARD_LINKS,
  MONITORING_NOT_CONNECTED_MESSAGE,
} from '@/components/operator/infra/MonitoringNotConnectedNotice';

function render(element: React.ReactElement) {
  const holder = document.createElement('div');
  holder.innerHTML = renderToStaticMarkup(element);
  return holder;
}

describe('PreparingNotice', () => {
  it('見出しと補足を出す。status の役割を持つ', () => {
    const notice = render(
      <PreparingNotice title="準備中（未対応）">
        <p>補足の文</p>
      </PreparingNotice>,
    );

    const box = notice.querySelector('[role="status"]');
    expect(box).not.toBeNull();
    expect(box?.querySelector('p')?.textContent).toBe('準備中（未対応）');
    expect(box?.textContent).toContain('補足の文');
  });

  it('補足が無いときは、補足の枠を作らない', () => {
    const notice = render(<PreparingNotice title="準備中（未対応）" />);

    expect(notice.querySelectorAll('p')).toHaveLength(1);
    expect(notice.querySelector('[role="status"] > div')).toBeNull();
  });

  it('dark は、背景を塗りつぶした (不透明な) 色にする。透ける背景 (bg-xxx/20 など) にしない', () => {
    const box = render(<PreparingNotice title="準備中（未対応）" tone="dark" />).querySelector('[role="status"]');

    const classes = (box?.className ?? '').split(/\s+/);
    const backgrounds = classes.filter((c) => c.startsWith('bg-'));
    expect(backgrounds.length).toBeGreaterThan(0);
    for (const background of backgrounds) {
      // bg-amber-900/20 のように「/数字」が付くものは背景が透ける
      expect(background, background).not.toMatch(/\/\d+$/);
    }
  });

  it('tone を省くと dark。light は明るい琥珀色の背景', () => {
    const byDefault = render(<PreparingNotice title="x" />).querySelector('[role="status"]');
    const dark = render(<PreparingNotice title="x" tone="dark" />).querySelector('[role="status"]');
    const light = render(<PreparingNotice title="x" tone="light" />).querySelector('[role="status"]');

    expect(byDefault?.className).toBe(dark?.className);
    expect(light?.className).toContain('bg-amber-50');
    expect(light?.className).not.toBe(dark?.className);
  });

  it('className を足せる', () => {
    const box = render(<PreparingNotice title="x" className="mb-6" />).querySelector('[role="status"]');

    expect(box?.className).toContain('mb-6');
  });
});

describe('BillingNotStartedNotice', () => {
  it('「課金は未開始のため準備中」を見出しにして、補足を出す', () => {
    const notice = render(
      <BillingNotStartedNotice>
        <p>補足の文</p>
      </BillingNotStartedNotice>,
    );

    expect(BILLING_NOT_STARTED_MESSAGE).toBe('課金は未開始のため準備中');
    expect(notice.querySelector('[role="status"] p')?.textContent).toBe('課金は未開始のため準備中');
    expect(notice.textContent).toContain('補足の文');
  });
});

describe('MonitoringNotConnectedNotice', () => {
  it('「未接続: 監視データの収集は設定されていません」を見出しにする。空が「問題なし」ではないことを書く', () => {
    const notice = render(<MonitoringNotConnectedNotice />);

    expect(MONITORING_NOT_CONNECTED_MESSAGE).toBe('未接続: 監視データの収集は設定されていません');
    expect(notice.querySelector('[role="status"] p')?.textContent).toBe(MONITORING_NOT_CONNECTED_MESSAGE);
    expect(notice.textContent).toContain('空であることは「問題が無い」という意味ではありません');
  });

  it('Vercel と Supabase のダッシュボードへのリンクを、別タブで開く (opener を渡さない)', () => {
    const notice = render(<MonitoringNotConnectedNotice />);

    expect(MONITORING_DASHBOARD_LINKS.map((link) => link.href)).toEqual([
      'https://vercel.com/dashboard',
      'https://supabase.com/dashboard',
    ]);
    const links = Array.from(notice.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(MONITORING_DASHBOARD_LINKS.map((link) => link.href));
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    }
  });
});
