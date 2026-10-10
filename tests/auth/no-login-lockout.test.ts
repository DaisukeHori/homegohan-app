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
 *
 * あわせて、ロックを外したことが周りの記述に行き渡っているかも見る:
 *   - AI の送る先の一覧 (tests/helpers/ai-consent-enforced-paths.ts) のログインの route の説明に、外したメール (Resend) が残っていない
 *   - 文書 (docs・ルートの *.md・apps/mobile の *.md) に、ロックがあることを前提にした文が残っていない
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EXEMPT_ROUTES } from '../helpers/ai-consent-enforced-paths';
import { resolveImport, stripComments as stripCommentsForReach } from '../helpers/ai-reach';

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

// ─────────────────────────────────────────────
// AI の送る先の一覧の、ログインの route の説明
// ─────────────────────────────────────────────

/** ログインの API の route */
const LOGIN_ROUTE = 'src/app/api/auth/login/route.ts';

/** AI の一覧の定義のファイル (ログインの route の項の上のコメントも読む) */
const AI_PATHS_FILE = 'tests/helpers/ai-consent-enforced-paths.ts';

/** メールを送るコードの印 (Resend の SDK の import・API の URL・API キーの読み取り) */
const MAIL_LEAF_PATTERN = /from\s+['"]resend['"]|api\.resend\.com|process\.env\.RESEND_API_KEY/;

/** ファイルから import (相対パスと @/) をたどって届くファイルのうち、メールを送るもの */
function mailSendersReachedFrom(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file) || !fs.existsSync(file)) return [];
  seen.add(file);
  const text = stripCommentsForReach(fs.readFileSync(file, 'utf8'));
  const found = MAIL_LEAF_PATTERN.test(text) ? [path.relative(ROOT, file)] : [];
  for (const match of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved) found.push(...mailSendersReachedFrom(resolved, seen));
  }
  return found;
}

/** 一覧の定義のファイルで、指定の項 ('<route>': {) のすぐ上に続く // コメントの行 */
function commentLinesAbove(source: string, key: string): string[] {
  const lines = source.split('\n');
  const at = lines.findIndex((line) => line.trim().startsWith(`'${key}': {`));
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i].trim().startsWith('//'); i--) out.unshift(lines[i].trim());
  return out;
}

describe('AI の送る先の一覧の、ログインの route の説明が実際の送る先と合っている (ロックの通知のメールは外した)', () => {
  it('ログインの route から import をたどっても、メールを送るコードに届かない', () => {
    expect(mailSendersReachedFrom(path.join(ROOT, LOGIN_ROUTE))).toEqual([]);
  });

  it('一覧の項 (説明の文・ハンドラの説明・項の上のコメント) に、送る先としてメール (Resend) を書いていない', () => {
    const entry = EXEMPT_ROUTES[LOGIN_ROUTE];
    expect(entry, `${LOGIN_ROUTE} が ${AI_PATHS_FILE} の EXEMPT_ROUTES に無い`).toBeDefined();
    const comments = commentLinesAbove(fs.readFileSync(path.join(ROOT, AI_PATHS_FILE), 'utf8'), LOGIN_ROUTE);
    expect(comments.length, '項の上の説明のコメントが見つからない').toBeGreaterThan(0);
    const texts = [entry.consent, JSON.stringify(entry.handlers), ...comments];
    expect(texts.filter((text) => /Resend/.test(text))).toEqual([]);
  });

  it('検出力: メールを送るコードの印と、項の上のコメントの読み取り', () => {
    expect(MAIL_LEAF_PATTERN.test(`import { Resend } from 'resend';`)).toBe(true);
    expect(MAIL_LEAF_PATTERN.test(`await fetch('https://api.resend.com/emails', init);`)).toBe(true);
    expect(MAIL_LEAF_PATTERN.test('const key = process.env.RESEND_API_KEY;')).toBe(true);
    expect(MAIL_LEAF_PATTERN.test(stripCommentsForReach(`// 以前は Resend (from 'resend') で送っていた\nexport const a = 1;`))).toBe(false);
    const source = `  // 1 行目\n  // 2 行目\n  'a/route.ts': {\n    consent: 'x',\n  },`;
    expect(commentLinesAbove(source, 'a/route.ts')).toEqual(['// 1 行目', '// 2 行目']);
  });
});

// ─────────────────────────────────────────────
// 文書に、ロックを前提にした文が残っていない
// ─────────────────────────────────────────────

/** 文書を探す場所 (ディレクトリは再帰。node_modules などは除く) と、ルートの *.md */
const DOC_DIRS = ['docs', 'apps/mobile'];
const DOC_EXT = /\.md$/;

/** ロックがあることを前提にした文 (ロックの段・ロック中の扱い・ロックの解除・Redis のロックのキー・ロックの見出し) */
const LOCK_AFFIRMING_DOC_PATTERNS: readonly RegExp[] = [
  /\d+\s*分(?:アカウント)?ロック/,
  /\d+\s*時間ロック/,
  /アカウントロック(?![^\n]*しない)/,
  /ロック中は正しいパスワードでも/,
  /リセットのみ解除可能/,
  /ロック解除後にリセット/,
  /ログイン失敗(?:・アカウント)?ロック/,
  /ロック統合フロー/,
  /failed_login(?:_count)?:\{userId\}/,
  /\block:\{userId\}/,
];

/**
 * 設計書・要件書の直しは、この枝ではなく別に当てる (設計書は実装の枝で書き換えないため)。当てるまでの残りの行を、ファイルごとに全数で固定する。
 * 直しを当てたら、ここが実際と合わなくなってテストが赤になる → 当てたファイルの項をここから消す (残すと、同じ文が戻ってきても見逃すため)。
 * 項を増やすのは禁止 (新しくロックを前提にした文を書かない)。
 */
// 設計書・要件書の直し (design-doc.patch・requirements-doc.patch) はオーケストレーターが適用済み。ロックを前提にした行は残っていない
const PENDING_DOC_LINES: Readonly<Record<string, readonly string[]>> = {};

function listDocFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listDocFiles(rel));
    else if (DOC_EXT.test(entry.name)) out.push(rel);
  }
  return out;
}

/** 文書の中の、ロックを前提にした行 (前後の空白を除いた行の本文) */
function findLockAffirmingLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => LOCK_AFFIRMING_DOC_PATTERNS.some((pattern) => pattern.test(line)));
}

describe('文書に、ロックを前提にした文が残っていない', () => {
  const rootDocs = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && DOC_EXT.test(entry.name))
    .map((entry) => entry.name);
  const docFiles = [...rootDocs, ...DOC_DIRS.flatMap(listDocFiles)];

  it('走査の対象に、運用の文書・設計書・要件書が入っている', () => {
    expect(docFiles).toContain(path.join('docs/operations/auth-protection.md'));
    for (const file of Object.keys(PENDING_DOC_LINES)) expect(docFiles).toContain(path.join(file));
  });

  it('ロックを前提にした行は、直しを当てる前の設計書・要件書の残り (PENDING_DOC_LINES) だけで、それと全数で一致する', () => {
    const found: Record<string, string[]> = {};
    for (const file of docFiles) {
      const lines = findLockAffirmingLines(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      if (lines.length > 0) found[file.split(path.sep).join('/')] = lines;
    }
    expect(found).toEqual(PENDING_DOC_LINES);
  });

  it('検出力: ロックの段・ロック中の扱いを見つけ、「ロックしない」の文は見つけない', () => {
    expect(findLockAffirmingLines('| 5 回 | 15 分アカウントロック |\nロック中は正しいパスワードでも拒否。')).toEqual([
      '| 5 回 | 15 分アカウントロック |',
      'ロック中は正しいパスワードでも拒否。',
    ]);
    expect(findLockAffirmingLines('- 5 回連続失敗 → 15分ロック')).toEqual(['- 5 回連続失敗 → 15分ロック']);
    expect(
      findLockAffirmingLines(
        [
          '| アカウントのロックアウト | しない (オーナーの選択 2026-10-10) |',
          '## 8. ログイン失敗時の扱い (アカウントはロックしない)',
          '| 3 回以上 | Turnstile のトークンを確かめる。何回失敗してもロックはしない |',
          '> 更新: ログイン失敗のロック (5 回で 15 分など) をやめた',
          '| `AUTH_ACCOUNT_LOCKED` | **使わない (#1165)**: アカウントロックはしない | - |',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
