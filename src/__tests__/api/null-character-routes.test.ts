/**
 * 利用者が自由に書ける欄を持つ route の、本文の NULL 文字 (U+0000) の 400 (#1657)
 *
 * Postgres の text / jsonb は U+0000 を受け付けないので、本文の文字列 (メモ・名前・自由記述・AI への入力) に NULL 文字があると、
 * insert / update / upsert / rpc で DB が拒んで 500 になっていた (#1622 で POST /api/ai/menu/weekly/request だけ直した)。
 * 下の表の route は、handler の最初 (認証・DB に触れる前) に rejectNullCharacterBody で 400 INVALID_CHARACTER を返す。
 *
 * - 表の各 route: NULL 文字があれば 400 INVALID_CHARACTER を返し、Supabase のクライアントを作らない (DB に触れない)
 * - 表の各 route: NULL 文字が無ければ断らない (入口を通って、その先の処理に進む)
 * - 表と実コードの一致: rejectNullCharacterBody を呼ぶ route のファイル・メソッドが、表とちょうど同じ
 *   (表に無い route で呼んでいる・表にある route で呼ばなくなった、のどちらも見つける)
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NULL_CHARACTER_ERROR_CODE, NULL_CHARACTER_ERROR_MESSAGE } from '@/lib/api/null-character';
import { applyHeavyUnitTestTimeout } from '../../../tests/helpers/heavy-unit-test-timeout';

// テストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れを超えうる。このファイルだけ延ばす
// (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts。#1605)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const mockCreateClient = vi.fn(async () => {
  throw new Error('Supabase のクライアントは、NULL 文字の確かめのあとでしか作られないはず');
});
vi.mock('@/lib/supabase/server', () => ({ createClient: mockCreateClient }));

const NUL = '\u0000';
const SAMPLE_UUID = '00000000-0000-4000-8000-000000000001';
const SAMPLE_DATE = '2026-01-05';

/** 動的な区間 ([id] など) を持つ route に渡す params (どの route の区間の名前も満たす) */
type RouteParams = { id: string; sessionId: string; date: string };
type RouteHandler = (request: NextRequest, context: { params: Promise<RouteParams> }) => Promise<Response>;

type Entry = {
  /** src/app/api からの route のファイル */
  file: string;
  method: 'POST' | 'PUT' | 'PATCH';
  load: () => Promise<RouteHandler>;
};

const ENTRIES: Entry[] = [
  { file: 'ai/consultation/sessions/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/consultation/sessions/route')).POST },
  { file: 'ai/consultation/sessions/[sessionId]/messages/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route')).POST },
  { file: 'ai/menu/day/regenerate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/day/regenerate/route')).POST },
  { file: 'ai/menu/meal/generate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/meal/generate/route')).POST },
  { file: 'ai/menu/meal/regenerate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/meal/regenerate/route')).POST },
  { file: 'ai/menu/v4/generate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/v4/generate/route')).POST },
  { file: 'ai/menu/v5/generate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/v5/generate/route')).POST },
  { file: 'ai/nutrition-analysis/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/nutrition-analysis/route')).POST },
  { file: 'contact/route.ts', method: 'POST', load: async () => (await import('@/app/api/contact/route')).POST },
  { file: 'family/groups/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/groups/route')).POST },
  { file: 'family/members/child/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/members/child/route')).POST },
  { file: 'family/invites/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/invites/route')).POST },
  { file: 'health/goals/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/goals/route')).POST },
  { file: 'health/goals/[id]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/health/goals/[id]/route')).PUT },
  { file: 'health/records/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/records/route')).POST },
  { file: 'health/records/[date]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/health/records/[date]/route')).PUT },
  { file: 'health/checkups/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/checkups/route')).POST },
  { file: 'health/checkups/[id]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/health/checkups/[id]/route')).PUT },
  { file: 'health/blood-tests/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/blood-tests/route')).POST },
  { file: 'meal-plans/meals/route.ts', method: 'POST', load: async () => (await import('@/app/api/meal-plans/meals/route')).POST },
  { file: 'meal-plans/meals/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/meal-plans/meals/[id]/route')).PATCH },
  { file: 'meal-plans/add-from-photo/route.ts', method: 'POST', load: async () => (await import('@/app/api/meal-plans/add-from-photo/route')).POST },
  { file: 'meals/route.ts', method: 'POST', load: async () => (await import('@/app/api/meals/route')).POST },
  { file: 'meals/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/meals/[id]/route')).PATCH },
  { file: 'menu-plans/add/route.ts', method: 'POST', load: async () => (await import('@/app/api/menu-plans/add/route')).POST },
  { file: 'pantry/route.ts', method: 'POST', load: async () => (await import('@/app/api/pantry/route')).POST },
  { file: 'pantry/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/pantry/[id]/route')).PATCH },
  { file: 'pantry/from-photo/route.ts', method: 'POST', load: async () => (await import('@/app/api/pantry/from-photo/route')).POST },
  { file: 'performance/checkins/route.ts', method: 'POST', load: async () => (await import('@/app/api/performance/checkins/route')).POST },
  { file: 'profile/route.ts', method: 'POST', load: async () => (await import('@/app/api/profile/route')).POST },
  { file: 'profile/route.ts', method: 'PUT', load: async () => (await import('@/app/api/profile/route')).PUT },
  { file: 'recipes/route.ts', method: 'POST', load: async () => (await import('@/app/api/recipes/route')).POST },
  { file: 'recipes/[id]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/recipes/[id]/route')).PUT },
  { file: 'recipes/[id]/comments/route.ts', method: 'POST', load: async () => (await import('@/app/api/recipes/[id]/comments/route')).POST },
  { file: 'shopping-list/route.ts', method: 'POST', load: async () => (await import('@/app/api/shopping-list/route')).POST },
  { file: 'shopping-list/add-recipe/route.ts', method: 'POST', load: async () => (await import('@/app/api/shopping-list/add-recipe/route')).POST },
  { file: 'onboarding/progress/route.ts', method: 'POST', load: async () => (await import('@/app/api/onboarding/progress/route')).POST },
  { file: 'org/settings/route.ts', method: 'PUT', load: async () => (await import('@/app/api/org/settings/route')).PUT },
];

const API_ROOT = path.resolve(__dirname, '../../app/api');

function makeRequest(method: Entry['method'], body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/null-character-test', {
    method,
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  });
}

function makeContext(): { params: Promise<RouteParams> } {
  return { params: Promise.resolve({ id: SAMPLE_UUID, sessionId: SAMPLE_UUID, date: SAMPLE_DATE }) };
}

/** 自由に書ける欄の名前をいくつか並べた本文 (route ごとの欄の名前を追わなくても、どれかの欄に NULL 文字が入る) */
function freeTextBody(text: string): Record<string, unknown> {
  return {
    note: text,
    name: text,
    title: text,
    content: text,
    message: text,
    memo: text,
    dishes: [{ name: text }],
    ingredients: [{ name: text, amount: '1' }],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe.each(ENTRIES)('$method /api/$file (#1657)', (entry) => {
  it('本文に NULL 文字があれば、DB に触れる前に 400 INVALID_CHARACTER を返す', async () => {
    const handler = await entry.load();
    const res = await handler(makeRequest(entry.method, freeTextBody(`メモ${NUL}`)), makeContext());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('本文に NULL 文字が無ければ入口では断らない (その先の処理に進む)', async () => {
    const handler = await entry.load();
    // この先の処理は Supabase のクライアントを作れずに失敗する (例外か 4xx / 5xx)。ここでは NULL 文字の 400 でないことだけを見る
    const res = await handler(makeRequest(entry.method, freeTextBody('ふつうのメモ')), makeContext()).catch(() => null);
    if (res !== null) {
      const json: unknown = await res.json().catch(() => null);
      expect(json).not.toEqual(expect.objectContaining({ code: NULL_CHARACTER_ERROR_CODE }));
    }
  });
});

/** handler の宣言 (export async function METHOD) から、次の handler の宣言の手前までのソース */
function handlerSources(source: string): Map<string, string> {
  const pattern = /^export async function (GET|POST|PUT|PATCH|DELETE)\(/gm;
  const starts: Array<{ method: string; index: number }> = [];
  for (const match of source.matchAll(pattern)) {
    starts.push({ method: match[1], index: match.index ?? 0 });
  }
  const result = new Map<string, string>();
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    result.set(start.method, source.slice(start.index, end));
  });
  return result;
}

function listRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) return listRouteFiles(full);
    return dirent.name === 'route.ts' ? [full] : [];
  });
}

describe('NULL 文字の入口の確かめを持つ route の一覧 (#1657)', () => {
  it('rejectNullCharacterBody を呼ぶ handler は、上の表の route とちょうど同じ', () => {
    const actual = listRouteFiles(API_ROOT).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      return [...handlerSources(source)]
        .filter(([, body]) => body.includes('await rejectNullCharacterBody(request)'))
        .map(([method]) => `${method} ${path.relative(API_ROOT, file).split(path.sep).join('/')}`);
    });
    const expected = ENTRIES.map((entry) => `${entry.method} ${entry.file}`);

    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('表の各 handler は、最初の文で本文を確かめる (認証・DB・ほかの処理より前)', () => {
    for (const entry of ENTRIES) {
      const source = fs.readFileSync(path.join(API_ROOT, entry.file), 'utf-8');
      const body = handlerSources(source).get(entry.method) ?? '';
      const codeLines = body
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('//') && !/^[{)]/.test(line) && !/^\w+: /.test(line));
      expect(codeLines[0], `${entry.method} ${entry.file}`).toMatch(/^const nullCharacterRejection = await rejectNullCharacterBody\(request\);?$/);
      expect(codeLines[1], `${entry.method} ${entry.file}`).toMatch(/^if \(nullCharacterRejection\) return nullCharacterRejection;?$/);
    }
  });
});
