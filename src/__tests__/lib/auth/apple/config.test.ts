// @vitest-environment node
/**
 * Sign in with Apple のサーバ側の設定と定数 (docs/design/mobile/08-sign-in-with-apple.md §11.2・§13.1)
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 環境変数が無いときの警告 (src/lib/env.ts) を DB に書かせない
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ACCOUNT_DELETED_EMAIL_TIMEOUT_MS } from '@/lib/account-deletion-notification';
import { DEFAULT_MAX_DURATION_MS } from '@/lib/account-deletion-storage';
import {
  APPLE_API_TIMEOUT_MS,
  APPLE_REVOKE_ATTEMPTS,
  APPLE_REVOKE_TOTAL_BUDGET_MS,
  APPLE_SIGN_IN_NATIVE_CLIENT_ID,
  readAppleSignInServerConfig,
} from '@/lib/auth/apple/config';

const ROOT = path.resolve(__dirname, '../../../../..');
/** 秒とミリ秒の換算 (退会の route の maxDuration は秒) */
const MS_PER_SECOND = 1000;

const TEAM_ID = 'TEAMID1234';
const KEY_ID = 'KEYID12345';
/**
 * ダミーの秘密鍵 (本物ではない)。PEM の BEGIN / END の行は文字列を分けて組み立てる。
 * ソースにそのまま書くと gitleaks の private-key ルール (.github/workflows/security.yml・local-ci の secrets 段) が
 * 秘密鍵として拾い、PR の検査が赤になるため (tests/no-literal-private-key.test.ts が守る)。
 */
const PEM_BEGIN_LINE = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const PEM_END_LINE = ['-----END', 'PRIVATE KEY-----'].join(' ');
const PEM_DUMMY_BODY = 'ABCDEF';
/** 環境変数に入れる形 (改行を \n の 2 文字で書いた 1 行) */
const PEM_ONE_LINE = [PEM_BEGIN_LINE, PEM_DUMMY_BODY, PEM_END_LINE].join('\\n');
/** readAppleSignInServerConfig が \n を改行に戻したあとの形 */
const PEM_MULTI_LINE = [PEM_BEGIN_LINE, PEM_DUMMY_BODY, PEM_END_LINE].join('\n');
const SERVICES_ID = 'com.homegohan.web';

function stubAll(overrides: Partial<Record<'TEAM' | 'KEY' | 'PEM' | 'SERVICES', string>> = {}): void {
  vi.stubEnv('APPLE_SIGN_IN_TEAM_ID', overrides.TEAM ?? TEAM_ID);
  vi.stubEnv('APPLE_SIGN_IN_KEY_ID', overrides.KEY ?? KEY_ID);
  vi.stubEnv('APPLE_SIGN_IN_PRIVATE_KEY', overrides.PEM ?? PEM_ONE_LINE);
  vi.stubEnv('APPLE_SIGN_IN_SERVICES_ID', overrides.SERVICES ?? SERVICES_ID);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('APPLE_SIGN_IN_NATIVE_CLIENT_ID', () => {
  it('apps/mobile/app.json の ios.bundleIdentifier と同じ', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/mobile/app.json'), 'utf8')) as {
      expo: { ios: { bundleIdentifier: string } };
    };
    expect(APPLE_SIGN_IN_NATIVE_CLIENT_ID).toBe(appJson.expo.ios.bundleIdentifier);
  });
});

describe('readAppleSignInServerConfig', () => {
  it('4 つがそろえば設定を返す', () => {
    stubAll();
    expect(readAppleSignInServerConfig()).toEqual({
      teamId: TEAM_ID,
      keyId: KEY_ID,
      privateKeyPem: PEM_MULTI_LINE,
      servicesId: SERVICES_ID,
    });
  });

  it.each([
    ['Team ID', { TEAM: '' }],
    ['Key ID', { KEY: '' }],
    ['秘密鍵', { PEM: '' }],
    ['空白だけの Team ID', { TEAM: '   ' }],
    ['空白だけの秘密鍵', { PEM: '   ' }],
  ] as const)('Team ID・Key ID・秘密鍵のどれかが無ければ null (%s が無い)', (_label, overrides) => {
    stubAll(overrides);
    expect(readAppleSignInServerConfig()).toBeNull();
  });

  it('秘密鍵の \\n を改行に戻す', () => {
    stubAll({ PEM: 'line1\\nline2\\nline3' });
    expect(readAppleSignInServerConfig()?.privateKeyPem).toBe('line1\nline2\nline3');
  });

  it('Services ID が無ければ servicesId は null (ほかはそろう)', () => {
    stubAll({ SERVICES: '' });
    expect(readAppleSignInServerConfig()).toMatchObject({ teamId: TEAM_ID, keyId: KEY_ID, servicesId: null });
  });

  it('呼ぶたびに環境変数を読む (route を読み込み直さなくても vi.stubEnv が効く)', () => {
    stubAll();
    expect(readAppleSignInServerConfig()).not.toBeNull();
    vi.stubEnv('APPLE_SIGN_IN_TEAM_ID', '');
    expect(readAppleSignInServerConfig()).toBeNull();
  });
});

describe('退会の時間の予算 (§13.1)', () => {
  it('APPLE_REVOKE_TOTAL_BUDGET_MS + DEFAULT_MAX_DURATION_MS (Storage の掃除) + ACCOUNT_DELETED_EMAIL_TIMEOUT_MS (完了メール) が、退会の route の maxDuration (秒) をミリ秒にした値より小さい', () => {
    const routeSource = fs.readFileSync(path.join(ROOT, 'src/app/api/account/delete/route.ts'), 'utf8');
    const match = /export const maxDuration = (\d+);/.exec(routeSource);
    expect(match, '退会の route の maxDuration').not.toBeNull();
    const maxDurationMs = Number(match![1]) * MS_PER_SECOND;
    expect(APPLE_REVOKE_TOTAL_BUDGET_MS + DEFAULT_MAX_DURATION_MS + ACCOUNT_DELETED_EMAIL_TIMEOUT_MS).toBeLessThan(maxDurationMs);
  });

  it('Apple の 1 回の待ちの上限は段階の予算より長く、失効は少なくとも 2 回試せる (予算の中で最大 APPLE_REVOKE_ATTEMPTS 回)', () => {
    expect(APPLE_API_TIMEOUT_MS).toBeGreaterThan(APPLE_REVOKE_TOTAL_BUDGET_MS);
    expect(APPLE_REVOKE_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });
});
