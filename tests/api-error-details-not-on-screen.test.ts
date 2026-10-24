// @vitest-environment node
/**
 * 400 の本文の details (Zod の検証の結果 `.flatten()`) を、画面が読まないことの見張り (#1917 の続き)
 *
 * 決まり (docs/design/cross/04-api-conventions.md §5.2):
 *   入力の検証の 400 は、本文の details に Zod の検証の結果 (`parsed.error.flatten()` の formErrors / fieldErrors。
 *   billing の BILL_INVALID_INPUT・運営の OP_INVALID_INPUT は issues) を入れてよい。中の文は Zod の既定の英語の文
 *   ('Required'・'Invalid input' など) のことがあり、API を呼ぶ人 (開発者・テスト) が直す場所を探すための機械向けの値である。
 *   利用者に見せる文は本文の error / error.message の日本語の固定の文だけにする。本文に入れてはいけない details は、
 *   DB (PostgREST) のエラーの details・hint と、捕まえた例外の文面 (tests/api-raw-error-message-scan.test.ts が見張る)。
 *
 * このテストが確かめること (ソースの文字列で見る。コメントの行は見ない):
 *   画面 (Web の src/app の API 以外・src/components・src/hooks、モバイルの apps/mobile/app・src/components・src/hooks) が、
 *   Zod の details の fieldErrors / formErrors を読まない。読む画面を足すなら、先に details の文を日本語にする
 *   (Zod のスキーマに日本語の message を書く) こと。
 * 限界: 名前を変えて読む書き方 (分割代入の別名など) は見ない。見張りであって網羅の証明ではない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, walkFiles } from './helpers/api-error-text-scan';

/** 画面のソースの配下 */
const SCREEN_DIRS = [
  'src/app',
  'src/components',
  'src/hooks',
  'apps/mobile/app',
  'apps/mobile/src/components',
  'apps/mobile/src/hooks',
] as const;
/** 画面から外す配下 (API の route) */
const API_DIR = 'src/app/api/';
/** Zod の details の中身を読む書き方 */
const ZOD_DETAILS_READ_PATTERN = /\b(?:fieldErrors|formErrors)\b/;
const COMMENT_LINE_PATTERN = /^\s*(?:\/\/|\*|\/\*|\{\s*\/\*)/;

function violationsIn(source: string, file: string): string[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      !COMMENT_LINE_PATTERN.test(line) && ZOD_DETAILS_READ_PATTERN.test(line) ? [`${file}:${index + 1} ${line.trim()}`] : [],
    );
}

describe('画面は 400 の本文の details (Zod の検証の結果) を読まない', () => {
  it('判定: fieldErrors・formErrors を読む行を拾い、コメントは拾わない', () => {
    expect(violationsIn('  const errors = json.details?.fieldErrors?.name ?? [];', 'x.tsx')).toHaveLength(1);
    expect(violationsIn('  setError(body.error.details.formErrors.join(","));', 'x.tsx')).toHaveLength(1);
    expect(violationsIn('  // details.fieldErrors は読まない', 'x.tsx')).toEqual([]);
    expect(violationsIn('  setError(body.error.message);', 'x.tsx')).toEqual([]);
  });

  it('画面のソースに違反が無い', () => {
    const files = SCREEN_DIRS.filter((dir) => fs.existsSync(path.join(REPO_ROOT, dir)))
      .flatMap((dir) => walkFiles(dir, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)))
      .filter((file) => !file.startsWith(API_DIR));
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.startsWith('apps/mobile/app/'))).toBe(true);
    const violations = files.flatMap((file) => violationsIn(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'), file));
    expect(violations).toEqual([]);
  });
});
