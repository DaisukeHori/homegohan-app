/**
 * #1598 Push 通知の設計書 (docs/design/mobile/*push*.md) が通知の行き先 (data.path) に書くパスは、アプリが同じパスとして開く
 *
 * #1598 の続きで、通常の操作で届かないネイティブの画面 (週の献立の `apps/mobile/app/menus/weekly/index.tsx` など) を消し、
 * 通知の行き先の一覧 (apps/mobile/src/lib/notificationRoute.ts の NOTIFICATION_ROUTES) からも外した。並行して書かれた
 * サーバーからの送信の設計書 (mobile/06-push-send.md。#1136) は、献立の通知の行き先を '/menus/weekly' のままにし、
 * 契約 (§10 の (b)「PUSH_NOTIFICATION_KIND_SPECS[kind].path が resolveNotificationHref({ path }) で同じ値に解決される」) を
 * 求めていた。アプリはこのパスを一番近い上位の '/menus' に落とすので、設計書のとおりに作ると契約のテストが赤になる。
 * 設計書の段階で、ここで落とす。
 *   1. 設計書の通知の行き先 (`path: '/…'`・`data.path = '/…'`・`path: <定数>` に使う `const <定数> = '/…'`) は、
 *      resolveNotificationHref({ path }) で同じパスに解決される (= NOTIFICATION_ROUTES に載っている画面)
 *   2. 走査が空振りしていない (06-push-send.md の 3 つの書き方を、それぞれ 1 件以上見つける)
 * この検査の限界: 表の列 (`| \`/menus\` |`) や文の中だけに書いたパスは見ない (書き方が決まっていないので)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveNotificationHref } from '../apps/mobile/src/lib/notificationRoute';

const ROOT = path.resolve(__dirname, '..');
/** Push 通知の設計書を置くディレクトリ (リポジトリの根からの相対) */
const MOBILE_DESIGN_DIR = 'docs/design/mobile';
/** Push 通知の設計書のファイル名の目印 */
const PUSH_DOC_NAME = /push/;
/** サーバーからの送信の設計書 (通知の種類ごとの行き先を決める正典) */
const PUSH_SEND_DOC = `${MOBILE_DESIGN_DIR}/06-push-send.md`;

/** 通知の行き先の書き方。どれも 1 番目の組がパス */
const PATH_FIELD_LITERAL = /\bpath: '(\/[^']*)'/g;
const DATA_PATH_ASSIGNMENT = /\bdata\.path = '(\/[^']*)'/g;
/** `path: <定数>` の定数の名前 */
const PATH_FIELD_CONSTANT = /\bpath: ([A-Z][A-Z0-9_]*)\b/g;

type PathDeclaration = { file: string; kind: 'path-field' | 'data-path' | 'constant'; value: string };

/** 1 つの設計書の中の、通知の行き先の宣言 */
function pathDeclarationsIn(file: string, text: string): PathDeclaration[] {
  const out: PathDeclaration[] = [];
  for (const match of text.matchAll(PATH_FIELD_LITERAL)) out.push({ file, kind: 'path-field', value: match[1] });
  for (const match of text.matchAll(DATA_PATH_ASSIGNMENT)) out.push({ file, kind: 'data-path', value: match[1] });
  const constants = new Set([...text.matchAll(PATH_FIELD_CONSTANT)].map((match) => match[1]));
  for (const name of constants) {
    for (const match of text.matchAll(new RegExp(`\\bconst ${name} = '(\\/[^']*)'`, 'g'))) {
      out.push({ file, kind: 'constant', value: match[1] });
    }
  }
  return out;
}

/** 通知の行き先として、アプリが同じパスを開かない (落とす・開かない) もの */
function unresolvedPaths(declarations: readonly PathDeclaration[]): string[] {
  return declarations
    .filter((declaration) => resolveNotificationHref({ path: declaration.value }) !== declaration.value)
    .map((declaration) => `${declaration.file} (${declaration.kind}): ${declaration.value}`);
}

const pushDocs = fs
  .readdirSync(path.join(ROOT, MOBILE_DESIGN_DIR))
  .filter((name) => name.endsWith('.md') && PUSH_DOC_NAME.test(name))
  .map((name) => `${MOBILE_DESIGN_DIR}/${name}`);

/** 設計書の中の通知の行き先 (収集のときに 1 回だけ集める) */
const declarations = pushDocs.flatMap((file) => pathDeclarationsIn(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));

describe('#1598 Push 通知の設計書が書く通知の行き先は、アプリが同じパスとして開く', () => {
  it('書き方: path の文字列・data.path の代入・path に使う定数を拾い、使わない定数は拾わない', () => {
    const text = [
      "`data` (アプリに届く): `{ kind, path: '/menus', request_id }`",
      "`NotificationRouter` が `data.path = '/home'` を解決",
      "const MENUS_TAB_PATH = '/menus';",
      "const UNUSED_PATH = '/api/push/cron';",
      '    path: MENUS_TAB_PATH,',
    ].join('\n');
    expect(pathDeclarationsIn('x.md', text).map((declaration) => `${declaration.kind}:${declaration.value}`)).toEqual([
      'path-field:/menus',
      'data-path:/home',
      'constant:/menus',
    ]);
  });

  it('消した画面への行き先 (以前の 06-push-send.md の /menus/weekly) を捕まえる', () => {
    const before = pathDeclarationsIn('before.md', "const MENU_WEEKLY_PATH = '/menus/weekly';\n    path: MENU_WEEKLY_PATH,");
    expect(unresolvedPaths(before)).toEqual(['before.md (constant): /menus/weekly']);
  });

  it('走査が空振りしていない (06-push-send.md の 3 つの書き方を、それぞれ 1 件以上見つける)', () => {
    expect(pushDocs).toContain(PUSH_SEND_DOC);
    const kinds = new Set(declarations.filter((declaration) => declaration.file === PUSH_SEND_DOC).map((d) => d.kind));
    expect([...kinds].sort()).toEqual(['constant', 'data-path', 'path-field']);
  });

  it('設計書の通知の行き先は、resolveNotificationHref で同じパスに解決される (NOTIFICATION_ROUTES に載っている)', () => {
    expect(unresolvedPaths(declarations)).toEqual([]);
  });
});
