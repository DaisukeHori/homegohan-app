/**
 * #1165 回帰テスト: ログインに続けて失敗しても、アカウントをロックしない (docs/operations/auth-protection.md §1)。
 *
 * 一度入ったロック (5 回で 15 分・10 回で 1 時間・20 回で 24 時間・パスワードの再設定で解除) は、
 * 他人のメールアドレスで失敗を繰り返すだけで本人を締め出せてしまうため、外した。
 * ロックの応答・ロックのための DB の関数の呼び出し・ロックを外す API が、コードに戻ってきたら赤にする。
 * (振る舞いは tests/auth/guarded-login.test.ts と tests/api/auth-login-route.test.ts の「ロックしない」が確かめる)
 *
 * 判定はコメントを除いたコードで行う (説明のコメントに「423」「ロック」と書くのは構わない)。
 * コメントの除去は TypeScript のパーサーで行う (文字列の中の // などを誤って消さないように)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

/** 本番のコード (Web とモバイル) */
const CODE_DIRS = ['src', 'apps/mobile/app', 'apps/mobile/src'];
const CODE_EXT = /\.(ts|tsx)$/;
const SKIP_DIR = new Set(['node_modules', '__tests__', '.next']);

/** ログインの API の route (ここでは 423 を返さない) */
const AUTH_API_DIR = 'src/app/api/auth';

/** コードに戻ってきてはいけないもの → 理由 */
const FORBIDDEN_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/AUTH_ACCOUNT_LOCKED/, 'ロック中の応答の code'],
  [/auth_login_lock_status/, 'ロックの期限を読む DB の関数'],
  [/auth_login_record_failure\b/, 'ロックの段を決めるための、時間で戻らない数え方の DB の関数'],
  [/auth_login_apply_lock/, 'ロックの期限を書く DB の関数'],
  [/auth_login_account_user_id/, 'ロックの通知の宛先を引く DB の関数'],
  [/locked_until/, 'ロックの期限の列'],
  [/login-lock/, 'ロックのモジュール・ロックを外す API (/api/auth/login-lock/clear)'],
];

/** 423 (Locked) の応答 */
const LOCKED_STATUS = /\b423\b/;

function listCodeFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCodeFiles(rel));
    else if (CODE_EXT.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** コメントを除いたコード (TypeScript のパーサーで読み、コメント無しで出力し直す) */
function stripComments(fileName: string, text: string): string {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

/** コードの中の、戻ってきてはいけないもの (理由の一覧)。ログインの API なら 423 も見る */
function findLockoutCode(fileName: string, text: string, isAuthApi: boolean): string[] {
  const needsCheck = FORBIDDEN_TOKENS.some(([pattern]) => pattern.test(text)) || (isAuthApi && LOCKED_STATUS.test(text));
  if (!needsCheck) return [];
  const code = stripComments(fileName, text);
  const found = FORBIDDEN_TOKENS.filter(([pattern]) => pattern.test(code)).map(([, reason]) => reason);
  if (isAuthApi && LOCKED_STATUS.test(code)) found.push('423 (Locked) の応答');
  return found;
}

describe('ロックのコードが戻ってきていない', () => {
  const files = CODE_DIRS.flatMap(listCodeFiles);

  it('走査の対象が空ではない (ログインの API と、その中身を含む)', () => {
    expect(files).toContain(path.join('src/app/api/auth/login/route.ts'));
    expect(files).toContain(path.join('src/lib/auth/guarded-login.ts'));
    expect(files).toContain(path.join('src/lib/auth/login-failures.ts'));
  });

  it('本番のコード (Web・モバイル) に、ロックの応答・DB の関数・列・モジュールが無い。ログインの API は 423 を返さない', () => {
    const violations: string[] = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const isAuthApi = rel.startsWith(path.join(AUTH_API_DIR) + path.sep);
      for (const reason of findLockoutCode(rel, text, isAuthApi)) violations.push(`${rel}: ${reason}`);
    }
    expect(violations).toEqual([]);
  });

  it('ロックを外す API (/api/auth/login-lock/clear) と、ロックの通知のメールが無い', () => {
    for (const rel of [
      'src/app/api/auth/login-lock',
      'src/lib/auth/login-lock.ts',
      'src/lib/auth/login-lock-notification.ts',
      'src/lib/emails/account/login-locked.ts',
      'src/lib/emails/account/login-lock-admin.ts',
    ]) {
      expect(fs.existsSync(path.join(ROOT, rel)), `${rel} が戻ってきている`).toBe(false);
    }
  });
});

describe('検査そのものが、ロックのコードを見つける (検出力)', () => {
  it('以前の route のロックの応答 (423 + AUTH_ACCOUNT_LOCKED) を見つける', () => {
    const before = `
      export function toResponse(result: { kind: string; retryAfterSec: number }) {
        switch (result.kind) {
          case 'locked':
            return json({ error: 'locked', code: 'AUTH_ACCOUNT_LOCKED', retryAfter: result.retryAfterSec }, 423, {});
        }
      }`;
    expect(findLockoutCode('route.ts', before, true)).toEqual(['ロック中の応答の code', '423 (Locked) の応答']);
  });

  it('ロックの期限を書く DB の関数の呼び出し・ロックを外す API の呼び出しを見つける', () => {
    expect(
      findLockoutCode('x.ts', `await client.rpc('auth_login_apply_lock', { p_email: e, p_locked_until: t });`, false),
    ).toEqual(['ロックの期限を書く DB の関数', 'ロックの期限の列']);
    expect(findLockoutCode('page.tsx', `await fetch("/api/auth/login-lock/clear", { method: "POST" });`, false)).toEqual([
      'ロックのモジュール・ロックを外す API (/api/auth/login-lock/clear)',
    ]);
  });

  it('コメントの中の言及は数えない。文字列の中の // は消さない', () => {
    const commented = `
      // 以前は 423 AUTH_ACCOUNT_LOCKED を返していた (auth_login_apply_lock)
      /* login-lock は外した */
      export const url = 'https://example.com//423';`;
    expect(findLockoutCode('route.ts', commented, true)).toEqual(['423 (Locked) の応答']);
    expect(findLockoutCode('route.ts', '// 423 AUTH_ACCOUNT_LOCKED\nexport const ok = 200;', true)).toEqual([]);
  });

  it('ログインの API 以外の 423 (別の意味の数値) は見ない', () => {
    expect(findLockoutCode('other.ts', 'export const width = 423;', false)).toEqual([]);
  });
});
