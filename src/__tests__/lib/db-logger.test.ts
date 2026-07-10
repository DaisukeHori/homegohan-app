import { describe, it, expect } from 'vitest';
import { maskSecrets, truncateMetadata, sanitizeMetadata } from '@/lib/db-logger';

describe('maskSecrets (#1044 F6-20)', () => {
  it('password/token/secret/authorization/api_key を含むキーをマスクする', () => {
    const input = {
      password: 'p@ssw0rd',
      token: 'abc123',
      secret: 'shh',
      authorization: 'Bearer xyz',
      api_key: 'sk-xxx',
      apiKey: 'sk-yyy',
      'api-key': 'sk-zzz',
      safe_field: 'keep me',
    };

    const result = maskSecrets(input);

    expect(result.password).toBe('***');
    expect(result.token).toBe('***');
    expect(result.secret).toBe('***');
    expect(result.authorization).toBe('***');
    expect(result.api_key).toBe('***');
    expect(result.apiKey).toBe('***');
    expect(result['api-key']).toBe('***');
    expect(result.safe_field).toBe('keep me');
  });

  it('ネストしたオブジェクト内の秘密情報も再帰的にマスクする', () => {
    const input = {
      user: {
        name: 'taro',
        credentials: { password: 'secret-pass', note: 'ok' },
      },
    };

    const result = maskSecrets(input) as any;

    expect(result.user.name).toBe('taro');
    expect(result.user.credentials.password).toBe('***');
    expect(result.user.credentials.note).toBe('ok');
  });

  it('配列内のオブジェクトもマスクする', () => {
    const input = { items: [{ token: 'a' }, { safe: 'b' }] };
    const result = maskSecrets(input) as any;

    expect(result.items[0].token).toBe('***');
    expect(result.items[1].safe).toBe('b');
  });

  it('無関係のキー名は変更しない', () => {
    const input = { message: 'hello', count: 3 };
    const result = maskSecrets(input);
    expect(result).toEqual({ message: 'hello', count: 3 });
  });
});

describe('truncateMetadata (#1044 F6-20)', () => {
  it('8KB 以下の metadata はそのまま返す', () => {
    const metadata = { foo: 'bar' };
    expect(truncateMetadata(metadata)).toEqual(metadata);
  });

  it('8KB を超える metadata は切り詰められる', () => {
    const huge = { data: 'x'.repeat(20_000) };
    const result = truncateMetadata(huge)!;

    expect(result._truncated).toBe(true);
    expect(typeof result._original_bytes).toBe('number');
    expect((result._original_bytes as number)).toBeGreaterThan(8 * 1024);
    expect(typeof result._preview).toBe('string');
    // 切り詰め後のオブジェクト自体は 8KB を大きく超えない
    const serializedSize = new TextEncoder().encode(JSON.stringify(result)).length;
    expect(serializedSize).toBeLessThan(8.5 * 1024);
  });

  it('undefined はそのまま undefined を返す', () => {
    expect(truncateMetadata(undefined)).toBeUndefined();
  });
});

describe('sanitizeMetadata (#1044 F6-20)', () => {
  it('マスキングと切り詰めを両方適用する', () => {
    const input = { password: 'secret', data: 'x'.repeat(20_000) };
    const result = sanitizeMetadata(input)!;

    // サイズ超過時は切り詰め結果が優先される (マスク済みJSONの一部がpreviewに含まれる)
    expect(result._truncated).toBe(true);
    expect(result._preview).toContain('***');
  });

  it('サイズが小さければマスキングのみ適用される', () => {
    const input = { password: 'secret', note: 'ok' };
    const result = sanitizeMetadata(input)!;

    expect(result.password).toBe('***');
    expect(result.note).toBe('ok');
  });
});
