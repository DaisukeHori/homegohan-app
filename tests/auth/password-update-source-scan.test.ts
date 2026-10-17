/**
 * #1198 パスワードの更新は API (POST /api/auth/password/change・/reset) を通すことの走査
 * (設計 docs/design/cross/16-auth-history-sessions.md §20.3・§22 N-24〜N-28)。
 *
 * 履歴の照合 (直近 N 世代と同じパスワードを断る)・現在のパスワードの確認・再設定の認可は本書の API の経路だけで効く。
 * 画面が supabase-js の updateUser({ password }) を直接呼ぶと、それらを通らない (GoTrue の PUT /user を直接呼ぶのと同じ)。
 * 1. src と apps/mobile の本番コードに updateUser({ password の呼び出しが無い (API を通す)
 * 2. 本人確認のための signInWithPassword を使う画面 (settings/account・account-credentials) が無い (再認証のサインインは無くなった)
 * 3. revoke-others の route と password の route は auth.signOut( と auth.updateUser( を呼ばない (本人の access token で GoTrue を呼ぶ §13.7・§14.3。
 *    Bearer だけの要求で、何もせずに成功を返す形に戻さない)
 * コメントの中の言及は数えない (stripComments)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

/** updateUser({ password: … }) (波括弧の中の最初のキーが password。空白・改行を挟んでよい) */
const UPDATE_USER_PASSWORD_CALL = /\.updateUser\s*\(\s*\{\s*password\b/;
const SIGN_IN_WITH_PASSWORD_CALL = /\.signInWithPassword\s*\(/;
const AUTH_SIGN_OUT_CALL = /\bauth\.signOut\s*\(/;
const AUTH_UPDATE_USER_CALL = /\bauth\.updateUser\s*\(/;

/** コメント (`//` から行末・`/* … *\/`) を除く。文字列の中の `//` (URL) は残す */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const SKIPPED_DIRS = new Set(['node_modules', '.next', '__tests__', '__mocks__', 'dist', 'build', '.expo']);

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : listSourceFiles(full);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function listRouteFiles(dir: string): string[] {
  return listSourceFiles(dir).filter((file) => /route\.tsx?$/.test(file));
}

const rel = (full: string) => path.relative(ROOT, full).split(path.sep).join('/');
const body = (relativePath: string) => stripComments(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));

/** 本番コードの範囲: Web (src)・モバイル (apps/mobile の app と src)・共有 (packages) */
const PRODUCTION_FILES = [
  ...listSourceFiles(path.join(ROOT, 'src')),
  ...listSourceFiles(path.join(ROOT, 'apps/mobile/app')),
  ...listSourceFiles(path.join(ROOT, 'apps/mobile/src')),
  ...listSourceFiles(path.join(ROOT, 'packages')),
];

describe('パスワードの更新は API を通す (cross/16 §14.6・§14.7)', () => {
  it('src と apps/mobile の本番コードに updateUser({ password の呼び出しが無い (API を通す)', () => {
    expect(PRODUCTION_FILES.length).toBeGreaterThan(100);
    const offenders = PRODUCTION_FILES.filter((file) => UPDATE_USER_PASSWORD_CALL.test(stripComments(fs.readFileSync(file, 'utf8')))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('signInWithPassword を本人確認に使う画面 (settings/account・account-credentials) が無い', () => {
    for (const file of [
      'src/app/(main)/settings/account/page.tsx',
      'apps/mobile/src/lib/account-credentials.ts',
      'apps/mobile/src/components/settings/AccountCredentialsSection.tsx',
    ]) {
      expect(SIGN_IN_WITH_PASSWORD_CALL.test(body(file)), file).toBe(false);
    }
  });

  it('更新を API に渡す画面は、その API のパスを持つ (走査が空振りしない)', () => {
    expect(body('src/lib/auth/password/client.ts')).toContain('/api/auth/password/change');
    expect(body('src/lib/auth/password/client.ts')).toContain('/api/auth/password/reset');
    expect(body('src/app/(main)/settings/account/page.tsx')).toContain('changePassword(');
    expect(body('src/app/(auth)/auth/reset-password/page.tsx')).toContain('resetPassword(');
    expect(body('apps/mobile/src/lib/account-credentials.ts')).toContain('/api/auth/password/change');
    expect(body('apps/mobile/app/(auth)/auth/reset-password.tsx')).toContain('/api/auth/password/reset');
  });

  it('src/app/api/auth/sessions/revoke-others/route.ts と src/app/api/auth/password/**/route.ts は auth.signOut( と auth.updateUser( を呼ばない (本人の access token で GoTrue を呼ぶ §13.7・§14.3)', () => {
    const passwordRoutes = listRouteFiles(path.join(ROOT, 'src/app/api/auth/password')).map(rel);
    expect(passwordRoutes).toEqual(
      expect.arrayContaining(['src/app/api/auth/password/change/route.ts', 'src/app/api/auth/password/reset/route.ts']),
    );
    const targets = ['src/app/api/auth/sessions/revoke-others/route.ts', ...passwordRoutes, 'src/lib/auth/password/route-support.ts'];
    for (const file of targets) {
      const source = body(file);
      expect(AUTH_SIGN_OUT_CALL.test(source), `${file} が auth.signOut( を呼んでいる`).toBe(false);
      expect(AUTH_UPDATE_USER_CALL.test(source), `${file} が auth.updateUser( を呼んでいる`).toBe(false);
    }
  });

  it('走査そのもの: コメントの中の言及は数えず、波括弧の中の password を見つける', () => {
    expect(UPDATE_USER_PASSWORD_CALL.test(stripComments('// supabase.auth.updateUser({ password: x })'))).toBe(false);
    expect(UPDATE_USER_PASSWORD_CALL.test(stripComments('await supabase.auth.updateUser({ password: x })'))).toBe(true);
    expect(UPDATE_USER_PASSWORD_CALL.test(stripComments('await supabase.auth.updateUser(\n  { password }\n)'))).toBe(true);
    expect(UPDATE_USER_PASSWORD_CALL.test(stripComments('await supabase.auth.updateUser({ email }, { emailRedirectTo })'))).toBe(false);
    expect(AUTH_SIGN_OUT_CALL.test(stripComments('/* auth.signOut() */ x()'))).toBe(false);
    expect(AUTH_SIGN_OUT_CALL.test(stripComments('await supabase.auth.signOut({ scope: "others" })'))).toBe(true);
  });
});
