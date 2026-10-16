/**
 * ENV_SETUP.md の `CRON_SECRET` の行 (Vercel の環境変数の表) が挙げる Vercel Cron の path が、vercel.json の crons と一致する
 *
 * #1722 (段 B) で vercel.json に `/api/cron/push-outbox` を足したとき、この行が「`process-menu-queue` と `app-log-alerts`
 * (どちらも vercel.json の crons)」のまま残った。cron を足す・外すたびに、手順書の行が実物から外れないようにする。
 * 設計書 docs/design/operator/08-cron-batches.md の側は tests/log-cleanup-dau-snapshot-contract.test.ts が見張る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const ROOT = path.resolve(__dirname, '..');
const ENV_SETUP_PATH = path.join(ROOT, 'ENV_SETUP.md');
const VERCEL_JSON_PATH = path.join(ROOT, 'vercel.json');

const VercelJsonSchema = z.object({ crons: z.array(z.object({ path: z.string(), schedule: z.string() })) });

/** vercel.json に登録されている Vercel Cron の path (重複なし・並べ替え済み) */
function vercelCronPaths(): string[] {
  const { crons } = VercelJsonSchema.parse(JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf-8')));
  return [...new Set(crons.map((cron) => cron.path))].sort();
}

/** ENV_SETUP.md の Vercel の環境変数の表のうち、`CRON_SECRET` の行で Vercel Cron が呼ぶ path を挙げている行 */
function cronSecretRow(): string {
  const rows = fs
    .readFileSync(ENV_SETUP_PATH, 'utf-8')
    .split('\n')
    .filter((line) => line.startsWith('| Vercel の環境変数 | `CRON_SECRET` |') && line.includes('Vercel Cron が'));
  expect(rows, 'ENV_SETUP.md に `CRON_SECRET` の行 (Vercel Cron が呼ぶ path を挙げる行) がちょうど 1 行ある').toHaveLength(1);
  return rows[0];
}

describe('ENV_SETUP.md の CRON_SECRET の行と vercel.json の crons', () => {
  it('行が挙げる /api/cron/* の path の集合が、vercel.json の crons の path の集合と同じ', () => {
    const expected = vercelCronPaths();
    expect(expected.length, 'vercel.json の crons の検査が空振りしていないこと').toBeGreaterThan(0);
    const listed = [...new Set(cronSecretRow().match(/\/api\/cron\/[a-z0-9-]+/g) ?? [])].sort();
    expect(listed).toEqual(expected);
  });
});
