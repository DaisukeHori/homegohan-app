/**
 * #1812 開示・訂正・利用停止・消去の請求 (DSR) の画面への入口: Web とアプリ (apps/mobile) の値の突き合わせ
 * (設計 docs/design/cross/15-data-subject-requests.md §9・§19)
 *
 * 請求の画面は Web (src/app/(main)/settings/data-requests/page.tsx) にだけあり、アプリはアカウントの画面
 * (apps/mobile/app/settings/account.tsx) の項目から、同じ画面を WebView (apps/mobile/app/settings/data-requests.tsx) で開く。
 * パスと見出し・説明の文は @homegohan/shared (packages/shared/src/data-subject-requests.ts) の 1 か所に置き、
 * Web の正典 (src/lib/data-subject-requests/core.ts)・同意ゲートの除外 (lib/onboarding-routing.ts)・アプリ
 * (apps/mobile/src/lib/data-subject-requests.ts) がそれを読む。ここでは、
 *   1. Web の core.ts の値と onboarding-routing の除外のパスが、共用の値と同じ
 *   2. 共用のパスに当たる Web の画面のファイルがある
 *   3. 共用のパスは、アプリのどのタブの受け持ち (NATIVE_APP_TABS) にも入らない (入ると WebView の中の遷移がタブの切り替えに置き換わり、請求の画面に留まれない)
 *   4. アプリの側が、共用の値を読み (文字列を直書きしない)、アカウントの画面が請求の画面の経路へ移り、請求の画面が共用のパスを WebView に渡す
 *      (アプリの押したときの動きは apps/mobile/__tests__/settings/data-requests-entry.test.tsx が確かめる)
 * を確かめる。アプリのソースは構文木で読む (コメントの中の文は数えない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  DSR_SETTINGS_ENTRY_DESCRIPTION as SHARED_DESCRIPTION,
  DSR_SETTINGS_ENTRY_TITLE as SHARED_TITLE,
  DSR_SETTINGS_PATH as SHARED_PATH,
  NATIVE_APP_TABS,
  findNativeAppTab,
} from '@homegohan/shared';
import {
  DSR_SETTINGS_ENTRY_DESCRIPTION,
  DSR_SETTINGS_ENTRY_TITLE,
  DSR_SETTINGS_PATH,
  DSR_VERIFY_PATH,
} from '@/lib/data-subject-requests/core';
import { DATA_SUBJECT_REQUESTS_PATH } from '../lib/onboarding-routing';

const ROOT = path.resolve(__dirname, '..');
/** Web の画面 (App Router) の置き場。(main) はパスに出ないグループ */
const WEB_APP_DIR = 'src/app/(main)';
/** アプリの共用の値の窓口・アカウントの画面・請求の画面 (リポジトリの根からの相対) */
const MOBILE_DSR_LIB = 'apps/mobile/src/lib/data-subject-requests.ts';
const MOBILE_ACCOUNT_SCREEN = 'apps/mobile/app/settings/account.tsx';
const MOBILE_DSR_SCREEN = 'apps/mobile/app/settings/data-requests.tsx';
/** 共用の値の import 元 */
const SHARED_MODULE = '@homegohan/shared';

function parse(file: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** import 元ごとの、名前で import した名前の一覧 */
function namedImports(sf: ts.SourceFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const names = bindings.elements.map((e) => (e.propertyName ?? e.name).text);
    out.set(stmt.moduleSpecifier.text, [...(out.get(stmt.moduleSpecifier.text) ?? []), ...names]);
  }
  return out;
}

/** ソースの中の文字列リテラル (テンプレートの固定部分を含む) の値 */
function stringLiterals(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** callee のテキストが calleeText の呼び出しの、第 1 引数の式のテキスト */
function firstArgsOfCalls(sf: ts.SourceFile, calleeText: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === calleeText && node.arguments[0]) {
      out.push(node.arguments[0].getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** JSX の要素 tagName の属性 attr の式のテキスト (式でない属性は文字列のまま) */
function jsxAttributeTexts(sf: ts.SourceFile, tagName: string, attr: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(sf) === tagName) {
      for (const prop of node.attributes.properties) {
        if (!ts.isJsxAttribute(prop) || prop.name.getText(sf) !== attr || !prop.initializer) continue;
        const init = prop.initializer;
        out.push(ts.isJsxExpression(init) && init.expression ? init.expression.getText(sf) : init.getText(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('#1812 請求の画面への入口: Web と共用の値', () => {
  it('Web の core.ts の値は共用の値そのもの (同じパス・見出し・説明の文)', () => {
    expect(DSR_SETTINGS_PATH).toBe(SHARED_PATH);
    expect(DSR_SETTINGS_ENTRY_TITLE).toBe(SHARED_TITLE);
    expect(DSR_SETTINGS_ENTRY_DESCRIPTION).toBe(SHARED_DESCRIPTION);
    expect(SHARED_PATH).toBe('/settings/data-requests');
    expect(SHARED_TITLE).toBe('開示・訂正・利用停止の請求');
    expect(SHARED_DESCRIPTION).toBe('個人情報の開示・訂正・利用停止・消去を請求する');
  });

  it('同意ゲートと初期設定の差し戻しから外すパスは共用のパスで、本人確認のパスはその下', () => {
    expect(DATA_SUBJECT_REQUESTS_PATH).toBe(SHARED_PATH);
    expect(DSR_VERIFY_PATH.startsWith(`${SHARED_PATH}/`)).toBe(true);
  });

  it('共用のパスに当たる Web の画面のファイルがある', () => {
    expect(fs.existsSync(path.join(ROOT, WEB_APP_DIR, SHARED_PATH, 'page.tsx'))).toBe(true);
  });

  it('共用のパスは、アプリのどのタブの受け持ちにも入らない (WebView の中で請求の画面に留まる)', () => {
    expect(NATIVE_APP_TABS.length).toBeGreaterThan(0);
    expect(findNativeAppTab(SHARED_PATH)).toBeNull();
    expect(findNativeAppTab(DSR_VERIFY_PATH)).toBeNull();
  });
});

describe('#1812 請求の画面への入口: アプリの側が共用の値を読む', () => {
  it('アプリの窓口 (src/lib/data-subject-requests.ts) は共用の値を @homegohan/shared から読み、パス・文を直書きしない', () => {
    const sf = parse(MOBILE_DSR_LIB);
    expect(namedImports(sf).get(SHARED_MODULE)).toEqual(
      expect.arrayContaining(['DSR_SETTINGS_PATH', 'DSR_SETTINGS_ENTRY_TITLE', 'DSR_SETTINGS_ENTRY_DESCRIPTION']),
    );
    const literals = stringLiterals(sf);
    expect(literals).not.toContain(SHARED_PATH);
    expect(literals).not.toContain(SHARED_TITLE);
    expect(literals).not.toContain(SHARED_DESCRIPTION);
  });

  it('アカウントの画面は窓口から読んだ見出し・説明を出し、押すと請求の画面の経路 (DSR_SCREEN_ROUTE) へ移る', () => {
    const sf = parse(MOBILE_ACCOUNT_SCREEN);
    expect(namedImports(sf).get('../../src/lib/data-subject-requests')).toEqual(
      expect.arrayContaining(['DSR_SCREEN_ROUTE', 'DSR_SETTINGS_ENTRY_TITLE', 'DSR_SETTINGS_ENTRY_DESCRIPTION']),
    );
    expect(firstArgsOfCalls(sf, 'router.push')).toContain('DSR_SCREEN_ROUTE');
    const literals = stringLiterals(sf);
    expect(literals).not.toContain(SHARED_PATH);
    expect(literals).not.toContain(SHARED_TITLE);
    expect(literals).not.toContain(SHARED_DESCRIPTION);
  });

  it('請求の画面は WebViewScreen に共用のパス (DSR_SETTINGS_PATH) を渡し、その画面のファイルは経路と同じパスにある', () => {
    const sf = parse(MOBILE_DSR_SCREEN);
    expect(namedImports(sf).get('../../src/lib/data-subject-requests')).toContain('DSR_SETTINGS_PATH');
    expect(jsxAttributeTexts(sf, 'WebViewScreen', 'path')).toEqual(['DSR_SETTINGS_PATH']);
    // Expo Router の経路は app/ からのファイルのパス (拡張子を除く)。経路 DSR_SCREEN_ROUTE = DSR_SETTINGS_PATH と同じ場所にある
    expect(MOBILE_DSR_SCREEN).toBe(`apps/mobile/app${SHARED_PATH}.tsx`);
  });
});
