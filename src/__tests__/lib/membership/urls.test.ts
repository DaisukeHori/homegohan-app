import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  getInviteBaseUrl,
  buildOrgInviteUrl,
  buildFamilyInviteUrl,
  buildOrgTransferAcceptUrl,
  buildFamilyTransferAcceptUrl,
  buildFamilyPromotionUrl,
  buildFamilyMembersUrl,
  buildOrgMembersUrl,
} from '@/lib/membership/urls';

// いま実際にアプリが動いている URL。環境変数を何も設定していないときの既定値 (#1194: src/lib/site-config.ts)
const DEFAULT_BASE_URL = 'https://homegohan-app.vercel.app';

// 手元の環境変数 (NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_INVITE_BASE_URL) に左右されないよう、2 つとも未設定から始める
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getInviteBaseUrl', () => {
  it('env 未設定時にデフォルト URL を返す', () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    expect(getInviteBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('env 設定時に override した URL を返す', () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', 'https://homegohan.com');
    expect(getInviteBaseUrl()).toBe('https://homegohan.com');
  });

  // #1194 招待・譲渡のリンクも、サイトの URL (NEXT_PUBLIC_APP_URL) に従う。URL を 1 か所 (環境変数 1 つ) で切り替えられる
  it('NEXT_PUBLIC_INVITE_BASE_URL が未設定なら、サイトの URL (NEXT_PUBLIC_APP_URL) に従う', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.com');
    expect(getInviteBaseUrl()).toBe('https://homegohan.com');
    expect(buildOrgInviteUrl('abc123')).toBe('https://homegohan.com/invite/abc123');
  });

  it('NEXT_PUBLIC_INVITE_BASE_URL (以前の専用設定) があれば、NEXT_PUBLIC_APP_URL より優先する', () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', 'https://invite.example.test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.com');
    expect(getInviteBaseUrl()).toBe('https://invite.example.test');
  });

  it('上書きの末尾の / と前後の空白は除く (リンクが // にならない)', () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', ' https://invite.example.test/ ');
    expect(getInviteBaseUrl()).toBe('https://invite.example.test');
    expect(buildFamilyInviteUrl('tok')).toBe('https://invite.example.test/invite/tok');
  });

  it('上書きが空文字・空白だけなら、未設定と同じ扱い (サイトの URL / 既定値に戻る)', () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', '   ');
    expect(getInviteBaseUrl()).toBe(DEFAULT_BASE_URL);

    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.com');
    expect(getInviteBaseUrl()).toBe('https://homegohan.com');
  });
});

describe('buildOrgInviteUrl', () => {
  it('デフォルト base URL + /invite/{token} を返す', () => {
    expect(buildOrgInviteUrl('abc123')).toBe(`${DEFAULT_BASE_URL}/invite/abc123`);
  });

  it('env override 時に正しい URL を返す', () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', 'https://example.com');
    expect(buildOrgInviteUrl('tok-456')).toBe('https://example.com/invite/tok-456');
  });
});

describe('buildFamilyInviteUrl', () => {
  it('デフォルト base URL + /invite/{token} を返す', () => {
    expect(buildFamilyInviteUrl('fam-tok')).toBe(`${DEFAULT_BASE_URL}/invite/fam-tok`);
  });
});

describe('buildOrgTransferAcceptUrl', () => {
  it('デフォルト base URL + /org/transfer-accept/{proposalId} を返す', () => {
    expect(buildOrgTransferAcceptUrl('prop-001')).toBe(
      `${DEFAULT_BASE_URL}/org/transfer-accept/prop-001`,
    );
  });
});

describe('buildFamilyTransferAcceptUrl', () => {
  it('デフォルト base URL + /family/transfer-accept/{proposalId} を返す', () => {
    expect(buildFamilyTransferAcceptUrl('prop-002')).toBe(
      `${DEFAULT_BASE_URL}/family/transfer-accept/prop-002`,
    );
  });
});

// #1232 子供メンバーへの「参加確認のお願い」(本人同意) のページ
describe('buildFamilyPromotionUrl', () => {
  it('デフォルト base URL + /family/promotions/{token} を返す', () => {
    expect(buildFamilyPromotionUrl('promo-tok')).toBe(`${DEFAULT_BASE_URL}/family/promotions/promo-tok`);
  });

  it('サイトの URL (NEXT_PUBLIC_APP_URL) に従う', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test/');
    expect(buildFamilyPromotionUrl('promo-tok')).toBe('https://app.example.test/family/promotions/promo-tok');
  });
});

// #1160 脱退の通知メールに載せる、メンバー管理画面の URL
describe('buildFamilyMembersUrl', () => {
  it('デフォルト base URL + /family/members を返す', () => {
    expect(buildFamilyMembersUrl()).toBe(`${DEFAULT_BASE_URL}/family/members`);
  });

  it('env override 時に正しい URL を返す', () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', 'https://example.com');
    expect(buildFamilyMembersUrl()).toBe('https://example.com/family/members');
  });
});

describe('buildOrgMembersUrl', () => {
  it('デフォルト base URL + /org/members を返す', () => {
    expect(buildOrgMembersUrl()).toBe(`${DEFAULT_BASE_URL}/org/members`);
  });

  it('env override 時に正しい URL を返す', () => {
    vi.stubEnv('NEXT_PUBLIC_INVITE_BASE_URL', 'https://example.com');
    expect(buildOrgMembersUrl()).toBe('https://example.com/org/members');
  });
});
