/**
 * #1912 組織の設定 (/org/settings) のプランと状態を日本語の名前で出す
 *
 * 以前は organizations.plan を capitalize で (Standard / Premium / Enterprise)、organizations.subscription_status を生の値で
 * (active / trial など) 出していた。組織の owner / admin が見る画面なので、src/lib/org-plans.ts の対応表を通して日本語の名前を出す。
 *
 * 確かめること:
 *  1. プランの対応表 (ORG_PLAN_LABELS) のキーは ORG_PLAN_VALUES と一致し、各値の表示名が決まっている
 *  2. 状態の対応表 (ORG_SUBSCRIPTION_STATUS_LABELS) のキーは ORG_SUBSCRIPTION_STATUS_VALUES と一致し、各値の表示名が決まっている
 *  3. 未知の値・null は「-」になり、内部の値を返さない
 *  4. 画面を描画すると、プランと状態の欄に日本語の名前が出て、英語の内部の値 (Standard / standard / active など) は出ない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (tests/org-settings-keys.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgSettingsData } from '@homegohan/shared';
import {
  ORG_PLAN_LABELS,
  ORG_PLAN_VALUES,
  ORG_SUBSCRIPTION_STATUS_LABELS,
  ORG_SUBSCRIPTION_STATUS_VALUES,
  ORG_UNKNOWN_VALUE_LABEL,
  orgPlanLabel,
  orgSubscriptionStatusLabel,
} from '@/lib/org-plans';

const { default: OrgSettingsPage } = await import('@/app/(org)/org/settings/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 期待する表示名 (オーナーの選択の例: スタンダード / プレミアム / エンタープライズ) */
const EXPECTED_PLAN_LABELS: Record<string, string> = {
  standard: 'スタンダード',
  premium: 'プレミアム',
  enterprise: 'エンタープライズ',
};

const EXPECTED_STATUS_LABELS: Record<string, string> = {
  trial: '無料体験中',
  trialing: '無料体験中',
  active: '有効',
  past_due: 'お支払い待ち',
  suspended: '停止中',
  cancelled: '解約済み',
  expired: '期限切れ',
};

/** 表に無い値 (内部の値が画面に出てはいけないもの) */
const UNKNOWN_PLAN_VALUES = ['free', 'Standard', 'STANDARD', 'org_standard', 'pro', 'secret_internal_plan', ''];
const UNKNOWN_STATUS_VALUES = ['canceled', 'Active', 'incomplete', 'grace', 'secret_internal_status', ''];

/** ラテン文字が含まれるか (表示名は日本語だけで、内部の値の英字を含まない) */
const LATIN = /[A-Za-z]/;

describe('プランの表示名 (ORG_PLAN_LABELS / orgPlanLabel)', () => {
  it('対応表のキーは ORG_PLAN_VALUES と一致する', () => {
    expect(Object.keys(ORG_PLAN_LABELS).sort()).toEqual([...ORG_PLAN_VALUES].sort());
    expect(Object.keys(EXPECTED_PLAN_LABELS).sort()).toEqual([...ORG_PLAN_VALUES].sort());
  });

  it.each(ORG_PLAN_VALUES.map((value) => [value]))('%s の表示名', (value) => {
    expect(orgPlanLabel(value)).toBe(EXPECTED_PLAN_LABELS[value]);
    expect(orgPlanLabel(value)).not.toMatch(LATIN);
  });

  it.each([...UNKNOWN_PLAN_VALUES.map((value) => [value] as [string | null | undefined]), [null], [undefined]])(
    '未知の値 %j は「-」で、内部の値を返さない',
    (value) => {
      expect(orgPlanLabel(value)).toBe(ORG_UNKNOWN_VALUE_LABEL);
      expect(ORG_UNKNOWN_VALUE_LABEL).toBe('-');
    },
  );
});

describe('状態の表示名 (ORG_SUBSCRIPTION_STATUS_LABELS / orgSubscriptionStatusLabel)', () => {
  it('対応表のキーは ORG_SUBSCRIPTION_STATUS_VALUES と一致する', () => {
    expect(Object.keys(ORG_SUBSCRIPTION_STATUS_LABELS).sort()).toEqual([...ORG_SUBSCRIPTION_STATUS_VALUES].sort());
    expect(Object.keys(EXPECTED_STATUS_LABELS).sort()).toEqual([...ORG_SUBSCRIPTION_STATUS_VALUES].sort());
  });

  it('列の既定の値 trial を含む', () => {
    expect(ORG_SUBSCRIPTION_STATUS_VALUES).toContain('trial');
  });

  it.each(ORG_SUBSCRIPTION_STATUS_VALUES.map((value) => [value]))('%s の表示名', (value) => {
    expect(orgSubscriptionStatusLabel(value)).toBe(EXPECTED_STATUS_LABELS[value]);
    expect(orgSubscriptionStatusLabel(value)).not.toMatch(LATIN);
  });

  it.each([...UNKNOWN_STATUS_VALUES.map((value) => [value] as [string | null | undefined]), [null], [undefined]])(
    '未知の値 %j は「-」で、内部の値を返さない',
    (value) => {
      expect(orgSubscriptionStatusLabel(value)).toBe(ORG_UNKNOWN_VALUE_LABEL);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 画面の描画
// ─────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

/**
 * 画面の fetch → 描画の更新まで待つための、マクロタスクの回数
 * (fetch・res.json の await を数回挟む。1 回では描画まで届かない)
 */
const FLUSH_TICKS = 5;

async function flush() {
  await act(async () => {
    for (let i = 0; i < FLUSH_TICKS; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function orgData(plan: string | null, subscriptionStatus: string | null): OrgSettingsData {
  return {
    id: '00000000-0000-4000-8000-000000000100',
    name: 'A 株式会社',
    plan,
    industry: 'IT',
    employee_count: 30,
    contact_email: 'owner@example.com',
    contact_name: '担当',
    subscription_status: subscriptionStatus,
    subscription_expires_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

async function renderWith(plan: string | null, subscriptionStatus: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: orgData(plan, subscriptionStatus) }), { status: 200 })),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<OrgSettingsPage />);
  });
  await flush();
}

/** 見出し (「プラン」「ステータス」) の次の段落の文字 */
function cardValue(heading: string): string {
  const label = Array.from(container.querySelectorAll('p')).find((p) => p.textContent === heading);
  if (!label) throw new Error(`見出し「${heading}」が無い`);
  const value = label.nextElementSibling;
  if (!value) throw new Error(`見出し「${heading}」の次の要素が無い`);
  return value.textContent ?? '';
}

/** 画面の文字のうち、入力欄の外のもの (入力欄の値は利用者が入れた組織名などで、ここでは見ない) */
function visibleText(): string {
  return container.textContent ?? '';
}

describe('組織の設定の画面のプランと状態', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each(ORG_PLAN_VALUES.map((plan) => [plan]))('プラン %s は日本語の名前で出し、英語の値は出さない', async (plan) => {
    await renderWith(plan, 'active');
    expect(cardValue('プラン')).toBe(EXPECTED_PLAN_LABELS[plan]);
    const text = visibleText();
    for (const value of ORG_PLAN_VALUES) {
      expect(text).not.toContain(value);
      expect(text.toLowerCase()).not.toContain(value);
    }
    // 以前は capitalize で頭を大文字にしていた (Standard など)
    expect(container.querySelector('.capitalize')).toBeNull();
  });

  it.each(ORG_SUBSCRIPTION_STATUS_VALUES.map((status) => [status]))('状態 %s は日本語の名前で出し、内部の値は出さない', async (status) => {
    await renderWith('standard', status);
    expect(cardValue('ステータス')).toBe(EXPECTED_STATUS_LABELS[status]);
    expect(visibleText().toLowerCase()).not.toContain(status);
  });

  it('表に無いプラン・状態は「-」で、内部の値を出さない', async () => {
    await renderWith('secret_internal_plan', 'secret_internal_status');
    expect(cardValue('プラン')).toBe('-');
    expect(cardValue('ステータス')).toBe('-');
    const text = visibleText();
    expect(text).not.toContain('secret_internal_plan');
    expect(text).not.toContain('secret_internal_status');
  });

  it('プラン・状態が null のときは「-」', async () => {
    await renderWith(null, null);
    expect(cardValue('プラン')).toBe('-');
    expect(cardValue('ステータス')).toBe('-');
  });
});
