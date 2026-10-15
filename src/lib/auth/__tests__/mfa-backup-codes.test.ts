/**
 * #1176 運営ロールの MFA のバックアップコードのテスト。docs/design/cross/12-operator-mfa.md §12.3・§21.1 (mfa-backup-codes.test.ts)
 *
 * 表の読み書きは、PostgREST のクエリビルダの呼び出しを記録する偽物の client で確かめる (どの条件の UPDATE / DELETE / INSERT を投げたか)。
 */
import { describe, expect, it } from 'vitest';
import {
  BACKUP_CODE_ALPHABET,
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  consumeBackupCode,
  countRemainingBackupCodes,
  deleteBackupCodes,
  formatBackupCode,
  generateBackupCodes,
  hashBackupCode,
  isWellFormedBackupCode,
  issueBackupCodes,
  normalizeBackupCode,
  type BackupCodeStoreClient,
} from '@/lib/auth/mfa/backup-codes';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const STORE_ERROR_MESSAGE = 'operator_mfa_backup_codes の読み書きに失敗しました';

type Call = { op: string; args: unknown[] };
interface QueryResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

/**
 * from(table) から始まる 1 本のクエリの呼び出しを calls に記録し、await されたら results の先頭を返す偽物。
 * 1 回の from(...) ごとに results を 1 つ消費する
 */
function fakeStore(results: QueryResult[]) {
  const queries: Array<{ table: string; calls: Call[] }> = [];
  const client = {
    from(table: string) {
      const query = { table, calls: [] as Call[] };
      queries.push(query);
      const result = results.shift() ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const op of ['delete', 'insert', 'update', 'select', 'eq', 'is']) {
        builder[op] = (...args: unknown[]) => {
          query.calls.push({ op, args });
          return builder;
        };
      }
      builder.then = (resolve: (value: QueryResult) => unknown) => resolve({ data: null, error: null, count: null, ...result });
      return builder;
    },
  };
  return { client: client as unknown as BackupCodeStoreClient, queries };
}

const POSTGREST_ERROR = { message: 'relation "x" does not exist', code: '42P01', details: null, hint: null };

describe('バックアップコードの値', () => {
  it('generateBackupCodes は 10 個・10 文字・字母だけ・重複なし', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    for (const code of codes) {
      expect(code).toHaveLength(BACKUP_CODE_LENGTH);
      expect([...code].every((ch) => BACKUP_CODE_ALPHABET.includes(ch))).toBe(true);
    }
    expect(BACKUP_CODE_COUNT).toBe(10);
    expect(BACKUP_CODE_LENGTH).toBe(10);
    expect(BACKUP_CODE_ALPHABET).toHaveLength(32);
  });

  it('normalizeBackupCode は小文字と区切り (- 空白) を取り除く', () => {
    expect(normalizeBackupCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeBackupCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
    expect(normalizeBackupCode('ab\u0000cd')).toBe('ABCD');
  });

  it('isWellFormedBackupCode は長さと字母を見る (I / O / 0 / 1 は不可)', () => {
    expect(isWellFormedBackupCode('ABCDEFGHJK')).toBe(true);
    expect(isWellFormedBackupCode('23456789AB')).toBe(true);
    expect(isWellFormedBackupCode('ABCDEFGHJ')).toBe(false);
    expect(isWellFormedBackupCode('ABCDEFGHJKL')).toBe(false);
    for (const bad of ['I', 'O', '0', '1']) {
      expect(isWellFormedBackupCode(`ABCDEFGHJ${bad}`), bad).toBe(false);
    }
  });

  it('hashBackupCode は user_id を前像に含む (同じコードでも利用者が違えば別のハッシュ)。hex 64 文字', () => {
    const mine = hashBackupCode(USER_ID, 'ABCDEFGHJK');
    expect(mine).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBackupCode(OTHER_USER_ID, 'ABCDEFGHJK')).not.toBe(mine);
    expect(hashBackupCode(USER_ID, 'ABCDEFGHJK')).toBe(mine);
    expect(hashBackupCode(USER_ID, 'ABCDEFGHJM')).not.toBe(mine);
  });

  it('formatBackupCode は 5-5 で区切る', () => {
    expect(formatBackupCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(normalizeBackupCode(formatBackupCode('ABCDEFGHJK'))).toBe('ABCDEFGHJK');
  });
});

describe('表の読み書き', () => {
  it('consumeBackupCode は UPDATE … used_at IS NULL の 1 文で、0 行なら false', async () => {
    const consumed = fakeStore([{ data: [{ id: 'row-1' }] }]);
    await expect(consumeBackupCode(consumed.client, USER_ID, 'ABCDEFGHJK')).resolves.toBe(true);
    expect(consumed.queries).toHaveLength(1);
    const [query] = consumed.queries;
    expect(query.table).toBe('operator_mfa_backup_codes');
    const ops = query.calls.map((c) => c.op);
    expect(ops[0]).toBe('update');
    expect(query.calls[0].args[0]).toEqual({ used_at: expect.any(String) });
    expect(query.calls).toEqual(
      expect.arrayContaining([
        { op: 'eq', args: ['user_id', USER_ID] },
        { op: 'eq', args: ['code_hash', hashBackupCode(USER_ID, 'ABCDEFGHJK')] },
        { op: 'is', args: ['used_at', null] },
      ]),
    );

    const none = fakeStore([{ data: [] }]);
    await expect(consumeBackupCode(none.client, USER_ID, 'ABCDEFGHJK')).resolves.toBe(false);
  });

  it('issueBackupCodes は旧行を全部消してから 10 行を入れる', async () => {
    const store = fakeStore([{}, {}]);
    const codes = await issueBackupCodes(store.client, USER_ID);
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(store.queries).toHaveLength(2);
    const [del, ins] = store.queries;
    expect(del.calls).toEqual([
      { op: 'delete', args: [] },
      { op: 'eq', args: ['user_id', USER_ID] },
    ]);
    expect(ins.calls[0].op).toBe('insert');
    const rows = ins.calls[0].args[0] as Array<{ user_id: string; batch_id: string; code_hash: string }>;
    expect(rows).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(rows.map((r) => r.batch_id)).size).toBe(1);
    expect(rows.map((r) => r.code_hash)).toEqual(codes.map((code) => hashBackupCode(USER_ID, code)));
    expect(rows.every((r) => r.user_id === USER_ID)).toBe(true);
    // 値そのものは表に入れない
    expect(JSON.stringify(rows)).not.toContain(codes[0]);
  });

  it('countRemainingBackupCodes は used_at IS NULL の行だけを数え、deleteBackupCodes は使用済みを含む全行を消して消した数を返す', async () => {
    const counted = fakeStore([{ count: 7 }]);
    await expect(countRemainingBackupCodes(counted.client, USER_ID)).resolves.toBe(7);
    expect(counted.queries[0].calls).toEqual([
      { op: 'select', args: ['id', { count: 'exact', head: true }] },
      { op: 'eq', args: ['user_id', USER_ID] },
      { op: 'is', args: ['used_at', null] },
    ]);
    const empty = fakeStore([{ count: null }]);
    await expect(countRemainingBackupCodes(empty.client, USER_ID)).resolves.toBe(0);

    const deleted = fakeStore([{ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]);
    await expect(deleteBackupCodes(deleted.client, USER_ID)).resolves.toBe(3);
    expect(deleted.queries[0].calls).toEqual([
      { op: 'delete', args: [] },
      { op: 'eq', args: ['user_id', USER_ID] },
      { op: 'select', args: ['id'] },
    ]);
    // used_at で絞らない (使用済みも消す)
    expect(deleted.queries[0].calls.some((c) => c.op === 'is')).toBe(false);
    const none = fakeStore([{ data: [] }]);
    await expect(deleteBackupCodes(none.client, USER_ID)).resolves.toBe(0);
  });

  it('4 関数は PostgREST の error で固定の文の Error を投げ (message に PostgREST の文を入れず cause に持つ)、consumeBackupCode の 0 行は投げずに false (§13.6)', async () => {
    const calls: Array<[string, (client: BackupCodeStoreClient) => Promise<unknown>, QueryResult[]]> = [
      ['issueBackupCodes (DELETE)', (c) => issueBackupCodes(c, USER_ID), [{ error: POSTGREST_ERROR }]],
      ['issueBackupCodes (INSERT)', (c) => issueBackupCodes(c, USER_ID), [{}, { error: POSTGREST_ERROR }]],
      ['consumeBackupCode', (c) => consumeBackupCode(c, USER_ID, 'ABCDEFGHJK'), [{ error: POSTGREST_ERROR }]],
      ['countRemainingBackupCodes', (c) => countRemainingBackupCodes(c, USER_ID), [{ error: POSTGREST_ERROR }]],
      ['deleteBackupCodes', (c) => deleteBackupCodes(c, USER_ID), [{ error: POSTGREST_ERROR }]],
    ];
    for (const [name, run, results] of calls) {
      const store = fakeStore(results);
      const error = await run(store.client).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, name).toBeInstanceOf(Error);
      expect((error as Error).message, name).toBe(STORE_ERROR_MESSAGE);
      expect((error as Error).message, name).not.toContain('relation');
      expect((error as Error & { cause?: unknown }).cause, name).toBe(POSTGREST_ERROR);
    }
    const zero = fakeStore([{ data: [] }]);
    await expect(consumeBackupCode(zero.client, USER_ID, 'ABCDEFGHJK')).resolves.toBe(false);
  });
});
