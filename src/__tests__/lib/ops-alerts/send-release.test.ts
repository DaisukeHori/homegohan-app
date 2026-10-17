import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NON_RELEASING_SEND_ERROR_CODES } from '@/lib/ops-alerts/send-release';

// #1577 の 8: 運用メールを送れなかったとき、送る権利 (claim_ops_alert) を返さない失敗のコードの共有。
// route ごとに規則を書き分けると、片方だけ「同じ結果になる送り直し」を繰り返す (backup-freshness が suppressed でも返していた)。
// 挙動そのもの (返す / 返さない) は各 route のテスト (app-log-alerts.test.ts の T-4・T-10・CF・ST、backup-freshness.test.ts の S-8・S-9) が確かめる。

const APP_DIR = path.join(process.cwd(), 'src', 'app');
const SHARED_IMPORT = /import\s*\{[^}]*\bNON_RELEASING_SEND_ERROR_CODES\b[^}]*\}\s*from\s*'@\/lib\/ops-alerts\/send-release'/;
const CLAIM_CALL = /\.rpc\(\s*'claim_ops_alert'/;
const RELEASE_CALL = /\.rpc\(\s*'release_ops_alert'/;
const LOCAL_DEFINITION = /\bconst\s+NON_RELEASING_SEND_ERROR_CODES\b/;

/** コメント (行コメント・ブロックコメント) を除いた本文。コメントに書いた RPC の名前を呼び出しに数えない */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('NON_RELEASING_SEND_ERROR_CODES (#1577 の 8)', () => {
  it('返さないのは suppressed (宛先が停止リスト) と invalid_envelope (文面の不備) の 2 つだけ', () => {
    expect([...NON_RELEASING_SEND_ERROR_CODES].sort()).toEqual(['invalid_envelope', 'suppressed']);
  });

  it('送信の設定が未完了 (not_configured)・登録の失敗 (outbox_failed) は含まない (次の回でもう一度試す)', () => {
    expect(NON_RELEASING_SEND_ERROR_CODES.has('not_configured')).toBe(false);
    expect(NON_RELEASING_SEND_ERROR_CODES.has('outbox_failed')).toBe(false);
  });

  it('送る権利を取って返す src/app の route は、すべて共有の定数を import し、自前の定数を持たない', () => {
    const releasing = listSourceFiles(APP_DIR)
      .map((file) => ({ file, code: stripComments(fs.readFileSync(file, 'utf8')) }))
      .filter(({ code }) => CLAIM_CALL.test(code) && RELEASE_CALL.test(code));

    // 権利を取って返す route は、いまは app-log-alerts と backup-freshness の 2 本 (増えたらこの一覧も直す)
    expect(releasing.map(({ file }) => path.relative(process.cwd(), file).split(path.sep).join('/')).sort()).toEqual([
      'src/app/api/cron/app-log-alerts/route.ts',
      'src/app/api/cron/backup-freshness/route.ts',
    ]);
    for (const { file, code } of releasing) {
      expect(SHARED_IMPORT.test(code), file).toBe(true);
      expect(LOCAL_DEFINITION.test(code), file).toBe(false);
    }
  });
});
