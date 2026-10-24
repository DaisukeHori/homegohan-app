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
 *   また、画面・部品・フック・src/lib (src/lib/api-error.ts を除く) が getApiErrorMessage を直接呼ばない
 *   (getApiErrorMessage は HTTP のエラーでない例外の英文 (Supabase Auth の文など) をそのまま返す。画面に出す文は
 *   getJapaneseApiErrorMessage を通す。以前はパスワードの再設定の更新の失敗の Alert などが getApiErrorMessage のままだった)。
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

/** getApiErrorMessage を直接呼ばないことを見るディレクトリ (画面・部品・フック・src/lib) */
const DIRECT_CALL_SOURCE_DIRS = ['app', 'src/components', 'src/hooks', 'src/lib'] as const;
/** getApiErrorMessage を定義し、getJapaneseApiErrorMessage の中で呼ぶファイル (見張りの外) */
const API_ERROR_MODULE = path.join('src', 'lib', 'api-error.ts');
/** getApiErrorMessage の呼び出し (getJapaneseApiErrorMessage は拾わない) */
const DIRECT_API_ERROR_MESSAGE_CALL = /(?<![A-Za-z0-9_])getApiErrorMessage\s*\(/;

function directCallsIn(source: string, file: string): string[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      !COMMENT_LINE_PATTERN.test(line) && DIRECT_API_ERROR_MESSAGE_CALL.test(line) ? [`${file}:${index + 1} ${line.trim()}`] : [],
    );
}

describe('画面に出す例外の文は getJapaneseApiErrorMessage を通す (getApiErrorMessage を直接呼ばない。#1917 の続き)', () => {
  it('判定: getApiErrorMessage の呼び出しを拾い、getJapaneseApiErrorMessage とコメントは拾わない', () => {
    expect(directCallsIn('      Alert.alert("更新失敗", getApiErrorMessage(e, "更新に失敗しました。"));', 'x.tsx')).toHaveLength(1);
    expect(directCallsIn('    return { ok: false, message: getApiErrorMessage(err, fallback) };', 'x.ts')).toHaveLength(1);
    expect(directCallsIn('      Alert.alert("更新失敗", getJapaneseApiErrorMessage(e, "更新に失敗しました。"));', 'x.tsx')).toEqual([]);
    expect(directCallsIn(' *     Alert.alert("エラー", getApiErrorMessage(e, "..."));', 'x.ts')).toEqual([]);
  });

  it('画面・部品・フック・src/lib のソースに、getApiErrorMessage の直接の呼び出しが無い', () => {
    const files = DIRECT_CALL_SOURCE_DIRS.flatMap((dir) => sourceFilesUnder(path.join(MOBILE_ROOT, dir))).filter(
      (file) => path.relative(MOBILE_ROOT, file) !== API_ERROR_MODULE,
    );
    expect(files.map((file) => path.relative(MOBILE_ROOT, file))).toEqual(
      expect.arrayContaining([path.join('app', '(auth)', 'auth', 'reset-password.tsx'), path.join('src', 'lib', 'account-credentials.ts')]),
    );
    const violations = files.flatMap((file) => directCallsIn(fs.readFileSync(file, 'utf8'), path.relative(MOBILE_ROOT, file)));
    expect(violations).toEqual([]);
  });
});
