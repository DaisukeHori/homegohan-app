/**
 * #1314 付与処理のあるバッジの許可リスト (src/lib/badges/awardable.ts) のソース走査 contract テスト
 *
 * GET /api/badges は、未獲得のバッジのうち、このリストに無いもの (付与処理が無く、獲得のしようが無いバッジ) を
 * 一覧から隠す。リストが実際の付与処理とずれると、次のどちらかになる。
 *   - リストにあるのに付与処理が無い → 取れないバッジが一覧に並び続ける (隠したかったもの)
 *   - 付与処理があるのにリストに無い → 取れるバッジが、獲得するまで一覧に出ない
 * そこで、ソースとマスターを読んで、リストと付与処理が合っていることを確かめる。
 *
 *   1. リストの各コードに、付与の経路がある。経路は次のどれか。
 *        - GET /api/badges が `badge.code === '<code>'` で判定している
 *        - `awardBadge(client, userId, '<code>')` を呼んでいる (src 配下。POST /api/menu-plans/add の planner など)
 *        - migration の SQL 関数が `FROM badges WHERE code = '<code>'` で引いて付与している (complete_handson_tour)
 *        - Edge Function calculate-segment-stats が、バッジの condition_json.type で拾って付与している
 *   2. リストの各コードが、badges マスター (本番スナップショット) に実在する (綴り違い・消えたバッジの検出)
 *   3. 上の経路があるコードは、リストに入っているか、オーナー判断待ちの保留リストにある (足し忘れの検出)
 *
 * 新しい付与処理を足したら、そのバッジのコードを awardable.ts に足す (3 が足し忘れを知らせる)。
 * リストに足したのに付与の経路が見つからないと、1 が落ちる。経路の書き方がここで拾える形でなければ、
 * 拾える形に寄せるか、このテストの経路の探し方に足す。
 * TypeScript は構文木で走査するので、コメントや文字列の中の `awardBadge(` には反応しない。
 *
 * 注意 (2026-10-08 確認): calculate-segment-stats がバッジを取る条件 `condition_json->type.eq.<値>` は、
 * PostgREST に 22P02 (invalid input syntax for type json) で拒否される (文字列で比べるなら `->>`)。戻り値の error を
 * 見ていないため、いまは実際には 1 つも付与されない。このテストは「付与の経路がコードにあるか」を見るので通るが、
 * 動いているかは別の話。直す (または一覧から外す) かはオーナー判断 (#1314 の残課題)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { AWARDABLE_BADGE_CODES, isAwardableBadgeCode } from '@/lib/badges/awardable';

const ROOT = path.resolve(__dirname, '..');

const BADGES_ROUTE = 'src/app/api/badges/route.ts';
const SEGMENT_STATS_FUNCTION = 'supabase/functions/calculate-segment-stats/index.ts';
const MASTER_SNAPSHOT = 'supabase/baseline/prod_reference_data.sql';
const MIGRATIONS_DIR = 'supabase/migrations';

/**
 * GET /api/badges が判定のコードを持っているが、いまは一覧に出さないバッジ。出すかどうかはオーナーの判断待ち (#1314)。
 * いまのマスターには行が無い。判断が出たら、リストに足すか、判定ごと消して、ここから外す。
 */
const PENDING_OWNER_DECISION = ['home_chef', 'master_chef', 'century'];

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────
function parseTs(relPath: string): ts.SourceFile {
  return ts.createSourceFile(
    relPath,
    read(relPath),
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

/** テストと __tests__ を除く、dir 配下の .ts / .tsx (プロジェクトルートからの相対パス) */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...sourceFiles(rel));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(rel);
    }
  }
  return files;
}

/** GET /api/badges が `badge.code === '<code>'` で判定しているコード */
function codesJudgedByBadgesRoute(): string[] {
  const codes = new Set<string>();
  const isBadgeCode = (expression: ts.Expression) =>
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'code' &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'badge';

  visit(parseTs(BADGES_ROUTE), (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return;
    if (isBadgeCode(node.left) && ts.isStringLiteralLike(node.right)) codes.add(node.right.text);
    if (isBadgeCode(node.right) && ts.isStringLiteralLike(node.left)) codes.add(node.left.text);
  });
  return [...codes];
}

/** `awardBadge(client, userId, '<code>')` で付与しているコード (src 配下) */
function codesAwardedByAwardBadgeCalls(): string[] {
  const codes = new Set<string>();
  for (const file of sourceFiles('src')) {
    if (!read(file).includes('awardBadge(')) continue;
    visit(parseTs(file), (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'awardBadge') return;
      const code = node.arguments[2];
      if (code && ts.isStringLiteralLike(code)) codes.add(code.text);
    });
  }
  return [...codes];
}

/** migration の SQL 関数が `FROM badges WHERE code = '<code>'` で引いて付与しているコード (complete_handson_tour など) */
function codesAwardedBySqlFunctions(): string[] {
  const codes = new Set<string>();
  for (const file of fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql'))) {
    const sql = read(path.posix.join(MIGRATIONS_DIR, file));
    for (const match of sql.matchAll(/FROM\s+(?:public\.)?"?badges"?\s+WHERE\s+code\s*=\s*'([a-z0-9_]+)'/gi)) {
      codes.add(match[1]);
    }
  }
  return [...codes];
}

/**
 * Edge Function calculate-segment-stats が付与する badges.condition_json.type。
 * `.or('condition_json->type.eq.<type>,...')` の文字列から読む (`->` でも `->>` でも拾う)。
 */
function segmentConditionTypes(): string[] {
  const types = [...read(SEGMENT_STATS_FUNCTION).matchAll(/condition_json->>?type\.eq\.([a-z_]+)/g)].map((m) => m[1]);
  return [...new Set(types)];
}

interface MasterBadge {
  code: string;
  conditionType: string | null;
}

/** badges マスターの本番スナップショット (supabase/baseline/prod_reference_data.sql の INSERT 文) */
function readBadgeMaster(): MasterBadge[] {
  return read(MASTER_SNAPSHOT)
    .split('\n')
    .filter((line) => line.startsWith('INSERT INTO public.badges '))
    .map((line) => {
      // VALUES ('<id>', '<code>', '<name>', '<description>', '<condition_json>', ...)
      const code = /VALUES \('[^']*', '([^']*)'/.exec(line)?.[1];
      if (!code) throw new Error(`badges の INSERT からコードを読めません: ${line.slice(0, 120)}`);
      const json = /'(\{[^']*\})'/.exec(line)?.[1];
      const parsed = json ? (JSON.parse(json) as { type?: unknown }) : null;
      return { code, conditionType: typeof parsed?.type === 'string' ? parsed.type : null };
    });
}

// ─────────────────────────────────────────────
// 検査
// ─────────────────────────────────────────────
const awardable: string[] = [...AWARDABLE_BADGE_CODES];
const master = readBadgeMaster();
const masterCodes = master.map((badge) => badge.code);
const segmentTypes = segmentConditionTypes();

/** コード → そのコードを付与する経路 (どこで見つけたか)。経路が 1 つも無いコードは入らない */
function findAwardPaths(): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const add = (code: string, label: string) => paths.set(code, [...(paths.get(code) ?? []), label]);

  for (const code of codesJudgedByBadgesRoute()) add(code, `GET /api/badges の判定 (${BADGES_ROUTE})`);
  for (const code of codesAwardedByAwardBadgeCalls()) add(code, 'awardBadge(...) の呼び出し (src)');
  for (const code of codesAwardedBySqlFunctions()) add(code, 'SQL 関数 (supabase/migrations)');
  for (const badge of master) {
    if (badge.conditionType && segmentTypes.includes(badge.conditionType)) {
      add(badge.code, `calculate-segment-stats (condition_json.type = ${badge.conditionType})`);
    }
  }
  return paths;
}

describe('AWARDABLE_BADGE_CODES (#1314)', () => {
  it('コードに重複が無い', () => {
    const duplicated = awardable.filter((code, index) => awardable.indexOf(code) !== index);
    expect(duplicated).toEqual([]);
  });

  it('isAwardableBadgeCode は、リストのコードだけ true を返す', () => {
    for (const code of awardable) {
      expect(isAwardableBadgeCode(code)).toBe(true);
    }
    for (const code of ['health_streak_7', 'early_bird', ...PENDING_OWNER_DECISION, '', 'no_such_badge']) {
      expect(isAwardableBadgeCode(code)).toBe(false);
    }
  });

  it('badges マスターのスナップショットと、付与の経路の探し方が壊れていない (壊れていると、以降の検査が空振りで通ってしまう)', () => {
    expect(master.length).toBeGreaterThanOrEqual(30);
    expect(masterCodes).toContain('first_bite');
    // badges.code は UNIQUE。同じコードが 2 行読めるときは、スナップショットの読み違い
    expect(new Set(masterCodes).size).toBe(masterCodes.length);

    const paths = findAwardPaths();
    // 既知の経路が、それぞれの探し方で見つかる
    expect(paths.get('first_bite')?.join()).toContain('GET /api/badges');
    expect(paths.get('planner')?.join()).toContain('awardBadge');
    expect(paths.get('tutorial_complete')?.join()).toContain('SQL 関数');
    expect(paths.get('segment_rank_1')?.join()).toContain('calculate-segment-stats');
    expect(segmentTypes.length).toBeGreaterThan(0);
  });

  it('リストの各コードに、付与の経路がある (付与できないバッジを一覧に出し続けない)', () => {
    const paths = findAwardPaths();
    const withoutPath = awardable.filter((code) => !paths.has(code));
    expect(
      withoutPath,
      `付与の経路が見つからないコードが AWARDABLE_BADGE_CODES にあります: ${withoutPath.join(', ')}。` +
        '付与処理を足すか、リストから外してください',
    ).toEqual([]);
  });

  it('リストの各コードが、badges マスターに実在する (綴り違い・消えたバッジの検出)', () => {
    const notInMaster = awardable.filter((code) => !masterCodes.includes(code));
    expect(notInMaster).toEqual([]);
  });

  it('付与の経路があるコードは、リストに入っているか、オーナー判断待ちの保留リストにある (足し忘れの検出)', () => {
    const paths = findAwardPaths();
    const unlisted = [...paths.keys()].filter((code) => !isAwardableBadgeCode(code) && !PENDING_OWNER_DECISION.includes(code));
    expect(
      unlisted,
      '付与の経路があるのに、AWARDABLE_BADGE_CODES にありません: ' +
        `${unlisted.map((code) => `${code} (${paths.get(code)?.join(' / ')})`).join(', ')}。` +
        'このままだと、獲得するまで一覧に出ません。awardable.ts に足してください',
    ).toEqual([]);
  });

  it('保留リスト (home_chef / master_chef / century) が古くならない: 判定はまだ route にあり、リストには入っていない', () => {
    const judged = codesJudgedByBadgesRoute();
    for (const code of PENDING_OWNER_DECISION) {
      expect(judged, `${code} の判定が route から消えています。保留リストから外してください`).toContain(code);
      expect(awardable, `${code} が AWARDABLE_BADGE_CODES に入りました。保留リストから外してください`).not.toContain(code);
    }
  });

  it('Edge Function は、拾う種類 (condition_json.type) ごとに、付与の条件を書いた分岐 (case) を持っている', () => {
    const functionSource = read(SEGMENT_STATS_FUNCTION);
    expect(segmentTypes.length).toBeGreaterThan(0);
    for (const type of segmentTypes) {
      expect(functionSource, `calculate-segment-stats に case '${type}': がありません`).toContain(`case '${type}':`);
    }
  });
});
