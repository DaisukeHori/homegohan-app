/**
 * #1136 Expo Push Service (exp.host) を呼ぶのは src/lib/push/expo-transport.ts の 1 ファイルだけ
 *
 * 送信の再試行・ticket と receipt の記録・端末の行の削除・ログの伏せ字は、送信待ち (push_outbox) の worker が 1 か所で受け持つ
 * (docs/design/mobile/06-push-send.md §6.4)。ほかの場所 (route・Edge Function・アプリ) から Expo を直接呼ぶと、
 * それらを通らない送信の経路ができるので、コードに exp.host を書くファイルを走査して 1 つに限る。
 * テスト (__tests__・*.test.*) は送信しないので走査しない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'supabase/functions', 'apps/mobile/src'];
const ALLOWED_FILE = 'src/lib/push/expo-transport.ts';
const EXPO_HOST = 'exp.host';
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP = /(^|\/)(__tests__|node_modules|dist)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/;

function listCodeFiles(dir: string): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (SKIP.test(relative)) continue;
    if (entry.isDirectory()) out.push(...listCodeFiles(relative));
    else if (CODE_FILE.test(entry.name)) out.push(relative);
  }
  return out;
}

const files = SCAN_DIRS.flatMap(listCodeFiles);

describe('Expo Push Service を呼ぶ場所 (#1136)', () => {
  it('exp.host を書くのは src/lib/push/expo-transport.ts だけ (src・supabase/functions・apps/mobile/src を走査)', () => {
    // 走査が空振りしていないこと: 3 つのディレクトリのどれも読み、許可したファイルも対象に入っている
    for (const dir of SCAN_DIRS) expect(files.some((file) => file.startsWith(`${dir}/`)), dir).toBe(true);
    expect(files).toContain(ALLOWED_FILE);

    const writers = files.filter((file) => fs.readFileSync(path.join(ROOT, file), 'utf8').includes(EXPO_HOST));
    expect(writers).toEqual([ALLOWED_FILE]);
  });
});
