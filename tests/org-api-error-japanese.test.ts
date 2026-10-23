// @vitest-environment node
/**
 * 組織の API (/api/org/**) の失敗の本文に、英語の文や例外の文面を入れていないことの見張り
 *
 * 問題:
 *   組織の管理画面 (src/app/(org)) と組織チャレンジの画面は、API の失敗の本文の文 (`error` の文字列か `error.message`) を
 *   そのまま利用者に見せる (例: src/app/(org)/org/challenges/page.tsx の readErrorMessage・invites/page.tsx の setSubmitError)。
 *   以前の /api/org の route は 'Unauthorized'・'Forbidden'・'Internal server error'・'Required fields missing'・
 *   'Invalid departmentId' などの英語の文や、例外の文面 (`err.message` = 'AUTH_UNAUTHENTICATED'・'owner/admin role required')
 *   を返しており、失敗したときだけ英語が画面に出ていた。文は src/lib/org-api-errors.ts の日本語の固定の文にした。
 *
 * このテストが確かめること:
 *   1. 走査: /api/org の全 route (と、route が本文を作るのに使う共通の関数のファイル) の失敗の本文の文が、どれも英語だけの文でない。
 *      本文の中で例外の文面 (`<なにか>.message`) を文として入れていない
 *   2. 組織の管理画面が呼ぶ API (src/app/(org) の `/api/...` の文字列) が、どれも 1 の走査の対象の route である
 *   3. 共通の関数 (orgAuthFailureFlat / orgAuthFailureNested / handleMemberError) が、例外の文面に関わらず日本語の固定の文を返す
 *
 * 1 の走査で数えるもの (TypeScript の構文木で読む。コメントは見ない):
 *   本文 = `NextResponse.json(本文, …)` / `Response.json(本文, …)` の 1 つ目の引数と、`challengeError(code, 文, status)` の 2 つ目の引数
 *   本文の文 = 本文のオブジェクトの `error` / `message` の値 (値がオブジェクトなら、その中の `error` / `message` も)。
 *     値の位置 = 式そのもの・三項演算子の 2 つの枝・?? / || の両辺・括弧・テンプレートの文字の部分。
 *     名前 (定数・変数) は、同じファイルの `const 名前 = …` と、import 元のファイルの `export const 名前 = …` を
 *     MAX_RESOLVE_DEPTH 段までたどる
 *   違反 = ラテン文字を含み日本語 (ひらがな・カタカナ・漢字・全角) を 1 文字も含まない文 / 値が `X.message` の文
 *
 * 走査の部品は tests/helpers/api-error-text-scan.ts に切り出した (#1917。全 API の見張り tests/api-error-japanese-scan.test.ts と共通)。
 * 走査の仕組みそのもの (わざと悪い fixture を拾うこと) は tests/api-error-japanese-scan.test.ts が確かめる。
 *
 * この検査の限界 (網羅はしない): 表 (オブジェクト) の要素を引いた文 (`MESSAGES[code]`)・関数の戻り値・別の関数に渡して本文にするもの・
 *   走査の対象の外のファイル (src/lib/membership/org-invite.ts などの所属の操作の共通の関数) が作る文は見ない。
 */
import { describe, expect, it } from 'vitest';
import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import {
  ORG_API_FORBIDDEN_MESSAGE,
  ORG_API_NOT_ORG_MEMBER_MESSAGE,
  ORG_API_UNAUTHENTICATED_MESSAGE,
  orgAuthFailureFlat,
  orgAuthFailureNested,
} from '@/lib/org-api-errors';
import { handleMemberError } from '@/lib/org-challenge-api';
import {
  JAPANESE,
  collectApiPaths,
  findErrorTextViolations,
  isEnglishOnly,
  routeFileOf as routeFileIn,
  routeFilesUnder,
  stringLiteralsOf,
  walkFiles,
} from './helpers/api-error-text-scan';
import { JAPANESE_ERROR_API_DIRS, JAPANESE_ERROR_SHARED_BODY_FILES } from './helpers/api-error-japanese-scope';

/** 走査する route のディレクトリ */
const API_ROOT = 'src/app/api/org';
/** route が本文を作るのに使う共通の関数のファイル (ここも走査する) */
const SHARED_BODY_FILES = ['src/lib/org-api-errors.ts', 'src/lib/org-challenge-api.ts', 'src/lib/api/error-responses.ts'];
/** 組織の管理画面のルートグループ */
const SCREEN_ROOT = 'src/app/(org)';

const ROUTE_FILES = routeFilesUnder(API_ROOT);
const findViolations = (file: string) => findErrorTextViolations(file);
const routeFileOf = (apiPath: string) => routeFileIn(apiPath, ROUTE_FILES);

describe('走査の範囲: /api/org は全 API の見張りの「直し終えた配下」に入っている', () => {
  it('JAPANESE_ERROR_API_DIRS に /api/org があり、本文を作る共通の関数のファイルも見張りの一覧にある', () => {
    expect(JAPANESE_ERROR_API_DIRS).toContain(API_ROOT);
    expect(JAPANESE_ERROR_SHARED_BODY_FILES).toEqual(expect.arrayContaining(SHARED_BODY_FILES));
  });

  it('画面の API の文字列を route のファイルに当てられる (動的な区切り・? 以降)', () => {
    expect(routeFileOf('/api/org/members/*/remove')).toBe('src/app/api/org/members/[user_id]/remove/route.ts');
    expect(routeFileOf('/api/org/departments')).toBe('src/app/api/org/departments/route.ts');
    expect(routeFileOf('/api/org/no-such-route')).toBeNull();
  });
});

describe('/api/org の失敗の本文に、英語の文と例外の文面が無い', () => {
  const files = [...ROUTE_FILES, ...SHARED_BODY_FILES];
  const findings = files.flatMap((file) => findViolations(file));

  it('走査する route がある (管理者向けとメンバー向けのチャレンジ・招待・設定・メンバー・統計・譲渡を含む)', () => {
    for (const expected of [
      'src/app/api/org/challenges/route.ts',
      'src/app/api/org/challenges/[id]/route.ts',
      'src/app/api/org/invites/route.ts',
      'src/app/api/org/settings/route.ts',
      'src/app/api/org/members/route.ts',
      'src/app/api/org/stats/route.ts',
      'src/app/api/org/owner-transfer/propose/route.ts',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it('英語だけの文が無い', () => {
    expect(findings.filter((f) => f.kind === 'english').map((f) => `${f.file}:${f.line} 「${f.text}」`)).toEqual([]);
  });

  it('例外の文面 (X.message) を本文の文に入れていない', () => {
    expect(findings.filter((f) => f.kind === 'exception-message').map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it('以前の英語の文は、どの route のソースにも残っていない (コメントを除く)', () => {
    const removed = [
      'Unauthorized',
      'Forbidden',
      'Internal server error',
      'Required fields missing',
      'Invalid departmentId',
      'Invalid JSON',
      'Challenge ID is required',
      'Invalid challenge ID',
      'Invalid status',
      'Invite ID is required',
    ];
    for (const file of files) {
      expect(stringLiteralsOf(file).filter((l) => removed.includes(l)), file).toEqual([]);
    }
  });
});

describe('組織の管理画面 (src/app/(org)) が呼ぶ API は、どれも上の走査の対象', () => {
  const screens = walkFiles(SCREEN_ROOT, (name) => name.endsWith('.tsx') || name.endsWith('.ts'));
  const apiPaths = [...new Set(screens.flatMap((file) => collectApiPaths(file)))].sort();

  it('画面の API を集められている (招待・チャレンジ・設定・除名・脱退・譲渡を含む)', () => {
    expect(apiPaths).toEqual(
      expect.arrayContaining([
        '/api/org/invites',
        '/api/org/challenges',
        '/api/org/settings',
        '/api/org/members/*/remove',
        '/api/org/leave',
        '/api/org/owner-transfer/propose',
      ]),
    );
  });

  it('画面が呼ぶ API は、どれも /api/org の route のファイルに当たる', () => {
    expect(apiPaths.filter((p) => routeFileOf(p) === null)).toEqual([]);
  });
});

describe('共通の関数は、例外の文面に関わらず日本語の固定の文を返す', () => {
  const ENGLISH_DETAIL = 'owner/admin role required';

  it.each([
    ['未ログイン (AuthError)', new AuthError('AUTH_UNAUTHENTICATED'), 401, ORG_API_UNAUTHENTICATED_MESSAGE],
    ['管理者でない (ForbiddenError PERM_DENIED)', new ForbiddenError('PERM_DENIED', ENGLISH_DETAIL), 403, ORG_API_FORBIDDEN_MESSAGE],
    ['組織に所属していない (PERM_NOT_ORG_MEMBER)', new ForbiddenError('PERM_NOT_ORG_MEMBER', 'not a member'), 403, ORG_API_NOT_ORG_MEMBER_MESSAGE],
    ['知らないコードの ForbiddenError', new ForbiddenError('SOMETHING_NEW', 'Something went wrong'), 403, ORG_API_FORBIDDEN_MESSAGE],
    // 共通の関数に載せ直した後も /api/org の文は従来のまま (凍結・二段階認証も「この操作を行う権限がありません」。
    // 全 API の既定の表 DEFAULT_FORBIDDEN_MESSAGES の文にはしない)
    ['凍結 (AUTH_ACCOUNT_FROZEN)', new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています'), 403, ORG_API_FORBIDDEN_MESSAGE],
    ['二段階認証の確認 (MfaRequiredError)', new MfaRequiredError('AUTH_2FA_REQUIRED', '二段階認証の確認が必要です'), 403, ORG_API_FORBIDDEN_MESSAGE],
  ])('%s: flat は { error: 文 }・nested は { error: { code, message: 文 } }', async (_label, err, status, message) => {
    const flat = orgAuthFailureFlat(err);
    const nested = orgAuthFailureNested(err);
    expect(flat?.status).toBe(status);
    expect(nested?.status).toBe(status);
    expect(await flat?.json()).toEqual({ error: message });
    expect(await nested?.json()).toEqual({
      error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message },
    });
    expect(JAPANESE.test(message)).toBe(true);
    expect(isEnglishOnly(message)).toBe(false);
  });

  it('文は以前の英語の文・例外の文面ではない', () => {
    expect(ORG_API_UNAUTHENTICATED_MESSAGE).toBe('ログインが必要です');
    expect(ORG_API_FORBIDDEN_MESSAGE).toBe('この操作を行う権限がありません');
    expect(ORG_API_NOT_ORG_MEMBER_MESSAGE).toBe('組織に所属していません');
  });

  it('認可の失敗でなければ null (呼び出し側が 500 にする)', () => {
    expect(orgAuthFailureFlat(new Error('boom'))).toBeNull();
    expect(orgAuthFailureNested('boom')).toBeNull();
    expect(orgAuthFailureNested(undefined)).toBeNull();
  });

  it('メンバー向けの handleMemberError も、知らない ForbiddenError の英語の文面を本文に入れない', async () => {
    const res = handleMemberError('GET /x', new ForbiddenError('PERM_DENIED', ENGLISH_DETAIL));
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'FORBIDDEN', message: ORG_API_FORBIDDEN_MESSAGE } });
    expect(text).not.toContain(ENGLISH_DETAIL);
  });
});
