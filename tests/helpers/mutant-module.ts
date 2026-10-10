/**
 * テスト用: ソースを書き換えた写し (変異) を一時ディレクトリに書き、import できるようにする。
 * 検査が「壊したら赤になる」ことを、実際のソースを壊して確かめる回帰テストに使う (作業ツリーのファイルは書き換えない)。
 *
 * 相対 import は元のファイルの場所から解決した絶対パスに置き換えるので、写しからも同じモジュールを読む
 * (vi.mock で差し替えたモジュールは、写しから読んでも差し替えたものになる)。@/ の別名はそのまま使える。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './ai-reach';

const createdDirs: string[] = [];

/**
 * @param file      ROOT からの相対パス
 * @param transform 本文の書き換え。書き換えが起きなかったら例外 (変異が空振りしないように)
 * @returns 写しの絶対パス (import() に渡す)
 */
export function writeMutant(file: string, transform: (source: string) => string): string {
  const original = path.join(ROOT, file);
  const source = fs.readFileSync(original, 'utf8');
  const mutated = transform(source);
  if (mutated === source) throw new Error(`変異が起きていない: ${file}`);
  const absolutized = mutated.replace(/(from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (_m, head: string, quote: string, spec: string) => {
    return `${head}${quote}${path.resolve(path.dirname(original), spec)}${quote}`;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mutant-'));
  createdDirs.push(dir);
  const target = path.join(dir, path.basename(file));
  fs.writeFileSync(target, absolutized);
  return target;
}

/** writeMutant で作った写しを消す (afterAll で呼ぶ) */
export function removeMutants(): void {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
