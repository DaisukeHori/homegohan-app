// @vitest-environment node
/**
 * Web の Apple のボタンのスイッチ (docs/design/mobile/08-sign-in-with-apple.md §10.2・§14.2)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAppleSignInEnabled } from '@/lib/auth/apple-sign-in-flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isAppleSignInEnabled', () => {
  it.each(['on', 'ON', ' on '])('NEXT_PUBLIC_APPLE_SIGN_IN が %j なら true', (value) => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', value);
    expect(isAppleSignInEnabled()).toBe(true);
  });

  it.each(['', 'off', 'true', '1'])('NEXT_PUBLIC_APPLE_SIGN_IN が %j なら false', (value) => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', value);
    expect(isAppleSignInEnabled()).toBe(false);
  });

  it('未設定なら false', () => {
    vi.stubEnv('NEXT_PUBLIC_APPLE_SIGN_IN', undefined);
    expect(isAppleSignInEnabled()).toBe(false);
  });
});

const REPO_ROOT = process.cwd();
/** 走査の対象のディレクトリ (どちらも __tests__ を除く) */
const SCAN_ROOTS = ['src', path.join('apps', 'mobile', 'src')];
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx']);
/** スイッチを読んでよいファイル (リポジトリの根からの道)。モバイルの分は段 A2 で足される */
const WEB_FLAG_FILE = path.join('src', 'lib', 'auth', 'apple-sign-in-flag.ts');
const MOBILE_FLAG_FILE = path.join('apps', 'mobile', 'src', 'lib', 'appleSignIn.ts');
const FLAG_READ = /process\.env\.(?:NEXT_PUBLIC|EXPO_PUBLIC)_APPLE_SIGN_IN\b/;

function listSourceFiles(dir: string): string[] {
  const absolute = path.join(REPO_ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (name === '__tests__' || name === 'node_modules') return [];
    const relative = path.join(dir, name);
    if (statSync(path.join(REPO_ROOT, relative)).isDirectory()) return listSourceFiles(relative);
    return SCANNED_EXTENSIONS.has(path.extname(name)) ? [relative] : [];
  });
}

/** ブロックのコメントと行末のコメントを除いた行 */
function codeLinesOf(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''));
}

describe('スイッチの読み方は 1 つ', () => {
  it('src/ と apps/mobile/src/ (__tests__ を除く) で process.env の NEXT_PUBLIC / EXPO_PUBLIC の APPLE_SIGN_IN を書くファイルは 2 つのフラグのファイルだけで、その行は isAppleSignInFlagOn( の引数になっている', () => {
    const readers = new Map<string, string[]>();
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(root)) {
        const hits = codeLinesOf(readFileSync(path.join(REPO_ROOT, file), 'utf8')).filter((line) => FLAG_READ.test(line));
        if (hits.length > 0) readers.set(file, hits);
      }
    }

    // Web のファイルは段 B で必ずある。モバイルのファイルは段 A2 が足す (A2 のマージ前の枝には無くてよい)
    const allowed = new Set([WEB_FLAG_FILE, MOBILE_FLAG_FILE]);
    expect(Array.from(readers.keys()).filter((file) => !allowed.has(file))).toEqual([]);
    expect(readers.has(WEB_FLAG_FILE)).toBe(true);

    for (const [file, lines] of readers) {
      for (const line of lines) {
        expect(line, `${file} の行が isAppleSignInFlagOn( の引数になっている`).toMatch(/isAppleSignInFlagOn\(\s*process\.env\./);
      }
    }
  });
});
