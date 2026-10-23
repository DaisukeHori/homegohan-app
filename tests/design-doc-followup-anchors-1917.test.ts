// @vitest-environment node
/**
 * 追随表などが行番号で指す先 (要件 02・org/04・org/05・operator/02) が、指している文を指し続けることの contract テスト (ソース走査)
 *
 * #1917 の続き (docs-1023a) で、要件 02・org/04・org/05 に注記を足したとき、注記が行を増やしたせいで
 * billing/01 §16.2 の追随表の生きた行 (期日が「配線の残りの冊」「migrate-to-personal を実装するとき」
 * 「組織の課金の冊」の行) や org/10・family/11 が行番号で指す先が、別の行 (空行・違う手順) にずれた。
 * 注記は行を増やさない形 (既存の行の末尾・表のセル) で書き、追随表の行番号は書き換えない。
 *
 * ここでは、追随表の行から行番号を取り出し (表の行の書き方が変わったら取り出しが失敗して赤になる)、
 * 指す先の行が、追随表が書いている中身 (逐語の一部) を持つことを確かめる。注記で行がずれると赤になる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

const BILLING01 = 'docs/design/billing/01-billing-core.md';
const REQ02 = 'docs/requirements/02-organization-management.md';
const ORG04 = 'docs/design/org/04-license-management.md';
const ORG05 = 'docs/design/org/05-offboarding-flow.md';
const ORG10 = 'docs/design/org/10-challenge-diff-privacy.md';
const OPERATOR02 = 'docs/design/operator/02-api-spec.md';
const FAMILY11 = 'docs/design/family/11-self-dissolve.md';

/** 文書の n 行目 (1 始まり) */
function lineAt(relativePath: string, lineNumber: number): string {
  const lines = read(relativePath).split('\n');
  expect(lineNumber, `${relativePath} に ${lineNumber} 行目がある`).toBeLessThanOrEqual(lines.length);
  return lines[lineNumber - 1] ?? '';
}

/** `:N` と `:N-M` を、行番号の並び (範囲は始めと終わりの 2 つ) にする */
function anchorNumbers(text: string): number[] {
  return [...text.matchAll(/:(\d+)(?:-(\d+))?/g)].flatMap(([, start, end]) =>
    end === undefined ? [Number(start)] : [Number(start), Number(end)],
  );
}

/** billing/01 の、先頭が prefix の表の行 (ちょうど 1 行) と、その次の行 */
function billing01Row(prefix: string): { row: string; next: string } {
  const lines = read(BILLING01).split('\n');
  const hits = lines.flatMap((line, index) => (line.startsWith(prefix) ? [index] : []));
  expect(hits, `${BILLING01} に「${prefix}」で始まる行がちょうど 1 行ある`).toHaveLength(1);
  return { row: lines[hits[0]], next: lines[hits[0] + 1] ?? '' };
}

/** 表の行の n 番目のセル (1 始まり。先頭の | の前は数えない) */
function cell(row: string, index: number): string {
  return row.split('|')[index]?.trim() ?? '';
}

/** 行番号ごとに、指す先の行が持つべき語を確かめる (行番号の集合も一致させる) */
function expectAnchors(relativePath: string, cited: number[], expected: Record<number, string | RegExp>): void {
  expect([...new Set(cited)].sort((a, b) => a - b)).toEqual(
    Object.keys(expected)
      .map(Number)
      .sort((a, b) => a - b),
  );
  for (const [lineNumber, needle] of Object.entries(expected)) {
    const text = lineAt(relativePath, Number(lineNumber));
    if (typeof needle === 'string') {
      expect(text, `${relativePath}:${lineNumber}`).toContain(needle);
    } else {
      expect(text, `${relativePath}:${lineNumber}`).toMatch(needle);
    }
  }
}

describe('billing/01 §16.2 の追随表が要件 02 を指す行番号 (#1917 docs-1023a の R2 指摘 1・3)', () => {
  it('要件 02 の行 (一時停止中の個人プラン) の :763-764・:1809 が paused_until・resume・pause/resume の行を指す', () => {
    const { row } = billing01Row('| `docs/requirements/02-organization-management.md` |');
    expectAnchors(REQ02, anchorNumbers(cell(row, 2)), {
      763: 'personal_subscriptions.paused_until',
      764: 'Stripe Subscription を resume',
      1809: 'Stripe Subscription pause/resume',
    });
  });

  it('次の「同 | ほか」の行の行番号がどれも Stripe の行を指し、:400 は個人プランへの移行の行', () => {
    const { next } = billing01Row('| `docs/requirements/02-organization-management.md` |');
    expect(cell(next, 1), '要件 02 の行の次は「同」の行').toBe('同');
    const stripe = /stripe/i;
    expectAnchors(REQ02, anchorNumbers(cell(next, 2)), {
      83: stripe,
      316: '6. Stripe で決済',
      400: '個人プラン (Family Basic / Pro) へ移行',
      603: '自動配布は将来対応 (Stripe Coupon',
      660: '#### 5.9.2 Stripe 連携',
      1042: 'stripe_subscription_id',
      1095: 'stripe_subscription_id',
      1531: '→ Stripe 決済',
      1727: 'ステップ 5: 金額確認 + Stripe 決済',
      1794: '- Stripe 連携',
      1842: 'Stripe 本番接続テスト',
    });
    expectAnchors(REQ02, anchorNumbers(cell(next, 3)), { 400: '個人プラン (Family Basic / Pro) へ移行' });
  });
});

describe('billing/01 §16.2 の追随表が org/04・org/05 を指す行番号 (#1917 docs-1023a の R2 指摘 2・3)', () => {
  it('org/04 の行の :517 が組織ライセンス受領時の一時停止 (paused_until) の行を指す', () => {
    const { row, next } = billing01Row('| `docs/design/org/04-license-management.md` | :517');
    expectAnchors(ORG04, anchorNumbers(cell(row, 2)), { 517: '組織から Org Pro ライセンスを受領した場合' });
    expect(cell(next, 1), 'org/04 の行の次は「同」の行').toBe('同');
    expectAnchors(ORG04, anchorNumbers(cell(next, 2)), {
      461: '// 2. 個人プラン',
      467: '.single();',
      500: 'personalSub?.current_period_end',
      522: 'Upstash Redis にキャッシュ',
    });
  });

  it('migrate-to-personal の行の org/05 (:55-58・:232-239・:248-249・:430-433) と org/04 :293 が指す先', () => {
    const { row } = billing01Row('| `docs/design/family/02-api-spec.md` §4.7');
    const org05Part = /`docs\/design\/org\/05-offboarding-flow\.md` \(([^`]*)\)・`docs\/design\/org\/04/.exec(row);
    expect(org05Part, 'org/05 の行番号の括弧がある').not.toBeNull();
    expectAnchors(ORG05, anchorNumbers(org05Part?.[1] ?? ''), {
      55: 'migrate-to-personal',
      58: 'API->>Stripe: 個人プラン Checkout',
      232: '個人プラン Stripe Checkout 起動',
      239: 'checkout_url: checkoutUrl',
      248: '譲渡先が個人プランで課金済み',
      249: 'Stripe Checkout 後に譲渡完了',
      430: 'const body = JSON.stringify({',
      433: '});',
    });
    const org04Part = /`docs\/design\/org\/04-license-management\.md` (:\d+) \(「個人プランへ移行」の行\)/.exec(row);
    expect(org04Part, 'org/04 :NNN (「個人プランへ移行」の行) がある').not.toBeNull();
    expectAnchors(ORG04, anchorNumbers(org04Part?.[1] ?? ''), { 293: '| **個人プランへ移行** |' });
  });

  it('組織の課金の行の org/04 :233・:531 が Standard → Pro の切り替えと pool_purchased の行を指す', () => {
    const { row } = billing01Row('| 組織の課金の文書:');
    const org04Part = /`org\/04-license-management\.md` (:\d+) \(Standard → Pro の切り替え\)・(:\d+) \(`pool_purchased`\)/.exec(row);
    expect(org04Part, 'org/04 の :NNN (Standard → Pro の切り替え)・:NNN (`pool_purchased`) がある').not.toBeNull();
    expectAnchors(ORG04, anchorNumbers(`${org04Part?.[1] ?? ''} ${org04Part?.[2] ?? ''}`), {
      233: '4. Stripe で Standard サブスク解約 + Pro サブスク開始',
      531: '| `pool_purchased` |',
    });
  });
});

describe('billing/01 §16.2 の追随表が operator/02 を指す行番号 (#1917 docs-1023b)', () => {
  // 追随表の operator/02 の 2 行の行番号が古い位置のままだった。:1739-1746 は #1967 (f9ad46fc) が operator/02 に 11 行を足す前の番号、
  // :570-573・:1411-1433・:1534-1535・:1545-1627・:1632 はそれより前から operator/02 に足された行の分だけずれていた番号
  it('operator/02 の行の §9 の注・§21・§24・§25 の行番号が、Stripe の Webhook の注・節・テスト・見本・関連の行を指す', () => {
    const { row } = billing01Row('| `docs/design/operator/02-api-spec.md` |');
    expectAnchors(OPERATOR02, anchorNumbers(cell(row, 2)), {
      776: 'Stripe の Webhook の受け口と契約の写しは billing/01',
      780: '#1911: 未完成の機能は画面に出さない',
      1695: '### POST /api/webhooks/stripe',
      1713: '試用終了のリマインダー (`trial_will_end`)',
      1856: "it('rejects webhook with invalid Stripe signature')",
      1857: "it('returns already_processed on second webhook with same event_id')",
      1867: '```typescript',
      1918: /^```$/,
      1923: 'Stripe webhook ハンドラ (`/api/webhooks/stripe`) の実装は billing/01',
    });
  });

  it('次の「同」の行の §22 の :1750-1757 が stripe-reconcile の見出しと「自動修復禁止」の行を指す', () => {
    const { next } = billing01Row('| `docs/design/operator/02-api-spec.md` |');
    expect(cell(next, 1), 'operator/02 の行の次は「同」の行').toBe('同');
    expectAnchors(OPERATOR02, anchorNumbers(cell(next, 2)), {
      1750: '### POST /api/cron/stripe-reconcile',
      1757: '4. 自動修復禁止',
    });
  });
});

describe('ほかの冊が要件 02・org/04 を行番号で指す先 (#1917 docs-1023a の R2 の同型の掃除)', () => {
  it('org/10 の要件 02 への行番号はどれも匿名化集計の最低人数の行を指す', () => {
    const cited = [...read(ORG10).matchAll(/02-organization-management\.md:(\d+)/g)].map(([, n]) => Number(n));
    expect(cited.length, 'org/10 に要件 02 の行番号がある').toBeGreaterThan(0);
    expectAnchors(REQ02, cited, { 884: '**匿名化集計の最低人数**' });
  });

  it('family/11 の org/04 の解散の行 (:NNN) が解散の行を指す', () => {
    const match = /org\/04-license-management\.md` の解散の行 \(`(:\d+)`\)/.exec(read(FAMILY11));
    expect(match, 'family/11 に org/04 の解散の行の行番号がある').not.toBeNull();
    expectAnchors(ORG04, anchorNumbers(match?.[1] ?? ''), { 295: '| **解散** |' });
  });
});
