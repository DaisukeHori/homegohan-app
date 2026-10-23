// @vitest-environment node
/**
 * API の失敗の本文の日本語化 (#1917) の骨組みの見張り
 *
 * 問題:
 *   画面 (src/app) とモバイル (apps/mobile) は、API の失敗の本文の文 (`error` の文字列か `error.message`) をそのまま見せることが多い。
 *   route が 'Unauthorized' などの英語の文や、例外の文面 (`err.message`。requireRole の 'Requires one of: super_admin' など) を返すと、
 *   失敗したときだけ英語が画面に出る。#1966 が /api/org だけを直した形を、全 API に広げるための共有物の見張り。
 *
 * このテストが確かめること:
 *   1. 共通の関数 (src/lib/api/error-responses.ts) が、例外の文面に関わらず日本語の固定の文を、従来の本文の形と code で返す
 *   2. 走査の部品 (tests/helpers/api-error-text-scan.ts) が、わざと悪い fixture の英語の文と例外の文面を行つきで拾い、日本語の文は拾わない
 *   3. 直し終えた配下 (tests/helpers/api-error-japanese-scope.ts の JAPANESE_ERROR_API_DIRS) の route と共通の関数のファイルに、違反が 0 件
 *   4. 番兵: 一覧の外の配下の違反の件数が、基線 (UNFIXED_VIOLATION_BASELINE) と同じ (増えたら赤・減ったら一覧と基線の更新を求めて赤)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import { INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import {
  API_ACCOUNT_FROZEN_MESSAGE,
  API_CONFLICT_MESSAGE,
  API_FORBIDDEN_MESSAGE,
  API_INTERNAL_ERROR_MESSAGE,
  API_INVALID_JSON_MESSAGE,
  API_MFA_ENROLLMENT_REQUIRED_MESSAGE,
  API_MFA_REQUIRED_MESSAGE,
  API_NOT_FOUND_MESSAGE,
  API_NOT_ORG_MEMBER_MESSAGE,
  API_OP_PERMISSION_DENIED_CODE,
  API_UNAUTHENTICATED_CODE,
  API_UNAUTHENTICATED_MESSAGE,
  AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED,
  AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED,
  DEFAULT_FORBIDDEN_MESSAGES,
  type AuthFailureCodeSource,
  authFailureFlat,
  authFailureNested,
  forbiddenMessageOf,
} from '@/lib/api/error-responses';
import {
  API_ROUTES_ROOT,
  JAPANESE,
  REPO_ROOT,
  apiTopLevelDirOf,
  findErrorTextViolations,
  isEnglishOnly,
  isUnderDir,
  routeFilesUnder,
} from './helpers/api-error-text-scan';
import {
  JAPANESE_ERROR_API_DIRS,
  JAPANESE_ERROR_SHARED_BODY_FILES,
  SENTINEL_EXCLUDED_ROUTE_FILES,
  UNFIXED_VIOLATION_BASELINE,
} from './helpers/api-error-japanese-scope';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** requireRole が投げる ForbiddenError の英語の文面 (src/lib/auth/helpers.ts) */
const ENGLISH_ROLE_DETAIL = 'Requires one of: super_admin';
const ENGLISH_ORG_ADMIN_DETAIL = 'owner/admin role required';

describe('共通の関数の固定の文', () => {
  it.each([
    ['401', API_UNAUTHENTICATED_MESSAGE],
    ['403', API_FORBIDDEN_MESSAGE],
    ['403 組織に所属していない', API_NOT_ORG_MEMBER_MESSAGE],
    ['403 凍結', API_ACCOUNT_FROZEN_MESSAGE],
    ['403 二段階認証の確認', API_MFA_REQUIRED_MESSAGE],
    ['403 二段階認証の登録', API_MFA_ENROLLMENT_REQUIRED_MESSAGE],
    ['400 JSON が読めない', API_INVALID_JSON_MESSAGE],
    ['404', API_NOT_FOUND_MESSAGE],
    ['409', API_CONFLICT_MESSAGE],
    ['500', API_INTERNAL_ERROR_MESSAGE],
  ])('%s の文は日本語で、英語だけの文ではない', (_label, message) => {
    expect(message.length).toBeGreaterThan(0);
    expect(JAPANESE.test(message)).toBe(true);
    expect(isEnglishOnly(message)).toBe(false);
  });

  it('文は従来の日本語の文と同じ (/api/org・internalError・凍結・二段階認証の例外の文面)', () => {
    expect(API_UNAUTHENTICATED_MESSAGE).toBe('ログインが必要です');
    expect(API_FORBIDDEN_MESSAGE).toBe('この操作を行う権限がありません');
    expect(API_NOT_ORG_MEMBER_MESSAGE).toBe('組織に所属していません');
    expect(API_INVALID_JSON_MESSAGE).toBe('リクエストボディが不正です');
    expect(API_INTERNAL_ERROR_MESSAGE).toBe(INTERNAL_ERROR_MESSAGE);
    expect(API_ACCOUNT_FROZEN_MESSAGE).toBe('アカウントが凍結されています');
    expect(API_MFA_REQUIRED_MESSAGE).toBe('二段階認証の確認が必要です');
    expect(API_MFA_ENROLLMENT_REQUIRED_MESSAGE).toBe('二段階認証の登録が必要です');
  });

  it('既定の 403 の表の文は、どれも日本語', () => {
    expect([...DEFAULT_FORBIDDEN_MESSAGES.keys()].sort()).toEqual(
      ['AUTH_2FA_ENROLLMENT_REQUIRED', 'AUTH_2FA_REQUIRED', 'AUTH_ACCOUNT_FROZEN', 'PERM_NOT_ORG_MEMBER'].sort(),
    );
    for (const message of DEFAULT_FORBIDDEN_MESSAGES.values()) expect(isEnglishOnly(message)).toBe(false);
  });
});

describe('共通の関数は、例外の文面に関わらず日本語の固定の文を返す', () => {
  it.each([
    ['未ログイン (AUTH_UNAUTHENTICATED)', new AuthError('AUTH_UNAUTHENTICATED'), HTTP_UNAUTHORIZED, 'UNAUTHORIZED', 'AUTH_UNAUTHENTICATED', API_UNAUTHENTICATED_MESSAGE],
    ['プロフィールが無い (英語の文面つき)', new AuthError('AUTH_PROFILE_NOT_FOUND', 'Profile not found'), HTTP_UNAUTHORIZED, 'UNAUTHORIZED', 'AUTH_PROFILE_NOT_FOUND', API_UNAUTHENTICATED_MESSAGE],
    ['ロールが足りない (requireRole)', new ForbiddenError('PERM_DENIED', ENGLISH_ROLE_DETAIL), HTTP_FORBIDDEN, 'FORBIDDEN', 'PERM_DENIED', API_FORBIDDEN_MESSAGE],
    ['組織の管理者でない (requireOrgAdmin)', new ForbiddenError('PERM_DENIED', ENGLISH_ORG_ADMIN_DETAIL), HTTP_FORBIDDEN, 'FORBIDDEN', 'PERM_DENIED', API_FORBIDDEN_MESSAGE],
    ['組織が違う (文面なし)', new ForbiddenError('PERM_ORG_MISMATCH'), HTTP_FORBIDDEN, 'FORBIDDEN', 'PERM_ORG_MISMATCH', API_FORBIDDEN_MESSAGE],
    ['組織に所属していない', new ForbiddenError('PERM_NOT_ORG_MEMBER', 'not a member'), HTTP_FORBIDDEN, 'FORBIDDEN', 'PERM_NOT_ORG_MEMBER', API_NOT_ORG_MEMBER_MESSAGE],
    ['凍結 (英語の文面に差し替わっても)', new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'Account frozen'), HTTP_FORBIDDEN, 'FORBIDDEN', 'AUTH_ACCOUNT_FROZEN', API_ACCOUNT_FROZEN_MESSAGE],
    ['二段階認証の確認 (MfaRequiredError)', new MfaRequiredError('AUTH_2FA_REQUIRED', 'MFA required'), HTTP_FORBIDDEN, 'FORBIDDEN', 'AUTH_2FA_REQUIRED', API_MFA_REQUIRED_MESSAGE],
    ['二段階認証の登録 (MfaRequiredError)', new MfaRequiredError('AUTH_2FA_ENROLLMENT_REQUIRED'), HTTP_FORBIDDEN, 'FORBIDDEN', 'AUTH_2FA_ENROLLMENT_REQUIRED', API_MFA_ENROLLMENT_REQUIRED_MESSAGE],
    ['知らないコード', new ForbiddenError('SOMETHING_NEW', 'Something went wrong'), HTTP_FORBIDDEN, 'FORBIDDEN', 'SOMETHING_NEW', API_FORBIDDEN_MESSAGE],
  ])('%s: flat・nested (code は http / error) の本文', async (_label, err, status, httpCode, errorCode, message) => {
    const flat = authFailureFlat(err);
    const nestedHttp = authFailureNested(err);
    const nestedHttpExplicit = authFailureNested(err, { code: 'http' });
    const nestedError = authFailureNested(err, { code: 'error' });

    expect(flat?.status).toBe(status);
    expect(nestedHttp?.status).toBe(status);
    expect(nestedError?.status).toBe(status);

    const flatText = (await flat?.text()) ?? '';
    const nestedErrorText = (await nestedError?.text()) ?? '';
    expect(JSON.parse(flatText)).toEqual({ error: message });
    expect(await nestedHttp?.json()).toEqual({ error: { code: httpCode, message } });
    expect(await nestedHttpExplicit?.json()).toEqual({ error: { code: httpCode, message } });
    expect(JSON.parse(nestedErrorText)).toEqual({ error: { code: errorCode, message } });

    // 例外の文面は、どの形の本文にも入らない (code と同じ文面のとき = 文面を渡さなかったときを除く)
    if (err.message !== err.code) {
      expect(flatText).not.toContain(err.message);
      expect(nestedErrorText).not.toContain(err.message);
    }
  });

  it('認可の失敗でなければ null (呼び出し側が internalError などにする)', () => {
    expect(authFailureFlat(new Error('boom'))).toBeNull();
    expect(authFailureFlat(null)).toBeNull();
    expect(authFailureNested('boom')).toBeNull();
    expect(authFailureNested(undefined, { code: 'error' })).toBeNull();
  });

  it('403 の文の表を差し替えられる (表に無い code は API_FORBIDDEN_MESSAGE)', async () => {
    const table = new Map([['PERM_DENIED', '運営の権限が必要です']]);
    const denied = new ForbiddenError('PERM_DENIED', ENGLISH_ROLE_DETAIL);
    const frozen = new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています');
    expect(forbiddenMessageOf(denied, table)).toBe('運営の権限が必要です');
    expect(forbiddenMessageOf(frozen, table)).toBe(API_FORBIDDEN_MESSAGE);
    expect(forbiddenMessageOf(frozen)).toBe(API_ACCOUNT_FROZEN_MESSAGE);
    expect(await authFailureFlat(denied, { forbiddenMessages: table })?.json()).toEqual({ error: '運営の権限が必要です' });
    expect(await authFailureNested(frozen, { forbiddenMessages: table })?.json()).toEqual({
      error: { code: 'FORBIDDEN', message: API_FORBIDDEN_MESSAGE },
    });
  });

  describe('nested の code を 401 と 403 で別々に選べる (admin の route の従来の code を保てる)', () => {
    const unauthenticated = new AuthError('AUTH_UNAUTHENTICATED', 'Not authenticated');
    const roleDenied = new ForbiddenError('PERM_DENIED', ENGLISH_ROLE_DETAIL);
    const frozen = new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'Account frozen');

    async function bodyTextOf(err: unknown, code: AuthFailureCodeSource): Promise<{ status: number | undefined; text: string }> {
      const res = authFailureNested(err, { code });
      return { status: res?.status, text: (await res?.text()) ?? '' };
    }

    it('admin の営業・問い合わせの形: 401 = 例外の code・403 = OP_PERMISSION_DENIED (src/app/api/admin/sales/leads/route.ts の従来の code)', async () => {
      const r401 = await bodyTextOf(unauthenticated, AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED);
      const r403 = await bodyTextOf(roleDenied, AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED);
      const rFrozen = await bodyTextOf(frozen, AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED);
      expect(r401.status).toBe(HTTP_UNAUTHORIZED);
      expect(JSON.parse(r401.text)).toEqual({ error: { code: 'AUTH_UNAUTHENTICATED', message: API_UNAUTHENTICATED_MESSAGE } });
      expect(r403.status).toBe(HTTP_FORBIDDEN);
      expect(JSON.parse(r403.text)).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message: API_FORBIDDEN_MESSAGE } });
      expect(JSON.parse(rFrozen.text)).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message: API_ACCOUNT_FROZEN_MESSAGE } });
      // 例外の文面は入らない
      expect(r401.text).not.toContain('Not authenticated');
      expect(r403.text).not.toContain(ENGLISH_ROLE_DETAIL);
      expect(rFrozen.text).not.toContain('Account frozen');
    });

    it('admin の会計の形: 401 = UNAUTHENTICATED・403 = OP_PERMISSION_DENIED (src/app/api/admin/finance/revenue/route.ts の従来の code)', async () => {
      const r401 = await bodyTextOf(unauthenticated, AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED);
      const r403 = await bodyTextOf(roleDenied, AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED);
      expect(r401.status).toBe(HTTP_UNAUTHORIZED);
      expect(JSON.parse(r401.text)).toEqual({ error: { code: 'UNAUTHENTICATED', message: API_UNAUTHENTICATED_MESSAGE } });
      expect(r403.status).toBe(HTTP_FORBIDDEN);
      expect(JSON.parse(r403.text)).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message: API_FORBIDDEN_MESSAGE } });
      expect(r401.text).not.toContain('Not authenticated');
      expect(r403.text).not.toContain(ENGLISH_ROLE_DETAIL);
    });

    it('固定の code の定数は従来の route が書いていた文字列と同じ', () => {
      expect(API_UNAUTHENTICATED_CODE).toBe('UNAUTHENTICATED');
      expect(API_OP_PERMISSION_DENIED_CODE).toBe('OP_PERMISSION_DENIED');
    });

    it('どの組み合わせでも 401 と 403 は独立に決まる (http / error / 固定)', async () => {
      const rules: ReadonlyArray<readonly [AuthFailureCodeSource, string, string]> = [
        [{ unauthorized: 'http', forbidden: 'error' }, 'UNAUTHORIZED', 'PERM_DENIED'],
        [{ unauthorized: 'error', forbidden: 'http' }, 'AUTH_UNAUTHENTICATED', 'FORBIDDEN'],
        [{ unauthorized: { fixed: 'X_401' }, forbidden: 'http' }, 'X_401', 'FORBIDDEN'],
        [{ fixed: 'SAME_CODE' }, 'SAME_CODE', 'SAME_CODE'],
        ['error', 'AUTH_UNAUTHENTICATED', 'PERM_DENIED'],
        ['http', 'UNAUTHORIZED', 'FORBIDDEN'],
      ];
      for (const [code, expected401, expected403] of rules) {
        expect(JSON.parse((await bodyTextOf(unauthenticated, code)).text)).toEqual({
          error: { code: expected401, message: API_UNAUTHENTICATED_MESSAGE },
        });
        expect(JSON.parse((await bodyTextOf(roleDenied, code)).text)).toEqual({
          error: { code: expected403, message: API_FORBIDDEN_MESSAGE },
        });
      }
    });

    it('固定の code は素の文字列では渡せない ({ fixed } で包む。\'http\' / \'error\' と型の上で混ざらない)', () => {
      // @ts-expect-error 素の文字列の固定の code は型で拒む
      const wrong: AuthFailureCodeSource = 'OP_PERMISSION_DENIED';
      expect(wrong).toBe('OP_PERMISSION_DENIED');
    });

    it('認可の失敗でなければ、どの選び方でも null', () => {
      expect(authFailureNested(new Error('boom'), { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED })).toBeNull();
      expect(authFailureNested(null, { code: AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED })).toBeNull();
    });
  });

  it('ヘッダを付けられる (付けなければ付けない)', () => {
    const headers = { 'Cache-Control': 'no-store' };
    expect(authFailureFlat(new AuthError('AUTH_UNAUTHENTICATED'), { headers })?.headers.get('Cache-Control')).toBe('no-store');
    expect(authFailureNested(new ForbiddenError('PERM_DENIED'), { headers })?.headers.get('Cache-Control')).toBe('no-store');
    expect(authFailureFlat(new AuthError('AUTH_UNAUTHENTICATED'))?.headers.get('Cache-Control')).toBeNull();
  });
});

describe('走査の部品: 英語の文と例外の文面を見つけられる', () => {
  const FIXTURE_FILE = 'src/app/api/__fixture__/route.ts';
  const FIXTURE = `
    import { NextResponse } from 'next/server';
    import { ORG_API_FORBIDDEN_MESSAGE } from '@/lib/org-api-errors';
    import { API_NOT_FOUND_MESSAGE } from '@/lib/api/error-responses';
    const LOCAL_ENGLISH = 'Forbidden';
    const LOCAL_JAPANESE = 'このチャレンジの状態は変えられません';
    export async function GET() {
      // コメントの 'Unauthorized' は見ない
      if (a) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      if (b) return NextResponse.json({ error: LOCAL_ENGLISH }, { status: 403 });
      if (c) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
      if (d) return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, { status: 500 });
      if (e) return challengeError('INTERNAL_ERROR', 'Internal server error', 500);
      if (f) return NextResponse.json({ error: x ? 'Invalid JSON' : '部署が見つかりません', code: 'INVALID' }, { status: 400 });
      if (g) return NextResponse.json({ error: \`目標値は \${min} 以上\`, code: 'INVALID_TARGET' }, { status: 400 });
      if (h) return NextResponse.json({ error: LOCAL_JAPANESE, code: 'LOCKED' }, { status: 409 });
      if (i) return NextResponse.json({ error: ORG_API_FORBIDDEN_MESSAGE }, { status: 403 });
      if (j) return NextResponse.json({ error: 'id は必須です' }, { status: 400 });
      if (k) return Response.json({ error: e.message ?? 'Not found' }, { status: 404 });
      if (l) return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });
      return NextResponse.json({ ok: true, title: 'Health' });
    }
  `;
  const lineOf = (needle: string) => FIXTURE.split('\n').findIndex((l) => l.includes(needle)) + 1;

  it('英語の文 (リテラル・定数・三項の枝・?? の右辺・nested の message・challengeError の文) と、例外の文面を、行つきで見つける', () => {
    const findings = findErrorTextViolations(FIXTURE_FILE, FIXTURE);
    expect(findings.filter((f) => f.kind === 'english').map((f) => f.text).sort()).toEqual(
      ['Unauthorized', 'Forbidden', 'Internal server error', 'Internal server error', 'Invalid JSON', 'Not found'].sort(),
    );
    expect(findings.filter((f) => f.kind === 'exception-message').map((f) => f.line)).toEqual([
      lineOf("message: err.message"),
      lineOf("e.message ?? 'Not found'"),
    ]);
    expect(findings.find((f) => f.text === 'Unauthorized')?.line).toBe(lineOf("{ error: 'Unauthorized' }"));
    expect(findings.every((f) => f.file === FIXTURE_FILE)).toBe(true);
  });

  it('日本語の文・日本語に混じる英字・import した日本語の定数 (2 段の import を含む)・error / message 以外のプロパティ・コメントは数えない', () => {
    const texts = findErrorTextViolations(FIXTURE_FILE, FIXTURE).map((f) => f.text);
    for (const ignored of ['部署が見つかりません', '目標値は 以上', 'このチャレンジの状態は変えられません', 'id は必須です', 'Health', API_NOT_FOUND_MESSAGE, API_FORBIDDEN_MESSAGE]) {
      expect(texts).not.toContain(ignored);
    }
  });

  it('違反の無い fixture では 0 件', () => {
    const clean = `
      import { NextResponse } from 'next/server';
      import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
      export async function GET() {
        return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
      }
    `;
    expect(findErrorTextViolations(FIXTURE_FILE, clean)).toEqual([]);
  });

  it('配下の判定は区切りの / で切る・最初の区切りでまとめる', () => {
    expect(isUnderDir('src/app/api/org/settings/route.ts', 'src/app/api/org')).toBe(true);
    expect(isUnderDir('src/app/api/organizations/route.ts', 'src/app/api/org')).toBe(false);
    expect(apiTopLevelDirOf('src/app/api/super-admin/llm/quotas/route.ts')).toBe('src/app/api/super-admin');
  });
});

const ALL_ROUTE_FILES = routeFilesUnder(API_ROUTES_ROOT);
const isDone = (file: string) => JAPANESE_ERROR_API_DIRS.some((dir) => isUnderDir(file, dir));

describe('見張りの範囲 (tests/helpers/api-error-japanese-scope.ts) が実在する', () => {
  it('直し終えた配下は、どれも route を持つディレクトリ (初めは /api/org を含む)', () => {
    expect(JAPANESE_ERROR_API_DIRS).toContain('src/app/api/org');
    for (const dir of JAPANESE_ERROR_API_DIRS) {
      expect(ALL_ROUTE_FILES.filter((file) => isUnderDir(file, dir)).length, dir).toBeGreaterThan(0);
    }
  });

  it('共通の関数のファイル・番兵から外す route は実在する (外す route は直し終えた配下に入っていない)', () => {
    for (const file of [...JAPANESE_ERROR_SHARED_BODY_FILES, ...SENTINEL_EXCLUDED_ROUTE_FILES]) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
    }
    for (const file of SENTINEL_EXCLUDED_ROUTE_FILES) expect(isDone(file), file).toBe(false);
  });
});

describe('直し終えた配下と共通の関数のファイルの失敗の本文に、英語の文と例外の文面が無い', () => {
  const files = [...ALL_ROUTE_FILES.filter(isDone), ...JAPANESE_ERROR_SHARED_BODY_FILES];
  const findings = files.flatMap((file) => findErrorTextViolations(file));

  it('英語だけの文が無い', () => {
    expect(findings.filter((f) => f.kind === 'english').map((f) => `${f.file}:${f.line} 「${f.text}」`)).toEqual([]);
  });

  it('例外の文面 (X.message) を本文の文に入れていない', () => {
    expect(findings.filter((f) => f.kind === 'exception-message').map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });
});

describe('番兵: 一覧の外の配下の違反の件数は基線と同じ', () => {
  // 全 route の構文木の走査は、テストの時間切れに掛からないよう、収集のときに 1 回だけ行う (上の describe と同じ)
  const excluded = new Set(SENTINEL_EXCLUDED_ROUTE_FILES);
  const unfixedFiles = ALL_ROUTE_FILES.filter((file) => !isDone(file) && !excluded.has(file));
  const counts: Record<string, number> = {};
  for (const file of unfixedFiles) {
    const n = findErrorTextViolations(file).length;
    if (n === 0) continue;
    const key = apiTopLevelDirOf(file);
    counts[key] = (counts[key] ?? 0) + n;
  }

  it('一覧の外の route を走査している (直し終えた配下と外す route を除いた残り)', () => {
    expect(unfixedFiles.length).toBe(ALL_ROUTE_FILES.filter((file) => !isDone(file)).length - SENTINEL_EXCLUDED_ROUTE_FILES.length);
    for (const file of unfixedFiles) {
      expect(isDone(file), file).toBe(false);
      expect(excluded.has(file), file).toBe(false);
    }
    // 直し終えた配下の route (super-admin の llm/quotas・operator の dissolve) は番兵の数に入らず、上の「違反が無い」の見張りに移る
    expect(unfixedFiles).not.toContain('src/app/api/super-admin/llm/quotas/route.ts');
    expect(unfixedFiles).not.toContain('src/app/api/operator/membership/org/[id]/dissolve/route.ts');
  });

  it('配下ごとの件数が UNFIXED_VIOLATION_BASELINE と一致する (増えた = 英語の文を足した / 減った = 直したら scope の一覧と基線を更新する)', () => {
    expect(counts).toEqual(UNFIXED_VIOLATION_BASELINE);
  });
});
