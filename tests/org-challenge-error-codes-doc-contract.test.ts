/**
 * #1747 (設計書の追随 7-4): エラーコードの一覧 docs/design/cross/04-api-conventions.md §4.2 の「CHALLENGE 系」が、
 * 組織チャレンジの route が本文の `code` に入れるコードを全部書いているかを、ソースの文面だけで確かめる (DB もサーバも使わない)。
 *
 * §4.2 の CHALLENGE 系は、表と注の一覧で「上の表とこの一覧で全部」と書いている。
 * route にコードを足したのに設計書に書かないと、クライアントの実装者が知らないコードを受け取る。ここで止める。
 *
 *   1. route (管理者向け・メンバー向け) と、route が呼ぶ共通の関数 (handleMemberError ほか) が返すコードを、
 *      コメントを外した文面から集める。リテラルでないコード (定数・変数) は、下の対応表で値に直す。対応表に無いものは赤にする
 *   2. 集めたコードがどれも、§4.2 の CHALLENGE 系の節に `コード` の形で書かれている
 *   3. 逆に、CHALLENGE 系の表の 1 列目に書いたコードは、どれも route が返す (返さないコードを表に残さない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NULL_CHARACTER_ERROR_CODE } from '@/lib/api/null-character';
import { ORG_CHALLENGE_LOCK_ERROR_CODES } from '@/lib/org-challenge-privacy';
import { stripComments } from './helpers/ai-reach';

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'design', 'cross', '04-api-conventions.md');
const SECTION_HEADING = '#### CHALLENGE 系';

/** 管理者向けの route (平たい形 `{ error, code }`) */
const ADMIN_ROUTE = 'src/app/api/org/challenges/route.ts';
/** メンバー向けの route (nested の形。challengeError で返す) */
const MEMBER_ROUTES = ['src/app/api/org/challenges/[id]/route.ts', 'src/app/api/org/challenges/[id]/join/route.ts'];
/** メンバー向けの route が呼ぶ共通の関数 (challengeError・handleMemberError) の置き場 */
const MEMBER_API_LIB = 'src/lib/org-challenge-api.ts';

const LOCK_CODES = Object.values(ORG_CHALLENGE_LOCK_ERROR_CODES);
/** リテラルでない `code: …` の式と、その式が取りうるコード。ここに無い式が route に現れたら、この表を足すまで赤にする */
const NON_LITERAL_CODE_EXPRESSIONS: Record<string, readonly string[]> = {
  'ORG_CHALLENGE_LOCK_ERROR_CODES.status': [ORG_CHALLENGE_LOCK_ERROR_CODES.status],
  // mapChallengeLockError (src/lib/org-challenge-privacy.ts) の戻り値。ORG_CHALLENGE_LOCK_ERROR_CODES の値のどれか
  'locked.code': LOCK_CODES,
};
/** route が呼ぶと、そのまま応答を返す共通の関数と、その関数が返すコード */
const RESPONDING_HELPERS: Record<string, readonly string[]> = {
  // src/lib/api/reject-null-character.ts。本文に NULL 文字があると 400 で断る
  rejectNullCharacterBody: [NULL_CHARACTER_ERROR_CODE],
};

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*[A-Z0-9]$/;

function readSource(relPath: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function codesFromHelpers(source: string): string[] {
  return Object.entries(RESPONDING_HELPERS)
    .filter(([name]) => new RegExp(`\\b${name}\\(`).test(source))
    .flatMap(([, codes]) => codes);
}

/** 管理者向けの route: `code: '…'` のリテラルと、対応表で直せる式 */
function collectAdminCodes(): { codes: string[]; unknownExpressions: string[] } {
  const source = readSource(ADMIN_ROUTE);
  const codes: string[] = [];
  const unknownExpressions: string[] = [];
  for (const match of source.matchAll(/\bcode:\s*([^,}\s]+)/g)) {
    const expression = match[1];
    const literal = /^'([^']*)'$/.exec(expression);
    if (literal) {
      codes.push(literal[1]);
    } else if (expression in NON_LITERAL_CODE_EXPRESSIONS) {
      codes.push(...NON_LITERAL_CODE_EXPRESSIONS[expression]);
    } else {
      unknownExpressions.push(expression);
    }
  }
  codes.push(...codesFromHelpers(source));
  return { codes, unknownExpressions };
}

/** メンバー向け: `challengeError('…'` のリテラル。定義 (function challengeError) を除き、リテラルでない呼び出しは赤にする */
function collectChallengeErrorCodes(relPath: string): { codes: string[]; nonLiteralCalls: number } {
  const source = readSource(relPath).replace(/function\s+challengeError\s*\(/g, '');
  const codes = [...source.matchAll(/\bchallengeError\(\s*'([^']*)'/g)].map((m) => m[1]);
  const calls = [...source.matchAll(/\bchallengeError\(/g)].length;
  return { codes: [...codes, ...codesFromHelpers(source)], nonLiteralCalls: calls - codes.length };
}

function challengeSection(): string {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const start = doc.indexOf(SECTION_HEADING);
  if (start < 0) return '';
  const next = doc.indexOf('\n#### ', start + SECTION_HEADING.length);
  return doc.slice(start, next < 0 ? undefined : next);
}

describe('#1747: 04-api-conventions §4.2 の CHALLENGE 系が、組織チャレンジの route の返すコードを全部書いている', () => {
  const admin = collectAdminCodes();
  const memberFiles = [...MEMBER_ROUTES, MEMBER_API_LIB].map((relPath) => ({ relPath, ...collectChallengeErrorCodes(relPath) }));
  const routeCodes = [...new Set([...admin.codes, ...memberFiles.flatMap((f) => f.codes)])].sort();
  const section = challengeSection();

  it('route のコードを、リテラルか対応表で全部読めている (読めない式があれば、対応表を足す)', () => {
    expect(admin.unknownExpressions).toEqual([]);
    expect(memberFiles.filter((f) => f.nonLiteralCalls !== 0).map((f) => f.relPath)).toEqual([]);
    // 読み取りが空回りしていない (表のコードと、表の外の接頭辞の無いコードの両方を拾っている)
    expect(routeCodes).toEqual(expect.arrayContaining(['CHALLENGE_NOT_FOUND', 'INVALID_TARGET', 'FORBIDDEN', 'INTERNAL_ERROR', ...LOCK_CODES]));
    expect(routeCodes.every((code) => ERROR_CODE_PATTERN.test(code))).toBe(true);
  });

  it('§4.2 に CHALLENGE 系の節がある', () => {
    expect(section).not.toBe('');
  });

  it('route が返すコードは、どれも CHALLENGE 系の節に `コード` の形で書かれている', () => {
    const missing = routeCodes.filter((code) => !section.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });

  it('CHALLENGE 系の表の 1 列目のコードは、どれも route が返す', () => {
    const tableCodes = [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => m[1]);
    expect(tableCodes.length).toBeGreaterThan(0);
    expect(tableCodes.filter((code) => !routeCodes.includes(code))).toEqual([]);
  });
});
