/**
 * #1465 AI のキュー (weekly_menu_requests / meal_image_jobs) への書き込みは、service role (getAiQueueWriter) からだけ
 *
 * 2 つの表は、利用者 (authenticated) から書けない (migration 20261011010000_ai_queue_service_role_writes.sql。
 * 実 DB での確認は tests/integration/rls/ai-queue-writes.test.ts、migration の読み取りは tests/ai-usage-contract.test.ts)。
 * 利用者のセッションのクライアントで書くと、権限で拒まれる。キューの関数 (enqueueMealImageJobs など) はエラーを返すだけで
 * 投げないので、間違えると「画像が作られない」「失敗が記録されない」が黙って起きる。このテストは、ソースから次を確かめる。
 *
 *   1. 画面 ('use client' のファイル)・モバイル (apps/mobile) は、2 つの表に書かない
 *   2. サーバーのコードの書き込み (.from('<表>').insert / update / upsert / delete) の受け手は、
 *      queueDb (= getAiQueueWriter()) か、service role のクライアントを受け取る決まった箇所 (ALLOWED_RECEIVERS) だけ
 *   3. キューの関数 (enqueueMealImageJobs / cancelPendingMealImageJobs / markWeeklyMenuRequestFailed) の呼び出しは、
 *      supabase に queueDb を渡す。取り消し (cancelPendingMealImageJobs) は userId で本人の行に絞る
 *   4. queueDb は getAiQueueWriter() だけから作る (Edge Function は service role の鍵で作る)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_QUEUE_TABLES } from '../src/lib/ai/ai-queue-tables';
import { ROOT, rel, stripComments } from './helpers/ai-reach';

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', '.expo', 'dist', 'build', '__tests__', '__mocks__']);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name)));
    } else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Next.js・共有のライブラリ・モバイルのソース (Edge Function は別に見る) */
const APP_DIRS = ['src', 'lib', 'shared', 'packages', 'apps/mobile/app', 'apps/mobile/src'];
const appFiles = APP_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).map(rel).sort();
const edgeFiles = walk(path.join(ROOT, 'supabase/functions')).map(rel).sort();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const TABLE_ALTERNATION = AI_QUEUE_TABLES.join('|');

interface QueueWrite {
  receiver: string;
  table: string;
  op: string;
}

/** 2 つの表への書き込み (.from('<表>') の直後の insert / update / upsert / delete) と、その受け手 */
function findQueueWrites(source: string): QueueWrite[] {
  const text = stripComments(source);
  const pattern = new RegExp(
    `([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*\\.from\\(\\s*['"\`](${TABLE_ALTERNATION})['"\`]\\s*\\)\\s*\\.(insert|update|upsert|delete)\\(`,
    'g',
  );
  return [...text.matchAll(pattern)].map((m) => ({ receiver: m[1], table: m[2], op: m[3] }));
}

/** 表の名前を文字列で書かずに .from(変数) で書いている箇所 (上の検査をすり抜ける) のうち、変数の値が 2 つの表になりうるもの */
function dynamicFromOfQueue(source: string): boolean {
  const text = stripComments(source);
  return new RegExp(`\\.from\\(\\s*\`[^\`]*(${TABLE_ALTERNATION})`).test(text);
}

const QUEUE_HELPERS = ['enqueueMealImageJobs', 'cancelPendingMealImageJobs', 'markWeeklyMenuRequestFailed'] as const;

/** キューの関数の呼び出し (引数の括弧の中の文字)。定義 (function 名) と import は除く */
function findHelperCalls(source: string): Array<{ helper: string; args: string }> {
  const text = stripComments(source);
  const calls: Array<{ helper: string; args: string }> = [];
  for (const helper of QUEUE_HELPERS) {
    for (const match of text.matchAll(new RegExp(`(?<!function\\s)\\b${helper}\\(`, 'g'))) {
      const open = match.index! + match[0].length - 1;
      let depth = 0;
      let end = open;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth += 1;
        else if (text[end] === ')' && --depth === 0) break;
      }
      calls.push({ helper, args: text.slice(open + 1, end) });
    }
  }
  return calls;
}

/**
 * queueDb 以外で、2 つの表に書いてよい受け手 (service role のクライアントを受け取る決まった箇所)。
 * ファイル → 受け手の名前と、そのクライアントが service role である理由
 */
const ALLOWED_RECEIVERS: Record<string, { receiver: string; serviceRoleEvidence: RegExp }> = {
  // キューの関数の本体。呼び出し側が queueDb を渡すことは、下の「キューの関数の呼び出し」が確かめる
  'lib/meal-image-jobs.ts': { receiver: 'params.supabase', serviceRoleEvidence: /export async function cancelPendingMealImageJobs/ },
  'src/lib/generate-menu-v4-retry.ts': { receiver: 'params.supabase', serviceRoleEvidence: /export async function markWeeklyMenuRequestFailed/ },
  // Vercel Cron。service role の鍵でクライアントを作る
  'src/app/api/cron/process-menu-queue/route.ts': {
    receiver: 'supabase',
    serviceRoleEvidence: /const supabase = createClient\(supabaseUrl, serviceRoleKey\)/,
  },
};

const isClientComponent = (source: string) => /^\s*['"]use client['"]/.test(source);
const isMobile = (file: string) => file.startsWith('apps/mobile/');

describe('AI のキューへの書き込みは service role だけ (#1465)', () => {
  it('走査が対象のファイルを見ている (route・モバイルの画面を含む)', () => {
    expect(appFiles).toContain('src/app/api/ai/menu/v5/generate/route.ts');
    expect(appFiles).toContain('apps/mobile/app/meals/new.tsx');
    expect(appFiles).toContain('lib/meal-image-jobs.ts');
    expect(appFiles.some((file) => file.includes('node_modules'))).toBe(false);
    // 書き込みは 1 つ以上見つかる (検出の正規表現が壊れていない)
    expect(appFiles.flatMap((file) => findQueueWrites(read(file))).length).toBeGreaterThan(10);
  });

  it('画面 (use client)・モバイルは、2 つの表に書かない (読むのはよい)', () => {
    const offenders = appFiles
      .filter((file) => isMobile(file) || isClientComponent(read(file)))
      .flatMap((file) => findQueueWrites(read(file)).map((w) => `${file}: ${w.receiver}.from('${w.table}').${w.op}`));
    expect(offenders, '画面・モバイルからは API ルートを呼ぶこと (route が service role で書く)').toEqual([]);
  });

  it('サーバーのコードの書き込みの受け手は queueDb か、決まった service role のクライアントだけ', () => {
    const offenders: string[] = [];
    for (const file of appFiles) {
      const source = read(file);
      for (const write of findQueueWrites(source)) {
        if (write.receiver === 'queueDb') continue;
        const allowed = ALLOWED_RECEIVERS[file];
        if (allowed && allowed.receiver === write.receiver) continue;
        offenders.push(`${file}: ${write.receiver}.from('${write.table}').${write.op}`);
      }
    }
    expect(
      offenders,
      '利用者のセッションのクライアントでは書けない。本人の確認のあとで const queueDb = getAiQueueWriter() を作り、queueDb で書くこと',
    ).toEqual([]);
  });

  it('決まった受け手のファイルは、いまも service role のクライアントを受け取る形のまま', () => {
    for (const [file, { serviceRoleEvidence }] of Object.entries(ALLOWED_RECEIVERS)) {
      expect(read(file), file).toMatch(serviceRoleEvidence);
    }
  });

  it('表の名前を変数やテンプレートで書いて、2 つの表に書いていない', () => {
    expect(appFiles.filter((file) => dynamicFromOfQueue(read(file)))).toEqual([]);
  });

  it('queueDb は getAiQueueWriter() だけから作る', () => {
    const offenders: string[] = [];
    for (const file of appFiles) {
      const text = stripComments(read(file));
      for (const match of text.matchAll(/\bqueueDb\s*(?::[^=]+)?=\s*([^;\n]+)/g)) {
        if (match[1].trim() !== 'getAiQueueWriter()') offenders.push(`${file}: queueDb = ${match[1].trim()}`);
      }
      if (findQueueWrites(text).some((w) => w.receiver === 'queueDb') && !/\bconst queueDb = getAiQueueWriter\(\)/.test(text)) {
        offenders.push(`${file}: queueDb で書いているのに getAiQueueWriter() で作っていない`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('キューの関数の呼び出しは、supabase に queueDb を渡す。取り消しは userId で本人の行に絞る', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const file of appFiles) {
      for (const { helper, args } of findHelperCalls(read(file))) {
        calls += 1;
        if (!/\bsupabase:\s*queueDb\b/.test(args)) offenders.push(`${file}: ${helper} の supabase が queueDb でない`);
        if (helper === 'cancelPendingMealImageJobs' && !/\buserId\s*[:,}]/.test(args)) offenders.push(`${file}: ${helper} に userId が無い`);
      }
    }
    expect(calls, '走査が呼び出しを見つけていない').toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it('Edge Function: 取り消し (cancelPendingMealImageJobs) は userId で本人の行に絞り、ユーザーの JWT の関数は service role の鍵で作ったクライアントで書く', () => {
    const offenders: string[] = [];
    for (const file of edgeFiles) {
      const source = read(file);
      for (const { helper, args } of findHelperCalls(source)) {
        if (helper === 'cancelPendingMealImageJobs' && !/\buserId\s*[:,}]/.test(args)) offenders.push(`${file}: ${helper} に userId が無い`);
      }
    }
    expect(offenders).toEqual([]);
    // 写真の解析 (ユーザーの JWT で呼ばれる) は、取り消しを service role のクライアント (queueDb) で行う
    const analyze = stripComments(read('supabase/functions/analyze-meal-photo/index.ts'));
    expect(analyze).toMatch(/const queueDb = createClient\(\s*Deno\.env\.get\('SUPABASE_URL'\) \?\? '',\s*Deno\.env\.get\('SERVICE_ROLE_JWT'\) \?\? Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
    expect(findHelperCalls(analyze).filter((c) => c.helper === 'cancelPendingMealImageJobs').map((c) => /\bsupabase:\s*queueDb\b/.test(c.args))).toEqual([true]);
  });
});

describe('検査そのものの確かめ (#1465)', () => {
  it('書き込みの検出: 受け手・表・操作を拾い、読み取りとコメントは拾わない', () => {
    const source = `
      await supabase
        .from('weekly_menu_requests')
        .update({ status: 'failed' });
      await queueDb.from("meal_image_jobs").upsert(rows);
      await params.supabase.from('meal_image_jobs').delete();
      await supabase.from('weekly_menu_requests').select('id');
      // await sb.from('meal_image_jobs').update({});
      await supabase.from('weekly_menu_requests_archive').insert({});
    `;
    expect(findQueueWrites(source)).toEqual([
      { receiver: 'supabase', table: 'weekly_menu_requests', op: 'update' },
      { receiver: 'queueDb', table: 'meal_image_jobs', op: 'upsert' },
      { receiver: 'params.supabase', table: 'meal_image_jobs', op: 'delete' },
    ]);
  });

  it('回帰: route の書き込みを利用者のクライアント (supabase) に戻すと、受け手の検査に引っかかる', () => {
    const file = 'src/app/api/ai/menu/v5/generate/route.ts';
    const mutated = read(file).replace(/await queueDb\s*\.from\('weekly_menu_requests'\)/, "await supabase\n      .from('weekly_menu_requests')");
    expect(mutated).not.toBe(read(file));
    expect(findQueueWrites(mutated).some((w) => w.receiver === 'supabase' && w.table === 'weekly_menu_requests')).toBe(true);
  });

  it('キューの関数の呼び出しの検出: 引数の中身を返し、定義は拾わない', () => {
    const source = `
      export async function cancelPendingMealImageJobs(params: { supabase: any }) {}
      await cancelPendingMealImageJobs({ supabase: queueDb, userId: user.id, plannedMealId: id });
      await markWeeklyMenuRequestFailed({ supabase, requestId: id, errorMessage: msg(x) });
    `;
    expect(findHelperCalls(source)).toEqual([
      { helper: 'cancelPendingMealImageJobs', args: '{ supabase: queueDb, userId: user.id, plannedMealId: id }' },
      { helper: 'markWeeklyMenuRequestFailed', args: '{ supabase, requestId: id, errorMessage: msg(x) }' },
    ]);
  });
});
