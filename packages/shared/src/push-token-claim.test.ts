/**
 * push-token-claim (通知のトークンの claim・release の取り決め。#1636) のユニットテスト
 *
 * 確かめること:
 *   - 端末の秘密の値の形 (PUSH_INSTALL_SECRET_PATTERN) は、サーバーが作る値 (PUSH_INSTALL_SECRET_BYTES バイトの乱数の base64url) と合う
 *   - API のパスに、実際の route がある (route を移したのにパスだけ古いまま、を防ぐ)
 *   - DB の CHECK (migration) とサーバーのハッシュの形が、同じ (SHA-256 の 16 進の小文字 64 文字)
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PUSH_INSTALL_SECRET_BYTES,
  PUSH_TOKEN_CLAIM_API_PATH,
  PUSH_TOKEN_RELEASE_API_PATH,
  isPushInstallSecret,
} from './push-token-claim';
import * as shared from './index';

const ROOT = path.resolve(__dirname, '../../..');

/** この機能の migration。version (先頭の 14 桁) は付け替えられることがあるので、名前の後ろ半分で探す */
function readMigration(): string {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{14}_user_push_tokens_install_secret\.sql$/.test(f));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(dir, files[0]), 'utf8');
}

describe('端末の秘密の値の形 (#1636)', () => {
  it('サーバーが作る値 (32 バイトの乱数の base64url) はどれも形に合う', () => {
    expect(PUSH_INSTALL_SECRET_BYTES).toBe(32);
    for (let i = 0; i < 50; i += 1) {
      expect(isPushInstallSecret(randomBytes(PUSH_INSTALL_SECRET_BYTES).toString('base64url'))).toBe(true);
    }
  });

  it.each([
    ['空', ''],
    ['短い (42 文字)', 'a'.repeat(42)],
    ['長い (44 文字)', 'a'.repeat(44)],
    ['詰め物の = 付き', `${'a'.repeat(42)}=`],
    ['base64 の + / を含む', `${'a'.repeat(41)}+/`],
    ['前後に空白', ` ${'a'.repeat(43)}`],
    ['SHA-256 の 16 進 (ハッシュそのもの)', 'f'.repeat(64)],
    ['文字列でない', 123],
    ['null', null],
    ['undefined', undefined],
  ])('%s は秘密の値の形ではない', (_label, value) => {
    expect(isPushInstallSecret(value)).toBe(false);
  });

  it('index から読める (サーバーとモバイルが @homegohan/shared から読む)', () => {
    expect(shared.isPushInstallSecret).toBe(isPushInstallSecret);
    expect(shared.PUSH_TOKEN_CLAIM_API_PATH).toBe(PUSH_TOKEN_CLAIM_API_PATH);
    expect(shared.PUSH_TOKEN_RELEASE_API_PATH).toBe(PUSH_TOKEN_RELEASE_API_PATH);
  });
});

describe('API のパスと DB の形 (#1636)', () => {
  it('claim と release のパスに、実際の route がある', () => {
    for (const apiPath of [PUSH_TOKEN_CLAIM_API_PATH, PUSH_TOKEN_RELEASE_API_PATH]) {
      expect(fs.existsSync(path.join(ROOT, 'src/app', apiPath, 'route.ts')), apiPath).toBe(true);
    }
  });

  it('migration の CHECK は SHA-256 の 16 進の小文字 64 文字 (src/lib/push-token-install-secret.ts のハッシュと同じ形)', () => {
    const sql = readMigration();
    expect(sql).toContain("install_secret_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS install_secret_hash text;/);
  });
});
