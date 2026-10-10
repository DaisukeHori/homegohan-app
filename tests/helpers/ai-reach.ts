/**
 * テスト用: AI 事業者へ送るコードに届くかの検出器 (1 つだけ。#1154 の同意の判定と #1177 の利用回数の記録が共用する)
 *
 * 使うテスト:
 *   - tests/ai-consent-enforcement.test.ts : 入口の棚卸し (AI に届く入口は、すべて tests/helpers/ai-consent-enforced-paths.ts の一覧にある)
 *   - tests/ai-usage-contract.test.ts      : 一覧の usage の列と、実際に記録を呼ぶ場所・公開ハンドラの突き合わせ
 *
 * 検出のしかた: ファイルの本文 (コメントを除く) に AI の印 (提供元の URL・SDK・API キーの環境変数・Edge Function の呼び出し) があるか、
 * import (相対パスと @/) をたどった先にあれば「AI に届く」。ファイル単位で、関数や分岐は区別しない
 * (届かないものを届くとみなすことはあるが、その逆は無い方向に倒す。どの分岐・ハンドラが送るかは、実際に route を動かす表
 * tests/ai-consent-enforcement-routes.test.ts が確かめる)。
 */
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');

export const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

/**
 * AI の印。提供元の URL・SDK の import・API キーの環境変数の読み取り・Edge Function の呼び出し・AI を呼ぶ共通部品の名前
 */
export const AI_LEAF_PATTERN = new RegExp(
  [
    // 提供元の URL
    'api\\.openai\\.com',
    'generativelanguage\\.googleapis\\.com',
    'api\\.x\\.ai',
    'api\\.perplexity\\.ai',
    'api\\.aimlapi\\.com',
    'api\\.anthropic\\.com',
    // SDK
    '@google/genai',
    "from ['\"](?:npm:)?openai(?:@[^'\"]*)?['\"]",
    '@openai/agents',
    '@anthropic-ai/sdk',
    // API キーの環境変数の読み取り (Next.js の process.env と Edge Functions の Deno.env.get)
    '(?:process\\.env\\.|Deno\\.env\\.get\\(\\s*[\'"])(?:OPENAI|XAI|GOOGLE_AI_STUDIO|GOOGLE_GEN_AI|GEMINI|ANTHROPIC|PERPLEXITY|AIMLAPI)_API_KEY',
    // Edge Function の呼び出し (AI を使う関数がほとんど。AI を使わない関数を呼ぶ route は、理由つきで除外の一覧に載せる)
    'functions/v1/',
    'functions\\.invoke\\(',
    // AI を呼ぶ共通部品
    'dataset-embedding\\.mjs',
    'getFastLLM',
    'createFastLLMClient',
    'callV4FastLLM',
    'generateGeminiJson',
  ].join('|'),
);

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.mjs'];

function firstFile(base: string): string | null {
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
  }
  return null;
}

export function resolveImport(from: string, spec: string): string | null {
  if (spec.startsWith('@/')) {
    for (const prefix of ['src', '.']) {
      const found = firstFile(path.join(ROOT, prefix, spec.slice(2)));
      if (found) return found;
    }
    return null;
  }
  if (spec.startsWith('.')) return firstFile(path.resolve(path.dirname(from), spec));
  return null;
}

/** コメントを外す (コメントに書いた送信先の説明で、送っていないファイルを送るものと数えないため。https:// の // は残す) */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** ファイルから import (相対パスと @/) をたどって、AI の印に届くか */
export function reachesAi(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const raw = readIfExists(file);
  if (raw === null) return false;
  const text = stripComments(raw);
  if (AI_LEAF_PATTERN.test(text)) return true;
  for (const match of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved && reachesAi(resolved, seen)) return true;
  }
  return false;
}

/** ディレクトリの下のファイル (再帰) */
export function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, accept));
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

/** route ハンドラのファイル。src/app 全体から集める (src/app/api の外にも route ハンドラは置ける) */
export function listRouteFiles(): string[] {
  return listFiles(path.join(ROOT, 'src/app'), (name) => name === 'route.ts' || name === 'route.tsx').map(rel).sort();
}

/** Edge Function の名前 (supabase/functions/<名前>/index.ts。_ で始まる共通部分は除く) */
export function listEdgeFunctions(): string[] {
  const dir = path.join(ROOT, 'supabase/functions');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && fs.existsSync(path.join(dir, e.name, 'index.ts')))
    .map((e) => e.name)
    .sort();
}

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * route ハンドラのファイルが公開しているハンドラ (GET / POST ...)。
 * export async function POST / export const POST = / export { x as POST } / export { POST } from '...' のどれも拾う
 */
export function exportedHandlers(source: string): HttpMethod[] {
  const text = stripComments(source);
  const found = new Set<HttpMethod>();
  const isMethod = (name: string): name is HttpMethod => (HTTP_METHODS as readonly string[]).includes(name);
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?|const|let|var)\s+([A-Z]+)\b/g)) {
    if (isMethod(m[1])) found.add(m[1]);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
      if (isMethod(name)) found.add(name);
    }
  }
  return HTTP_METHODS.filter((method) => found.has(method));
}
