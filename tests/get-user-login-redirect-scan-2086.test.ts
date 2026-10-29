/**
 * #2086 V3 の見張り: getUser の error を見ずに /login へ移す分岐を数える。
 *
 * supabase.auth.getUser() は通信の失敗を投げずに { data: { user: null }, error } で返す。
 * `const { data: { user } } = await supabase.auth.getUser(); if (!user) router.push('/login')` の形は、
 * オフラインのときもログインの画面へ移してしまう (承諾・譲渡の画面で、承諾の通信が切れたあとの読み直しが働かなかった)。
 * 見分けは src/lib/auth/signed-in-user.ts の readSignedInUser (通信の失敗は load-failed・セッションが無いときだけ signed-out) で行う。
 *
 * 走査はソースの構文木 (TypeScript) で行う。コメント・文字列の中は見ない。
 * 数える形: `X.auth.getUser()` の結果を分割代入し、`error` を取り出していない宣言のうち、
 * それを囲む関数の中に '/login' で始まる文字列 (または template) があるもの。
 * 限界 (見張りであって証明ではない): 結果を変数で受けてから user だけを読む書き方・別の関数に包んで /login へ移す書き方・
 * window.location を使う書き方のうち '/login' を変数で渡すものは数えない。
 *
 * 表 (KNOWN_REMAINING) は、この Issue の範囲の外で残っている箇所。範囲の画面 (FIXED_SCREENS) は 0 件でなければならない。
 * 新しく増えたら赤になるので、readSignedInUser で直すか、表に理由つきで足す。直して減ったら表から消す。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src/app', 'src/components'];
const LOGIN_PATH_PREFIX = '/login';
/** readSignedInUser の import (引用符はファイルごとに ' と " のどちらもある) */
const SIGNED_IN_USER_IMPORT = /from ['"]@\/lib\/auth\/signed-in-user['"]/;

/** #2086 V3 で直した画面 (getUser の error を見ずに /login へ移す分岐が 0 件で、readSignedInUser を使う) */
const FIXED_SCREENS = [
  'src/app/(main)/org/transfer-accept/[proposal_id]/page.tsx',
  'src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx',
  'src/app/(org)/org/settings/owner-transfer/page.tsx',
  'src/app/(org)/layout.tsx',
  'src/app/(main)/family/members/[id]/page.tsx',
  'src/app/(main)/family/members/[id]/promote/page.tsx',
  'src/app/family/promotions/[token]/page.tsx',
] as const;

/**
 * この Issue の範囲の外で残っている箇所 (ファイル → 件数)。理由はファイルごとに書く。
 * 範囲 (#2086 の仕分けが名指しした承諾・譲渡の画面と、同じ画面の続きの画面) の外なので、別の Issue で扱う。
 */
const KNOWN_REMAINING: Readonly<Record<string, { count: number; reason: string }>> = {
  'src/app/(main)/family/dashboard/page.tsx': { count: 1, reason: '家族のダッシュボード。#2086 の範囲の外 (承諾・譲渡の画面ではない)' },
  'src/app/(main)/family/members/page.tsx': { count: 1, reason: '家族のメンバーの一覧。#2086 の範囲の外' },
  'src/app/(main)/family/members/invite/page.tsx': { count: 1, reason: '家族の招待の画面。#2086 の範囲の外' },
  'src/app/(main)/family/members/child/new/page.tsx': { count: 1, reason: '子供の追加の画面。#2086 の範囲の外' },
  'src/app/(main)/family/representative-transfer/page.tsx': {
    count: 1,
    reason: '家族の代表者の譲渡の提案 (送る側) の画面。#2086 の仕分けの根拠に挙がっていない (承諾の画面ではない)',
  },
  'src/app/(main)/settings/membership/page.tsx': { count: 1, reason: '所属の設定の画面。#2086 の範囲の外' },
  'src/app/(support)/layout.tsx': { count: 1, reason: 'サポートの画面の枠。#2086 の範囲の外' },
  'src/app/legal-consent/page.tsx': { count: 1, reason: 'サーバーで動く画面 (Server Component)。端末のオフラインでは動かない' },
  'src/app/legal-consent/account/page.tsx': { count: 1, reason: 'サーバーで動く画面 (Server Component)。端末のオフラインでは動かない' },
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** `X.auth.getUser()` の呼び出しか */
function isGetUserCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'getUser') return false;
  const owner = callee.expression;
  return ts.isPropertyAccessExpression(owner) && owner.name.text === 'auth';
}

/** 分割代入で `error` を取り出しているか (`{ data, error }` / `{ error: userError }` など。入れ子は見ない: error は一番外にある) */
function bindsError(pattern: ts.ObjectBindingPattern): boolean {
  return pattern.elements.some((element) => {
    const key = element.propertyName ?? element.name;
    return ts.isIdentifier(key) && key.text === 'error';
  });
}

function enclosingFunction(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

/** 関数の中に '/login' で始まる文字列 (または template の頭) があるか */
function mentionsLoginPath(scope: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.startsWith(LOGIN_PATH_PREFIX)
    ) {
      found = true;
      return;
    }
    if (ts.isTemplateExpression(node) && node.head.text.startsWith(LOGIN_PATH_PREFIX)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** ファイルの中の「getUser の error を見ずに /login へ移す」分岐の数 */
function countUncheckedLoginRedirects(file: string): number {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isAwaitExpression(node.initializer) &&
      isGetUserCall(node.initializer.expression) &&
      ts.isObjectBindingPattern(node.name) &&
      !bindsError(node.name) &&
      mentionsLoginPath(enclosingFunction(node))
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function scan(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of listSourceFiles(path.join(ROOT, scanRoot))) {
      const count = countUncheckedLoginRedirects(file);
      if (count > 0) result[path.relative(ROOT, file).split(path.sep).join('/')] = count;
    }
  }
  return result;
}

describe('#2086 V3 getUser の error を見ずに /login へ移す分岐の見張り', () => {
  const found = scan();

  it('範囲の画面には、getUser の error を見ずに /login へ移す分岐が無く、readSignedInUser で見分けている', () => {
    for (const file of FIXED_SCREENS) {
      expect(found[file] ?? 0, file).toBe(0);
      const sourceText = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(sourceText, file).toMatch(SIGNED_IN_USER_IMPORT);
      expect(sourceText, file).toContain('readSignedInUser(supabase)');
    }
  });

  it('範囲の外で残っている箇所は表と一致する (増えたら readSignedInUser で直すか、理由つきで表に足す)', () => {
    const expected: Record<string, number> = {};
    for (const [file, { count }] of Object.entries(KNOWN_REMAINING)) expected[file] = count;
    expect(found).toEqual(expected);
  });

  it('見張りが働いている: error を取り出さない分割代入と /login を数え、error を取り出す形は数えない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-2086-'));
    try {
      const bad = path.join(dir, 'bad.tsx');
      fs.writeFileSync(
        bad,
        "async function load() { const { data: { user } } = await supabase.auth.getUser(); if (!user) router.push(`/login?next=/x`); }\n",
      );
      const good = path.join(dir, 'good.tsx');
      fs.writeFileSync(
        good,
        "async function load() { const { data: { user }, error } = await supabase.auth.getUser(); if (error) return; if (!user) router.push('/login'); }\n",
      );
      const noLogin = path.join(dir, 'no-login.tsx');
      fs.writeFileSync(noLogin, "async function load() { const { data: { user } } = await supabase.auth.getUser(); return user; }\n");
      expect(countUncheckedLoginRedirects(bad)).toBe(1);
      expect(countUncheckedLoginRedirects(good)).toBe(0);
      expect(countUncheckedLoginRedirects(noLogin)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
