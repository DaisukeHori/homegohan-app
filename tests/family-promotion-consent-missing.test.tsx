/**
 * 昇格の依頼画面 (/family/members/[id]/promote) と承諾画面 (/family/promotions/[token]) の #1173 の文
 * (設計書 docs/design/cross/14-parental-consent.md §6.5.6 の 15・16・T-PR1)
 *
 *   - 403 PARENTAL_CONSENT_REQUIRED → PARENTAL_CONSENT_COPY.promotionConsentMissing
 *   - 403 PROMOTION_UNDER_COPPA_AGE → PARENTAL_CONSENT_COPY.promotionUnderCoppaAge
 *   - ほかの code の文は変わらない
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARENTAL_CONSENT_COPY } from '@homegohan/shared';

const ids = vi.hoisted(() => ({
  ME: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  FAMILY: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
  CHILD: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  TOKEN: 'a'.repeat(64),
}));

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ids.CHILD, token: ids.TOKEN }),
  useRouter: () => router,
}));

function query(table: string) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => {
      if (table === 'user_profiles') return { data: { family_id: ids.FAMILY }, error: null };
      return { data: { id: ids.CHILD, display_name: 'たろう', role: 'child', user_id: null }, error: null };
    },
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return chain;
}

const client = vi.hoisted(() => ({
  auth: { getUser: vi.fn(), signOut: vi.fn() },
  from: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => client }));

const { default: PromoteRequestPage } = await import('@/app/(main)/family/members/[id]/promote/page');
const { default: PromotionConsentPage } = await import('@/app/family/promotions/[token]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status: number) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  client.auth.getUser.mockResolvedValue({ data: { user: { id: ids.ME, email: 'taro@example.com' } } });
  client.from.mockImplementation((table: string) => query(table));
  client.rpc.mockResolvedValue({
    data: {
      family_name: '山田家',
      member_display_name: 'たろう',
      requested_by_name: '山田花子',
      email: 'taro@example.com',
      status: 'pending',
      expires_at: '2999-01-01T00:00:00.000Z',
      current_user_email_matches: true,
    },
    error: null,
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function sendPromoteRequest() {
  await act(async () => {
    root.render(<PromoteRequestPage />);
  });
  await flush();
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(email, 'taro@example.com');
    email.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  });
  await flush();
}

async function acceptPromotion() {
  await act(async () => {
    root.render(<PromotionConsentPage />);
  });
  await flush();
  const accept = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes('参加を承認する'),
  )!;
  await act(async () => {
    accept.click();
  });
  await flush();
}

describe('昇格の依頼画面の #1173 の文 (T-PR1)', () => {
  it.each([
    ['PARENTAL_CONSENT_REQUIRED', PARENTAL_CONSENT_COPY.promotionConsentMissing],
    ['PROMOTION_UNDER_COPPA_AGE', PARENTAL_CONSENT_COPY.promotionUnderCoppaAge],
  ])('403 %s のときは専用の文を出す', async (code, message) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code, message: '参加リクエストの作成に失敗しました' } }, 403));
    await sendPromoteRequest();
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain('参加リクエストの作成に失敗しました');
  });

  it('ほかの code は従来どおり本文の message を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'NOT_FAMILY_ADULT', message: '参加リクエストの作成に失敗しました' } }, 403));
    await sendPromoteRequest();
    expect(container.textContent).toContain('参加リクエストの作成に失敗しました');
    expect(container.textContent).not.toContain(PARENTAL_CONSENT_COPY.promotionConsentMissing);
  });
});

describe('昇格の承諾画面の #1173 の文 (T-PR1)', () => {
  it.each([
    ['PARENTAL_CONSENT_REQUIRED', PARENTAL_CONSENT_COPY.promotionConsentMissing],
    ['PROMOTION_UNDER_COPPA_AGE', PARENTAL_CONSENT_COPY.promotionUnderCoppaAge],
  ])('403 %s のときは専用の文を出す', async (code, message) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code, message: 'raw' } }, 403));
    await acceptPromotion();
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain('raw');
  });

  it('ほかの code の文は変わらない (PROMOTION_REQUEST_EXPIRED)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'PROMOTION_REQUEST_EXPIRED', message: 'raw' } }, 410));
    await acceptPromotion();
    expect(container.textContent).toContain('この参加リクエストの期限が切れています。ご家族に再送を依頼してください。');
  });
});
