// @vitest-environment node
/**
 * #1496 結合テストの段で、機能フラグの行をメモリに覚える時間 (FEATURE_FLAG_CACHE_TTL_MS) を短くする配線。
 *
 * tests/integration/security/feature-flags-runtime.test.ts は、切り替えの反映を待つ上限を、自分のプロセスの
 * FEATURE_FLAG_CACHE_TTL_MS から決める。サーバー (next dev) だけが既定の 30 秒のままだと、待ちの上限が足りずに落ち、
 * テストだけが既定のままだと、短くした効果が無い (待ちの上限が 60 秒のまま)。そこで、次をそろえる:
 *   - security-regression.yml: next dev を起動するステップと、そのテストを回すステップの両方に、同じ値を渡す
 *   - その値は正の整数で、既定 (30 秒) より短い (src/lib/feature-flag-cache-ttl.ts の読み方で既定に戻らない)
 *   - scripts/local-ci.sh は yml と同じ値を next dev と 1 本目の結合テストに渡す
 *     (コマンドと環境変数の一致そのものは tests/local-ci-workflow-sync.test.ts が確かめる)
 *   - 本番の設定 (vercel.json) には足さない
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FEATURE_FLAG_CACHE_TTL_DEFAULT_MS,
  FEATURE_FLAG_CACHE_TTL_ENV,
  resolveFeatureFlagCacheTtlMs,
} from '../src/lib/feature-flag-cache-ttl';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WORKFLOW = '.github/workflows/security-regression.yml';
const LOCAL_CI = 'scripts/local-ci.sh';

/** yml のステップ (`- name:` から次の `- ` まで) のうち、名前が name で始まるものの本文 */
function stepOf(yml: string, name: string): string {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}` || l.trim().startsWith(`- name: ${name}`));
  if (start < 0) throw new Error(`${WORKFLOW} にステップ「${name}」が無い`);
  const indent = lines[start].indexOf('-');
  let end = start + 1;
  while (end < lines.length && !(lines[end].indexOf('-') === indent && lines[end].trim().startsWith('- '))) end += 1;
  return lines.slice(start, end).join('\n');
}

function ttlInStep(step: string): string | undefined {
  return new RegExp(`^\\s+${FEATURE_FLAG_CACHE_TTL_ENV}:\\s*"?(\\d+)"?\\s*$`, 'm').exec(step)?.[1];
}

describe('結合テストの段の FEATURE_FLAG_CACHE_TTL_MS (#1496)', () => {
  const yml = read(WORKFLOW);
  const server = ttlInStep(stepOf(yml, 'Start Next dev server'));
  const runner = ttlInStep(stepOf(yml, 'Run security regression + handson-tour integration tests'));

  it('next dev のステップと、反映を待つテストを回すステップの両方に、同じ値を渡す', () => {
    expect(server, 'next dev のステップ').toBeDefined();
    expect(runner, 'テストのステップ').toBeDefined();
    expect(runner).toBe(server);
  });

  it('その値は正の整数として読まれ、既定 (30 秒) より短い', () => {
    const ms = resolveFeatureFlagCacheTtlMs(server);
    expect(String(ms)).toBe(server);
    expect(ms).toBeLessThan(FEATURE_FLAG_CACHE_TTL_DEFAULT_MS);
  });

  it('scripts/local-ci.sh も同じ値を渡す', () => {
    const m = /^readonly INTEGRATION_FEATURE_FLAG_CACHE_TTL_MS=(\d+)$/m.exec(read(LOCAL_CI));
    expect(m?.[1]).toBe(server);
  });

  it('本番の設定 (vercel.json) には足さない (本番は既定の 30 秒のまま)', () => {
    expect(read('vercel.json')).not.toContain(FEATURE_FLAG_CACHE_TTL_ENV);
  });
});
