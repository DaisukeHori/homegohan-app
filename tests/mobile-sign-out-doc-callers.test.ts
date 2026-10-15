/**
 * #1659 (#1636・#1598) モバイルの設計書が「端末からのログアウトを呼ぶ画面」として書く画面と、実際に signOutOnDevice を呼ぶ画面の突き合わせ
 *
 * #1673 (#1598) でネイティブのマイページ (apps/mobile/app/profile/index.tsx) を消し、端末からのログアウト (signOutOnDevice) を呼ぶ画面は
 * 設定画面 (apps/mobile/app/(tabs)/settings.tsx) だけになった (apps/mobile/src/providers/AuthProvider.tsx の先頭の表も「設定のログアウト」)。
 * 設計書 (mobile/05-auth-session.md・mobile/01-architecture.md) が「設定タブ・マイページのログアウト (signOutOnDevice)」と書き続けると、
 * いまのマイページ (WebView のタブ。Web の /profile は WebView の中ではログアウトを出さない) にもログアウトがあると読めてしまう。ここで落とす。
 *   1. apps/mobile/app の中で signOutOnDevice を呼ぶ画面のファイル (構文木で呼び出しを探す。コメントは見ない) は、CALLER_SCREENS のファイルだけ
 *   2. docs/design/mobile/ の、端末からのログアウトを書いた行 (NATIVE_SIGN_OUT_LINE) は、NON_CALLER_SCREEN_NAMES の画面の名前を書かない
 *   3. 同じ行のどれかが、CALLER_SCREENS の画面の名前を書く
 *   4. 走査が空振りしていない (端末からのログアウトを書いた行を見つける)
 * Web の設定・マイページのログアウト (src/ の画面。notifyNativeSignOut など) を書いた行は、端末からのログアウトの行ではないので見ない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** モバイルの画面のディレクトリ (Expo Router の app/) */
const MOBILE_APP_DIR = 'apps/mobile/app';
/** 走査する設計書のディレクトリ */
const MOBILE_DESIGN_DIR = 'docs/design/mobile';
/** 端末からのログアウト (apps/mobile/src/lib/signOut.ts) */
const SIGN_OUT_ON_DEVICE = 'signOutOnDevice';

/** signOutOnDevice を呼ぶ画面: 設計書での名前と、画面のファイル (リポジトリの根からの相対) */
const CALLER_SCREENS = [{ name: '設定画面', file: `${MOBILE_APP_DIR}/(tabs)/settings.tsx` }] as const;

/**
 * signOutOnDevice を呼ばない画面の名前。マイページは WebView のタブ ((tabs)/profile.tsx) で、ログアウトを出さない。
 * #1673 で消したネイティブのマイページ (profile/index.tsx) が呼んでいた
 */
const NON_CALLER_SCREEN_NAMES = ['マイページ'] as const;

/** 設計書の、端末からのログアウトを書いた行の目印 */
const NATIVE_SIGN_OUT_LINE = new RegExp(`\`${SIGN_OUT_ON_DEVICE}|端末からのサインアウト`);

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listSources(rel));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

/** ソースの中に、signOutOnDevice(...) の呼び出しがあるか (構文木で見る。コメントと文字列は数えない) */
function callsSignOutOnDeviceIn(file: string, text: string): boolean {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === SIGN_OUT_ON_DEVICE) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const callsSignOutOnDevice = (file: string): boolean =>
  callsSignOutOnDeviceIn(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));

type DocLine = { file: string; line: number; text: string };

/** docs/design/mobile/ の、端末からのログアウトを書いた行 */
function nativeSignOutLines(): DocLine[] {
  const out: DocLine[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, MOBILE_DESIGN_DIR))) {
    if (!entry.endsWith('.md')) continue;
    const file = `${MOBILE_DESIGN_DIR}/${entry}`;
    fs.readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((text, index) => {
        if (NATIVE_SIGN_OUT_LINE.test(text)) out.push({ file, line: index + 1, text });
      });
  }
  return out;
}

describe('#1659 モバイルの設計書が書く「端末からのログアウトを呼ぶ画面」は、実際に signOutOnDevice を呼ぶ画面と一致する', () => {
  it('apps/mobile/app の中で signOutOnDevice を呼ぶ画面は、CALLER_SCREENS の画面だけ', () => {
    const callers = listSources(MOBILE_APP_DIR).filter(callsSignOutOnDevice).sort();
    expect(callers).toEqual(CALLER_SCREENS.map((screen) => screen.file).sort());
  });

  it('呼び出しの見つけ方: 呼び出しは数え、コメントと文字列の中の名前は数えない', () => {
    expect(callsSignOutOnDeviceIn('call.tsx', 'await signOutOnDevice(user?.id ?? null, { clearSession });')).toBe(true);
    expect(
      callsSignOutOnDeviceIn('comment.tsx', "// signOutOnDevice(user.id) は例外を投げない\nconst label = 'signOutOnDevice(';"),
    ).toBe(false);
  });

  it('走査が空振りしていない (docs/design/mobile/ の、端末からのログアウトを書いた行を見つける)', () => {
    expect(nativeSignOutLines().length).toBeGreaterThan(0);
  });

  it('端末からのログアウトを書いた行は、signOutOnDevice を呼ばない画面の名前 (マイページ) を書かない', () => {
    const stale = nativeSignOutLines()
      .filter((docLine) => NON_CALLER_SCREEN_NAMES.some((name) => docLine.text.includes(name)))
      .map((docLine) => `${docLine.file}:${docLine.line}`);
    expect(stale).toEqual([]);
  });

  it('端末からのログアウトを書いた行のどれかが、signOutOnDevice を呼ぶ画面の名前を書く', () => {
    const lines = nativeSignOutLines();
    const missing = CALLER_SCREENS.filter((screen) => !lines.some((docLine) => docLine.text.includes(screen.name))).map(
      (screen) => screen.name,
    );
    expect(missing).toEqual([]);
  });
});
