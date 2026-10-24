/**
 * 画面が、捕まえた例外の文 (`e?.message ?? '…'`) をそのまま Alert・画面に出さないことの見張り (#1917 の続き)
 *
 * 問題:
 *   `Alert.alert("エラー", e?.message ?? "…")` と書くと、API の失敗では `HTTP 4xx …: {"error":"…"}` の生の文字列が、
 *   Supabase Auth (GoTrue) の失敗では 'Invalid login credentials'・'invalid flow state' のような英語の文が、そのまま出る
 *   (健康の記録の血液検査・ログイン・登録・パスワードの再設定の画面がそうなっていた)。
 *   例外の文は src/lib/api-error.ts の getJapaneseApiErrorMessage (本文の日本語の文か、日本語でなければ固定の文) を通して出す。
 *
 * このテストが確かめること (ソースの文字列で見る。コメントの行は見ない):
 *   apps/mobile/app と apps/mobile/src/components の画面に、`e?.message ??` / `err.message ||` のような、
 *   捕まえた例外 (e・err・error) の message を既定の文で補って使う書き方が無い。
 * 限界: 例外を別の名前で受ける・message を変数に移してから使う書き方は見ない。見張りであって網羅の証明ではない。
 */
import fs from 'node:fs';
import path from 'node:path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SCREEN_DIRS = ['app', 'src/components'] as const;
/** 捕まえた例外の message を、既定の文で補って使う書き方 */
const RAW_ERROR_MESSAGE_PATTERN = /\b(?:e|err|error)\??\.message\s*(?:\?\?|\|\|)/;
const COMMENT_LINE_PATTERN = /^\s*(?:\/\/|\*|\/\*)/;

function sourceFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function violationsIn(source: string, file: string): string[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      !COMMENT_LINE_PATTERN.test(line) && RAW_ERROR_MESSAGE_PATTERN.test(line) ? [`${file}:${index + 1} ${line.trim()}`] : [],
    );
}

describe('捕まえた例外の文をそのまま画面に出さない (#1917 の続き)', () => {
  it('判定: 以前の書き方を拾い、getJapaneseApiErrorMessage とコメントは拾わない', () => {
    expect(violationsIn('      Alert.alert("エラー", e?.message ?? "データの取得に失敗しました。");', 'x.tsx')).toHaveLength(1);
    expect(violationsIn('      const msg = err.message || "失敗しました";', 'x.tsx')).toHaveLength(1);
    expect(violationsIn('      Alert.alert("エラー", getJapaneseApiErrorMessage(e, "データの取得に失敗しました。"));', 'x.tsx')).toEqual([]);
    expect(violationsIn('  // 以前は e?.message ?? "…" を出していた', 'x.tsx')).toEqual([]);
  });

  it('画面のソースに違反が無い', () => {
    const files = SCREEN_DIRS.flatMap((dir) => sourceFilesUnder(path.join(MOBILE_ROOT, dir)));
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) => violationsIn(fs.readFileSync(file, 'utf8'), path.relative(MOBILE_ROOT, file)));
    expect(violations).toEqual([]);
  });
});
