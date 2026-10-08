/**
 * env-example.test.ts
 * apps/mobile/env.example の網羅性のテスト (#1049 F7-19)
 *
 * アプリのソースが読む EXPO_PUBLIC_* が env.example に載っていないと、新しく環境を作る人 (EAS の設定を含む) が
 * その変数の存在に気付けない。以前は EXPO_PUBLIC_WEB_URL / EXPO_PUBLIC_POSTHOG_KEY / EXPO_PUBLIC_POSTHOG_HOST が
 * 載っていなかった。ソースに新しい EXPO_PUBLIC_* を足したら、env.example にも足すこと。
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '..');

/** app/ と src/ 配下のソースから `process.env.EXPO_PUBLIC_*` (ドット / 文字列リテラルの添字) を集める */
function collectReferencedVars(): Set<string> {
  const found = new Set<string>();
  const pattern = /process\.env(?:\.|\[['"])(EXPO_PUBLIC_[A-Z0-9_]+)/g;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const match of text.matchAll(pattern)) found.add(match[1]);
      }
    }
  };

  walk(path.join(MOBILE_ROOT, 'app'));
  walk(path.join(MOBILE_ROOT, 'src'));
  return found;
}

/** env.example に `NAME=` の形で書かれている変数名 (コメント行は数えない) */
function collectDocumentedVars(): Set<string> {
  const example = fs.readFileSync(path.join(MOBILE_ROOT, 'env.example'), 'utf8');
  return new Set(
    example
      .split('\n')
      .map((line) => /^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
}

describe('env.example の網羅性', () => {
  it('アプリのソースが読む EXPO_PUBLIC_* は全部 env.example に載っている', () => {
    const referenced = collectReferencedVars();
    // 取りこぼし防止: 少なくとも既知の変数は拾えている
    expect(referenced.has('EXPO_PUBLIC_API_BASE_URL')).toBe(true);
    expect(referenced.has('EXPO_PUBLIC_WEB_URL')).toBe(true);
    expect(referenced.has('EXPO_PUBLIC_POSTHOG_KEY')).toBe(true);
    expect(referenced.has('EXPO_PUBLIC_POSTHOG_HOST')).toBe(true);

    const documented = collectDocumentedVars();
    const missing = [...referenced].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });
});
