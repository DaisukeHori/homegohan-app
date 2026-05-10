import { describe, it, expect, afterEach } from 'vitest';
import {
  getInviteBaseUrl,
  buildOrgInviteUrl,
  buildFamilyInviteUrl,
  buildOrgTransferAcceptUrl,
  buildFamilyTransferAcceptUrl,
} from '@/lib/membership/urls';

const DEFAULT_BASE_URL = 'https://homegohan-app.vercel.app';

afterEach(() => {
  delete process.env.NEXT_PUBLIC_INVITE_BASE_URL;
});

describe('getInviteBaseUrl', () => {
  it('env 未設定時にデフォルト URL を返す', () => {
    delete process.env.NEXT_PUBLIC_INVITE_BASE_URL;
    expect(getInviteBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('env 設定時に override した URL を返す', () => {
    process.env.NEXT_PUBLIC_INVITE_BASE_URL = 'https://homegohan.com';
    expect(getInviteBaseUrl()).toBe('https://homegohan.com');
  });
});

describe('buildOrgInviteUrl', () => {
  it('デフォルト base URL + /invite/{token} を返す', () => {
    delete process.env.NEXT_PUBLIC_INVITE_BASE_URL;
    expect(buildOrgInviteUrl('abc123')).toBe(`${DEFAULT_BASE_URL}/invite/abc123`);
  });

  it('env override 時に正しい URL を返す', () => {
    process.env.NEXT_PUBLIC_INVITE_BASE_URL = 'https://example.com';
    expect(buildOrgInviteUrl('tok-456')).toBe('https://example.com/invite/tok-456');
  });
});

describe('buildFamilyInviteUrl', () => {
  it('デフォルト base URL + /invite/{token} を返す', () => {
    delete process.env.NEXT_PUBLIC_INVITE_BASE_URL;
    expect(buildFamilyInviteUrl('fam-tok')).toBe(`${DEFAULT_BASE_URL}/invite/fam-tok`);
  });
});

describe('buildOrgTransferAcceptUrl', () => {
  it('デフォルト base URL + /org/transfer-accept/{proposalId} を返す', () => {
    delete process.env.NEXT_PUBLIC_INVITE_BASE_URL;
    expect(buildOrgTransferAcceptUrl('prop-001')).toBe(
      `${DEFAULT_BASE_URL}/org/transfer-accept/prop-001`,
    );
  });
});

describe('buildFamilyTransferAcceptUrl', () => {
  it('デフォルト base URL + /family/transfer-accept/{proposalId} を返す', () => {
    delete process.env.NEXT_PUBLIC_INVITE_BASE_URL;
    expect(buildFamilyTransferAcceptUrl('prop-002')).toBe(
      `${DEFAULT_BASE_URL}/family/transfer-accept/prop-002`,
    );
  });
});
