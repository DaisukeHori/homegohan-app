/**
 * #1631 の回帰テスト: Supabase の型を作る npm script は本番に接続しない (--local) 形にする。
 *
 * 以前は package.json の "types:supabase" が `--linked` (本番に接続) のままで、手順書 (docs/design/operator/09-runbook.md の
 * 「5. 型の再生成」) が「使わない」と書いていても、誤って打てる入口が残っていた。
 * ここでは、どの package.json の script も、型の生成 (gen types) を本番に向けない (--linked / --project-id / --db-url を使わず、
 * --local を使う) ことを固定する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** script を持つ package.json (ルートと workspace) */
const PACKAGE_JSON_FILES = [
  'package.json',
  'apps/mobile/package.json',
  'packages/core/package.json',
  'packages/shared/package.json',
  'packages/handson-tour-shared/package.json',
];

/** Supabase の型の生成のコマンド */
const GEN_TYPES = /\bgen\s+types\b/;
/** 本番 (リモートのプロジェクト) に接続する指定 */
const REMOTE_TARGET = /--linked\b|--project-id\b|--db-url\b/;
/** ローカルの Supabase に向ける指定 */
const LOCAL_TARGET = /--local\b/;

function readScripts(relativePath: string): Record<string, string> {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) return {};
  const scripts = parsed.scripts;
  if (typeof scripts !== 'object' || scripts === null) return {};
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

describe('#1631 Supabase の型を作る script は本番に接続しない', () => {
  it('ルートの types:supabase は --local で作り、本番に接続する指定を持たない', () => {
    const command = readScripts('package.json')['types:supabase'];
    expect(command).toBeDefined();
    expect(command).toMatch(GEN_TYPES);
    expect(command).toMatch(LOCAL_TARGET);
    expect(command).not.toMatch(REMOTE_TARGET);
  });

  it('ルートの types:supabase は型ファイルを直接上書きしない (PostgrestVersion を残す手順書の手順に合わせ、標準出力に出す)', () => {
    const command = readScripts('package.json')['types:supabase'];
    expect(command).not.toMatch(/>\s*\S*database\.types\.ts/);
  });

  it.each(PACKAGE_JSON_FILES)('%s の script に、本番に向けた gen types が無い', (file) => {
    const remoteGenTypes = Object.entries(readScripts(file)).filter(
      ([, command]) => GEN_TYPES.test(command) && REMOTE_TARGET.test(command),
    );
    expect(remoteGenTypes).toEqual([]);
  });

  it('検査の正規表現は、本番に向けた gen types を実際に拾う (検査が空振りしていない)', () => {
    const previous = 'npx supabase gen types typescript --linked > src/types/database.types.ts';
    expect(previous).toMatch(GEN_TYPES);
    expect(previous).toMatch(REMOTE_TARGET);
    expect('npx supabase gen types typescript --project-id abc').toMatch(REMOTE_TARGET);
    expect(previous).toMatch(/>\s*\S*database\.types\.ts/);
  });
});
