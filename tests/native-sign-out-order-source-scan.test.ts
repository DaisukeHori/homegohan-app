/**
 * #1038 F7-10 ログアウトの順番のソース走査 contract テスト
 *
 * モバイルアプリの WebView の中で、利用者が Web でログアウトしたとき、ネイティブは push token の行を
 * user_push_tokens から消す。ネイティブに届くメッセージの順番が違うと、消せなくなる。
 *
 *   悪い順番: signOut() の途中で auth-js が SIGNED_OUT を出す
 *             -> MainLayout がそれを session-expired としてネイティブへ先に送る
 *             -> ネイティブは自分のセッションをサーバーで確かめ (Web の signOut は全端末を失効させるので失効と返る)、
 *                失効を見つけた getUser() が端末のセッションを消す
 *             -> そのあとに届く sign-out で、ユーザー ID や本人の JWT が分からなくなる
 *   良い順番: 画面が signOut() の「前」に notifyNativeSignOut() を呼ぶ。ネイティブには sign-out だけが届く。
 *            (ネイティブ側も、悪い順番で届いても消せるようにしてあるが、余計な通信と取りこぼしの余地を残さない)
 *
 * broadcastSignOut() は signOut() の「あと」に呼ぶ。先に呼ぶと、同じタブの BroadcastChannel で MainLayout が
 * /login へ移ってしまい、signOut() が途中で止まる。
 *
 * そこで src/ の全ファイルをソースとして読み (TypeScript の構文木で解析するので、コメントや文字列の中は見ない)、
 * broadcastSignOut() を呼ぶ箇所が、必ず次の並びになっていることを確かめる。
 *
 *     notifyNativeSignOut() -> <supabase>.auth.signOut(...) -> broadcastSignOut()
 *
 * 新しいログアウトの画面を足すときは、同じ並びにする。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

type Token = 'notifyNativeSignOut' | 'signOut' | 'broadcastSignOut';

interface Call {
  token: Token;
  /** ソース内の位置 (出てくる順に並べるため) */
  pos: number;
  line: number;
}

/** ファイル内の notifyNativeSignOut() / x.signOut() / broadcastSignOut() の呼び出しを、ソースの出てくる順に集める */
function collectCalls(source: string, fileName: string): Call[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: Call[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let token: Token | null = null;
      if (ts.isIdentifier(callee) && (callee.text === 'notifyNativeSignOut' || callee.text === 'broadcastSignOut')) {
        token = callee.text;
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'signOut') {
        token = 'signOut';
      }
      if (token) {
        const pos = node.getStart(sf);
        calls.push({ token, pos, line: sf.getLineAndCharacterOfPosition(pos).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // 構文木は深さ優先で辿るので、入れ子の呼び出しの順が前後することがある。ソースに出てくる順に並べ直す
  return calls.sort((a, b) => a.pos - b.pos);
}

/** broadcastSignOut() の呼び出しごとに、守られていない並びを説明する文を返す (守られていれば空) */
function findOrderViolations(source: string, fileName = 'file.tsx'): string[] {
  const calls = collectCalls(source, fileName);
  const violations: string[] = [];
  calls.forEach((call, index) => {
    if (call.token !== 'broadcastSignOut') return;
    const previous = calls[index - 1];
    const beforePrevious = calls[index - 2];
    if (!previous || previous.token !== 'signOut') {
      violations.push(
        `${fileName}:${call.line} broadcastSignOut() の直前は signOut() の呼び出しにすること` +
          ` (先に呼ぶと、同じタブの BroadcastChannel で /login へ移り、signOut() が途中で止まる)`,
      );
      return;
    }
    if (!beforePrevious || beforePrevious.token !== 'notifyNativeSignOut') {
      violations.push(
        `${fileName}:${previous.line} signOut() の前に notifyNativeSignOut() を呼ぶこと` +
          ` (signOut() の途中の SIGNED_OUT が session-expired としてネイティブへ先に届き、push token を消せなくなる)`,
      );
    }
  });
  return violations;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('ログアウトの画面は、signOut の前にネイティブへ知らせる (#1038 F7-10)', () => {
  const files = collectSourceFiles(path.join(ROOT, 'src'));
  const sourceByFile = new Map(files.map((file) => [path.relative(ROOT, file), fs.readFileSync(file, 'utf8')]));

  it('src/ の broadcastSignOut() を呼ぶ箇所は、すべて notifyNativeSignOut() -> signOut() -> broadcastSignOut() の並びになっている', () => {
    const violations: string[] = [];
    for (const [file, source] of sourceByFile) {
      // 走査のコストを抑える: 名前が出てこないファイルは構文木にしない
      if (!source.includes('broadcastSignOut')) continue;
      violations.push(...findOrderViolations(source, file));
    }
    expect(violations).toEqual([]);
  });

  it('走査が空振りしていない: 既知のログアウトの箇所 (設定 2・マイページ 2・組織・凍結・パスワード再設定・家族の昇格) を見つけている', () => {
    let broadcastCalls = 0;
    const filesWithBroadcast: string[] = [];
    for (const [file, source] of sourceByFile) {
      if (!source.includes('broadcastSignOut')) continue;
      const count = collectCalls(source, file).filter((call) => call.token === 'broadcastSignOut').length;
      if (count > 0) {
        broadcastCalls += count;
        filesWithBroadcast.push(file);
      }
    }
    expect(broadcastCalls).toBeGreaterThanOrEqual(8);
    expect(filesWithBroadcast).toEqual(
      expect.arrayContaining([
        path.join('src', 'app', '(main)', 'settings', 'page.tsx'),
        path.join('src', 'app', '(main)', 'profile', 'page.tsx'),
        path.join('src', 'app', '(org)', 'layout.tsx'),
        path.join('src', 'app', 'frozen', 'page.tsx'),
        path.join('src', 'app', '(auth)', 'auth', 'reset-password', 'page.tsx'),
        path.join('src', 'app', 'family', 'promotions', '[token]', 'page.tsx'),
      ]),
    );
  });
});

describe('findOrderViolations (走査そのものの確認)', () => {
  it('良い並び (notify -> signOut -> broadcast) は違反にしない', () => {
    const source = `
      async function logout() {
        clearUserScopedLocalStorage();
        notifyNativeSignOut();
        await supabase.auth.signOut();
        broadcastSignOut();
      }
    `;
    expect(findOrderViolations(source)).toEqual([]);
  });

  it('signOut の前に notifyNativeSignOut() が無い並びを見つける', () => {
    const source = `
      async function logout() {
        clearUserScopedLocalStorage();
        await supabase.auth.signOut();
        broadcastSignOut();
      }
    `;
    const violations = findOrderViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('notifyNativeSignOut()');
  });

  it('broadcastSignOut() を signOut の前に呼ぶ並びを見つける (同じタブが /login へ移り、signOut が止まる)', () => {
    const source = `
      async function logout() {
        notifyNativeSignOut();
        broadcastSignOut();
        await supabase.auth.signOut();
      }
    `;
    const violations = findOrderViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('直前は signOut()');
  });

  it('同じファイルに複数のログアウトがあっても、それぞれを検査する (1 つだけ書き忘れたものを見つける)', () => {
    const source = `
      async function a() { notifyNativeSignOut(); await supabase.auth.signOut(); broadcastSignOut(); }
      async function b() { await supabase.auth.signOut(); broadcastSignOut(); }
    `;
    expect(findOrderViolations(source)).toHaveLength(1);
  });

  it('コメントや文字列の中の名前は見ない', () => {
    const source = `
      // await supabase.auth.signOut(); broadcastSignOut();
      const text = "broadcastSignOut()";
    `;
    expect(findOrderViolations(source)).toEqual([]);
  });

  it('broadcastSignOut() を呼ばない signOut (他の端末だけのサインアウトなど) は対象にしない', () => {
    const source = `
      async function others() { await supabase.auth.signOut({ scope: 'others' }); }
    `;
    expect(findOrderViolations(source)).toEqual([]);
  });
});
