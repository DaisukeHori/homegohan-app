/**
 * #1190 Web の route が GoTrue にセッションを作らせたら、ログインの文脈の記録 (recordWebLoginContextFromRequest) を必ず呼ぶことの走査
 * (設計 docs/design/cross/16-auth-history-sessions.md §13.5・§20.3)。
 *
 * src/app の route.ts ごとに、コメントを除いた本文の `.signInWithPassword(`・`.exchangeCodeForSession(`・`.verifyOtp(` の呼び出しの数と、
 * `recordWebLoginContextFromRequest(` の呼び出しの数を数え、後者が少ないファイルが無いことを見る。
 * 分岐を足して呼び忘れると赤になる。分岐ごとの対応 (どの呼び出しの直後か) は route のテスト tests/api/auth-login-context.test.ts が見る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(ROOT, 'src/app');

const SESSION_CREATING_CALL = /\.(?:signInWithPassword|exchangeCodeForSession|verifyOtp)\s*\(/g;
const RECORD_CALL = /\brecordWebLoginContextFromRequest\s*\(/g;
const LOGIN_ROUTE = 'src/app/api/auth/login/route.ts';
const CALLBACK_ROUTE = 'src/app/(auth)/auth/callback/route.ts';

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

function listRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listRouteFiles(full);
    return entry.name === 'route.ts' || entry.name === 'route.tsx' ? [full] : [];
  });
}

interface Count {
  file: string;
  sessionCalls: number;
  recordCalls: number;
}

function countOf(source: string): { sessionCalls: number; recordCalls: number } {
  const body = stripComments(source);
  return {
    sessionCalls: (body.match(SESSION_CREATING_CALL) ?? []).length,
    recordCalls: (body.match(RECORD_CALL) ?? []).length,
  };
}

const counts: Count[] = listRouteFiles(APP_DIR)
  .map((full) => ({ file: path.relative(ROOT, full).split(path.sep).join('/'), ...countOf(fs.readFileSync(full, 'utf8')) }))
  .filter((c) => c.sessionCalls > 0);

describe('Web の route のログインの文脈の記録 (cross/16 §13.5)', () => {
  it('src/app の route.ts ごとに、コメント (`//`・`/* */`) を除いた本文の `.signInWithPassword(`・`.exchangeCodeForSession(`・`.verifyOtp(` の呼び出しの数より、`recordWebLoginContextFromRequest(` の呼び出しの数が少ないファイルは無い', () => {
    const missing = counts.filter((c) => c.recordCalls < c.sessionCalls).map((c) => `${c.file}: session ${c.sessionCalls} > record ${c.recordCalls}`);
    expect(missing).toEqual([]);
  });

  it('数えたファイルに src/app/api/auth/login/route.ts と src/app/(auth)/auth/callback/route.ts が入っていて、どちらも session を作る呼び出しが 1 つ以上ある (走査が空振りしない)', () => {
    const files = counts.map((c) => c.file);
    expect(files).toContain(LOGIN_ROUTE);
    expect(files).toContain(CALLBACK_ROUTE);
    expect(counts.find((c) => c.file === LOGIN_ROUTE)?.sessionCalls).toBeGreaterThanOrEqual(1);
    // callback は code・token_hash・token のフォールバックの 3 つ
    expect(counts.find((c) => c.file === CALLBACK_ROUTE)?.sessionCalls).toBe(3);
  });

  it('走査そのもの: コメントの中の呼び出しは数えず、呼び忘れた分岐を数える', () => {
    expect(countOf('// await supabase.auth.verifyOtp(x)\n/* recordWebLoginContextFromRequest(a) */')).toEqual({ sessionCalls: 0, recordCalls: 0 });
    expect(
      countOf(
        'const a = await supabase.auth.exchangeCodeForSession(c)\nif (!a.error) await recordWebLoginContextFromRequest(s, h, a.data.session)\n' +
          "const b = await supabase.auth.verifyOtp({ token_hash: 'http://x' })\n",
      ),
    ).toEqual({ sessionCalls: 2, recordCalls: 1 });
  });
});
