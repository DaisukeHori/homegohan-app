/**
 * #1457 アプリ (apps/mobile): 生の fetch で AI 相談に送る場所が、503 (緊急停止・メンテナンス中) を固定の文にする — contract テスト
 *
 * getApi() (apps/mobile/src/lib/api.ts) は、AI 相談の緊急停止 (503 AI_CHAT_DISABLED)・メンテナンス中 (503 MAINTENANCE_MODE) の
 * Error を、固定の文の ServiceUnavailableError に置き換えて投げ直す。getApi() を通らない生の fetch には、この置き換えが効かない。
 * 生の fetch で AI 相談 (/api/ai/consultation) を呼ぶファイルは、失敗の応答を次のどちらかで読む:
 *   - errorOfFailedResponse(status, 本文) (apps/mobile/src/lib/failed-response.ts) で例外を作る
 *     (`HTTP <状態>: <本文>` の Error を自分で作らない。429 AI_DAILY_LIMIT (#1149) も同じ関数で固定の文になる)
 *   - 本文を JSON で読んだあとなら serviceUnavailableMessageOf(status, 本文)
 * 挙動 (固定の文を出す・入力を戻す) は apps/mobile/__tests__/ai/service-unavailable.test.tsx が確かめる。
 * 生の fetch の呼び出しを関数ごとに分類し、429 を返す呼び先を呼ぶ関数が errorOfFailedResponse を通すかは
 * tests/ai-daily-limit-mobile-raw-fetch.test.ts が見る (このテストは AI 相談を呼ぶファイルの 503 を見る)。
 *
 * 限界 (見張りであって証明ではない):
 *   - ファイル単位で見る。同じファイルの別の関数が errorOfFailedResponse を呼んでいれば、ある関数が呼んでいなくても通る
 *   - AI 相談 (/api/ai/consultation) 以外の API を生の fetch で呼ぶ場所のメンテナンス中の 503 は、このテストでは見ない
 *     (アプリの API を呼ぶ生の fetch の全部は、tests/ai-daily-limit-mobile-raw-fetch.test.ts の 4 が関数ごとに見る。#1486)
 *
 * コメントは見ない (TypeScript の printer でコメントを除いたソースを調べる)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_SOURCE_DIRS = ['apps/mobile/app', 'apps/mobile/src'];
const AI_CONSULTATION_PATH = '/api/ai/consultation';

/** 生の fetch で AI 相談を呼ぶファイル (リポジトリのルートからの相対パス)。足した・消したら、ここで気づく */
const RAW_FETCH_FILES = ['apps/mobile/app/ai/[sessionId].tsx', 'apps/mobile/src/components/ai/AIAdvisorSheet.tsx'];

/** 失敗の応答を 503 の固定の文にする関数 (apps/mobile/src/lib/failed-response.ts・apps/mobile/src/lib/service-unavailable.ts) */
const READERS = ['errorOfFailedResponse', 'serviceUnavailableMessageOf'];

function collectFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...collectFiles(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const printer = ts.createPrinter({ removeComments: true });

/** コメントを除いたソース */
function codeOf(file: string): string {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return printer.printFile(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind));
}

const files = MOBILE_SOURCE_DIRS.flatMap(collectFiles).sort();
const rawFetchFiles = files.filter((file) => {
  const code = codeOf(file);
  return /\bfetch\s*\(/.test(code) && code.includes(AI_CONSULTATION_PATH);
});

describe('#1457 生の fetch で AI 相談を呼ぶ場所は、503 を固定の文にする', () => {
  it('走査が機能している: アプリのソースを読み、生の fetch で AI 相談を呼ぶファイルを見つけている', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(rawFetchFiles).toEqual([...RAW_FETCH_FILES].sort());
  });

  for (const file of RAW_FETCH_FILES) {
    it(`${file}: 失敗の応答を errorOfFailedResponse / serviceUnavailableMessageOf で読み、HTTP の生の文字列の Error を自分で作らない`, () => {
      const code = codeOf(file);
      expect(
        READERS.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(code)),
        `${file} は ${READERS.join(' / ')} を呼んでいない`,
      ).toBe(true);
      expect(code, `${file} は \`HTTP \${status}: ...\` の Error を自分で作っている。errorOfFailedResponse を使う`).not.toMatch(
        /new\s+Error\s*\(\s*`HTTP \$\{/,
      );
      // failed-response (errorOfFailedResponse) か service-unavailable (serviceUnavailableMessageOf) から import している
      expect(code).toMatch(/from\s+["'][./]+(?:src\/)?lib\/(?:failed-response|service-unavailable)["']/);
    });
  }
});
