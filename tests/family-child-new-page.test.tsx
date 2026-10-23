/**
 * 子供の追加画面 (/family/members/child/new) の生年月日と保護者の同意 (#1173 / 設計書 docs/design/cross/14-parental-consent.md §6.5.6 の 9・T-CN1〜T-CN5)
 *
 *   - 生年月日は必須 (未来の日付では押せない)。生年月日は body の birth_date に入れ、child_profile には入れない
 *   - 18 歳未満なら同意の枠 (チェック 2・氏名・全文リンク)。揃うまで押せず、body に consent (版 = PARENTAL_CONSENT_DOCUMENT.version) が入る
 *   - 18 歳以上なら notRequiredNote を出し、consent を送らない
 *   - 409 PARENTAL_CONSENT_VERSION_MISMATCH は読み込み直しのボタン、403 PARENTAL_CONSENT_REQUIRED は表の文
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARENTAL_CONSENT_COPY, PARENTAL_CONSENT_DOCUMENT, PARENTAL_CONSENT_DOCUMENT_PATH } from '@homegohan/shared';
import { MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const client = vi.hoisted(() => ({
  auth: { getUser: async () => ({ data: { user: { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' } } }) },
  from: () => ({
    select: () => ({
      eq: () => ({ single: async () => ({ data: { family_id: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66' }, error: null }) }),
    }),
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => client }));

const { default: FamilyChildNewPage } = await import('@/app/(main)/family/members/child/new/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** JST 2026-10-16 12:00 に固定する (年齢の境を固定するため) */
const FIXED_NOW = new Date('2026-10-16T03:00:00.000Z');
const BIRTH_17 = '2008-10-17';
const BIRTH_70 = '1956-01-01';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let locationMock: { reload: ReturnType<typeof vi.fn> };

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

async function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const nameInput = () => container.querySelector<HTMLInputElement>('input[type="text"]')!;
const birthInput = () => container.querySelector<HTMLInputElement>('#child-birth-date')!;
const consentSection = () => container.querySelector('[data-testid="parental-consent-section"]');
const consentCheckboxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('[data-testid="parental-consent-section"] input[type="checkbox"]'));
const signedNameInput = () => container.querySelector<HTMLInputElement>('#parental-consent-signed-name')!;
const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

async function fillConsent() {
  for (const box of consentCheckboxes()) {
    await act(async () => {
      box.click();
    });
  }
  await setValue(signedNameInput(), '山田 花子');
}

async function submit() {
  await act(async () => {
    submitButton().click();
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
  router.push.mockClear();
  fetchMock = vi.fn(async () => jsonResponse({ data: { member: {}, consent_recorded: true } }, 201));
  vi.stubGlobal('fetch', fetchMock);
  locationMock = { reload: vi.fn() };
  vi.stubGlobal('location', locationMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<FamilyChildNewPage />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  await setValue(nameInput(), 'たろう');
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('子供の追加画面の生年月日と保護者の同意 (#1173)', () => {
  it('#1901 (cross/20 Q-27): 注意書きは実装に無い約束 (親が代わりに記録する) をせず、登録するのは名前・生年月日・性別だけと書く', async () => {
    expect(container.textContent).toContain('登録するのは、名前・生年月日・性別だけです。');
    expect(container.textContent).not.toContain('代わりに');
  });

  it('T-CN1: 生年月日が必須で、未入力・未来の日付では押せない', async () => {
    expect(birthInput().required).toBe(true);
    expect(birthInput().max).toBe('2026-10-16');
    expect(submitButton().disabled).toBe(true);

    await setValue(birthInput(), '2999-01-01');
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.CHILD_BIRTH_DATE_INVALID]);
  });

  it('T-CN2・T-CN3: 17 歳なら同意の枠が出て、揃うまで押せない。body に birth_date と consent が入り、child_profile に birth_date を入れない (S6)', async () => {
    await setValue(birthInput(), BIRTH_17);

    expect(consentSection()).not.toBeNull();
    expect(consentCheckboxes()).toHaveLength(2);
    expect(consentSection()!.querySelector(`a[href="${PARENTAL_CONSENT_DOCUMENT_PATH}"]`)).not.toBeNull();
    expect(consentSection()!.textContent).toContain(PARENTAL_CONSENT_COPY.guardianAttestLabel);
    expect(consentSection()!.textContent).toContain(PARENTAL_CONSENT_COPY.agreeLabel);
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      consentCheckboxes()[0].click();
    });
    expect(submitButton().disabled).toBe(true);
    await act(async () => {
      consentCheckboxes()[1].click();
    });
    expect(submitButton().disabled).toBe(true);
    await setValue(signedNameInput(), '   ');
    expect(submitButton().disabled).toBe(true);
    await setValue(signedNameInput(), '山田 花子');
    expect(submitButton().disabled).toBe(false);

    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/family/members/child');
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      family_id: FAMILY_ID,
      display_name: 'たろう',
      child_profile: {},
      birth_date: BIRTH_17,
      consent: { version: PARENTAL_CONSENT_DOCUMENT.version, signed_name: '山田 花子', guardian_attested: true },
    });
    expect(sent.child_profile).not.toHaveProperty('birth_date');
    expect(router.push).toHaveBeenCalledWith('/family/members');
  });

  it('T-CN4: 409 PARENTAL_CONSENT_VERSION_MISMATCH で読み込み直しのボタンを出す', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'PARENTAL_CONSENT_VERSION_MISMATCH', message: 'x' }, current: {} }, 409),
    );
    await setValue(birthInput(), BIRTH_17);
    await fillConsent();
    await submit();

    expect(container.textContent).toContain(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.PARENTAL_CONSENT_VERSION_MISMATCH]);
    const reload = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('読み込み直す'));
    expect(reload).toBeTruthy();
    await act(async () => {
      reload!.click();
    });
    expect(locationMock.reload).toHaveBeenCalledTimes(1);
  });

  it('T-CN4: 403 PARENTAL_CONSENT_REQUIRED で表の文を出す (読み込み直しのボタンは出さない)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'PARENTAL_CONSENT_REQUIRED', message: 'raw' } }, 403));
    await setValue(birthInput(), BIRTH_17);
    await fillConsent();
    await submit();

    expect(container.textContent).toContain(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.PARENTAL_CONSENT_REQUIRED]);
    expect(container.textContent).not.toContain('raw');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('読み込み直す'))).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('T-CN5: 70 歳なら同意の枠は出ず notRequiredNote が出て、consent を送らない (S8)', async () => {
    await setValue(birthInput(), BIRTH_70);

    expect(consentSection()).toBeNull();
    expect(container.textContent).toContain(PARENTAL_CONSENT_COPY.notRequiredNote);
    expect(submitButton().disabled).toBe(false);

    await submit();
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toEqual({ family_id: FAMILY_ID, display_name: 'たろう', child_profile: {}, birth_date: BIRTH_70 });
  });
});
