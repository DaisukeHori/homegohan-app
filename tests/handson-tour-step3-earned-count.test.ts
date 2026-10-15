/**
 * #1626 ハンズオンツアー Step 3 の「もう n つ獲得しています」の n と、ツアーが実際に付けるバッジを突き合わせる。
 *
 * 以前の Step 3 の intro は「もう 2 つ獲得しています」で、first_bite (Step 1) と planner (Step 2) が付いている前提だった。
 * しかし Step 1 のお試しの記録はバッジの判定に数えない (#1314) ので、実際の利用者が Step 3 に来たときに
 * 付いているのは planner だけで、first_bite は未獲得のまま「2 つ獲得」と出ていた。
 *
 * Step 3 の文言の数は、共有の定数 STEP3_BADGES_EARNED_IN_TOUR (packages/handson-tour-shared/src/constants.ts) の数と
 * 合わせてある (packages/handson-tour-shared/__tests__/i18n.test.ts が確かめる)。ここでは、その定数が
 * 「Web のツアーの Step 1 / Step 2 が呼ぶ API が実際に付けるバッジ」と一致することを、ソースを構文木で読んで確かめる。
 * Step 1 / Step 2 の API が付けるバッジを増やしたり減らしたりしたら、ここが落ちて、定数と文言の直し忘れを知らせる。
 *
 * TypeScript は構文木で走査するので、コメントや文字列の中の `awardBadge(` には反応しない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { STEP3_BADGES_EARNED_IN_TOUR, TOUR_PHOTO_SAVE_URL } from '@homegohan/handson-tour-shared';

const ROOT = path.resolve(__dirname, '..');

/** Web のツアーの Step 1 (写真の記録) の画面 */
const STEP1_PAGE = 'src/app/handson-tour/photo/page.tsx';
/** Web のツアーの Step 2 (献立) の画面 */
const STEP2_PAGE = 'src/app/handson-tour/menu/page.tsx';
/** Step 2 の画面が [献立に追加] で呼ぶ API の path */
const STEP2_SAVE_PATH = '/api/menu-plans/add';
/** お試しの保存の処理 (Step 1 / Step 2 の API が使う) が置かれた場所。ここで付与が足されても拾う */
const SANDBOX_LIB_DIR = 'src/lib/handson-tour';

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

/** "/api/menu-plans/add?source=..." → "src/app/api/menu-plans/add/route.ts" */
function routeFileOf(url: string): string {
  const pathname = url.split('?')[0];
  return `src/app${pathname}/route.ts`;
}

/** dir 配下の .ts / .tsx (テストを除く。プロジェクトルートからの相対パス) */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...sourceFiles(rel));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(rel);
    }
  }
  return files;
}

/** ファイルの中の `awardBadge(client, userId, '<code>')` のコード */
function codesAwardedIn(relPath: string): string[] {
  const source = ts.createSourceFile(
    relPath,
    read(relPath),
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const codes: string[] = [];
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'awardBadge') return;
    const code = node.arguments[2];
    // コードを文字列の直書き以外で渡すと、ここでは何を付けるか読めない。読めない形を黙って見逃さない
    if (!code || !ts.isStringLiteralLike(code)) {
      throw new Error(`${relPath}: awardBadge の 3 つ目の引数 (バッジのコード) を文字列の直書きで読めません`);
    }
    codes.push(code.text);
  });
  return codes;
}

const step1Route = routeFileOf(TOUR_PHOTO_SAVE_URL);
const step2Route = routeFileOf(STEP2_SAVE_PATH);

describe('Step 3 までにツアーが付けるバッジ (STEP3_BADGES_EARNED_IN_TOUR) は、Step 1 / Step 2 の API が実際に付けるものと同じ (#1626)', () => {
  it('Step 1 / Step 2 の画面は、ここで調べる API を呼んでいる (探し方が空振りしていない)', () => {
    expect(read(STEP1_PAGE)).toContain('fetch(TOUR_PHOTO_SAVE_URL');
    expect(read(STEP2_PAGE)).toContain(`fetch('${STEP2_SAVE_PATH}?`);
    expect(fs.existsSync(path.join(ROOT, step1Route)), step1Route).toBe(true);
    expect(fs.existsSync(path.join(ROOT, step2Route)), step2Route).toBe(true);
  });

  it('Step 1 のお試しの記録の API (とお試しの保存の処理) は、バッジを付けない (first_bite は Step 3 の時点で未獲得。#1314)', () => {
    const awarded = [step1Route, ...sourceFiles(SANDBOX_LIB_DIR)].flatMap((file) =>
      codesAwardedIn(file).map((code) => `${file}: ${code}`),
    );
    expect(awarded).toEqual([]);
  });

  it('Step 1 / Step 2 の API が付けるバッジの集合が、STEP3_BADGES_EARNED_IN_TOUR と一致する', () => {
    const awarded = [...new Set([step1Route, step2Route].flatMap(codesAwardedIn))].sort();
    expect(awarded).toEqual([...STEP3_BADGES_EARNED_IN_TOUR].sort());
  });

  it('first_bite は STEP3_BADGES_EARNED_IN_TOUR に入っていない', () => {
    expect(STEP3_BADGES_EARNED_IN_TOUR as readonly string[]).not.toContain('first_bite');
  });
});
