// @vitest-environment node
/**
 * #1148 機能フラグの一本化 contract テスト (ソース走査)
 *
 * 機能フラグの置き場は feature_flags テーブル (運営画面で切り替える) の 1 つにそろえた。判定は isFeatureEnabled
 * (src/lib/feature-flags.ts) に集める。次を、ソースを読んで確かめる。
 *
 *   1. 旧の読み込み処理 (src/lib/menu-generation-feature-flags.ts の loadFeatureFlags) が無く、どこからも使われていない
 *   2. system_settings を読む route は、システム設定の画面 (super-admin/settings) とアカウント削除だけ。
 *      フラグを system_settings から読む実装が戻ってこない
 *   3. feature_flags テーブルを直接読み書きするのは、判定の部品 (evaluate-flag.ts)・運営画面の API (super-admin/flags)・
 *      フラグ一覧の集計だけ。route ごとに自前で読まない (キャッシュ・既定値・失敗時の扱いをそろえるため)
 *   4. 献立生成の API 5 本と AI 相談のアクション実行は、isFeatureEnabled で正しいフラグを見る
 *      (v4/generate だけ menu_generation_v5_direct、ほかは menu_generation_v5_wrapped)
 *   5. AI 相談の緊急停止スイッチ (ai_chat_enabled): 止めるのは決めた 5 つの POST だけ。認証のあと・レート制限の前に呼ぶ。
 *      GET・DELETE・重要マークなど AI を呼ばない API は止めない
 *   6. ミドルウェアは maintenance_mode を見る
 *
 * 振る舞いそのものの確認は、それぞれの単体テスト・結合テストにある。ここは「別の読み方が増えていないか」の安全網。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

const rawCache = new Map<string, string>();

function read(file: string): string {
  let text = rawCache.get(file);
  if (text === undefined) {
    text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    rawCache.set(file, text);
  }
  return text;
}

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', '__tests__'].includes(entry.name)) continue;
      walk(rel, accept, out);
    } else if (accept(rel)) {
      out.push(rel);
    }
  }
  return out;
}

const isSource = (file: string) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file);

const codeCache = new Map<string, string>();

/** コメントを除いたソース (コメントの中の言及で誤検知しないため)。重いので、必要なファイルだけに使う */
function code(file: string): string {
  let text = codeCache.get(file);
  if (text === undefined) {
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    text = ts.createPrinter({ removeComments: true }).printFile(sf);
    codeCache.set(file, text);
  }
  return text;
}

const WEB_SOURCES = [...walk('src', isSource), ...walk('lib', isSource)];

/** 全ソースから、コメントを除いても pattern に当たるものを探す (先に素のテキストで絞ってから、コメントを除いて確かめる) */
function sourcesMatching(pattern: RegExp): string[] {
  return WEB_SOURCES.filter((file) => pattern.test(read(file))).filter((file) => pattern.test(code(file)));
}

describe('#1148 1. 旧の読み込み処理は無い', () => {
  it('src/lib/menu-generation-feature-flags.ts は削除されている', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/lib/menu-generation-feature-flags.ts'))).toBe(false);
  });

  it('loadFeatureFlags / menu-generation-feature-flags を参照するソースは無い', () => {
    expect(sourcesMatching(/loadFeatureFlags|menu-generation-feature-flags/)).toEqual([]);
  });
});

describe('#1148 2. system_settings からフラグを読まない', () => {
  it('system_settings を読む・書くソースは、システム設定の API とアカウント削除だけ', () => {
    const readers = sourcesMatching(/from\(\s*['"`]system_settings['"`]\s*\)/).sort();
    expect(readers).toEqual([
      'src/app/api/account/delete/route.ts',
      'src/app/api/super-admin/settings/route.ts',
    ]);
  });
});

describe('#1148 3. feature_flags テーブルを直接触るのは決まった場所だけ', () => {
  it('判定の部品・運営画面の API だけが feature_flags を読み書きする', () => {
    const accessors = sourcesMatching(/from\(\s*['"`]feature_flags['"`]\s*\)/).sort();
    expect(accessors).toEqual([
      'src/app/api/super-admin/flags/[key]/route.ts',
      'src/app/api/super-admin/flags/route.ts',
      'src/lib/super-admin/evaluate-flag.ts',
    ]);
  });

  it('isFeatureEnabled を使うソースは、feature-flags.ts から import している', () => {
    const users = sourcesMatching(/\bisFeatureEnabled\s*\(/).filter((file) => file !== 'src/lib/feature-flags.ts');
    expect(users.length).toBeGreaterThan(5); // 走査が空振りしていないこと
    for (const file of users) {
      const text = code(file);
      expect(text, `${file} は isFeatureEnabled を '@/lib/feature-flags' から import する`).toMatch(
        /import\s*\{[^}]*\bisFeatureEnabled\b[^}]*\}\s*from\s*['"]@\/lib\/feature-flags['"]/,
      );
    }
  });
});

describe('#1148 4. 献立生成のエンジン切り替えは isFeatureEnabled', () => {
  const WRAPPED = [
    'src/app/api/ai/menu/weekly/request/route.ts',
    'src/app/api/ai/menu/day/regenerate/route.ts',
    'src/app/api/ai/menu/meal/generate/route.ts',
    'src/app/api/ai/menu/meal/regenerate/route.ts',
    'src/lib/ai/consultation-action-executor.ts',
  ];
  const DIRECT = ['src/app/api/ai/menu/v4/generate/route.ts'];

  it.each(WRAPPED)('%s は menu_generation_v5_wrapped を、認証したユーザーの ID で見る', (file) => {
    const text = code(file);
    expect(text).toMatch(/isFeatureEnabled\(\s*['"]menu_generation_v5_wrapped['"]\s*,\s*user\.id\s*\)/);
    expect(text).not.toMatch(/menu_generation_v5_direct/);
  });

  it.each(DIRECT)('%s は menu_generation_v5_direct を、認証したユーザーの ID で見る', (file) => {
    const text = code(file);
    expect(text).toMatch(/isFeatureEnabled\(\s*['"]menu_generation_v5_direct['"]\s*,\s*user\.id\s*\)/);
    expect(text).not.toMatch(/menu_generation_v5_wrapped/);
  });
});

describe('#1148 5. AI 相談の緊急停止スイッチ (ai_chat_enabled)', () => {
  /** 止めるのは、AI に送る・AI が提案した操作を実行する POST だけ */
  const GATED: Record<string, string[]> = {
    'src/app/api/ai/consultation/sessions/route.ts': ['POST'],
    'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': ['POST'],
    'src/app/api/ai/consultation/sessions/[sessionId]/summarize/route.ts': ['POST'],
    'src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts': ['POST'],
    'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': ['POST'],
  };

  interface HandlerFacts {
    name: string;
    gatePos: number | null;
    authPos: number | null;
    rateLimitPos: number | null;
  }

  function handlersOf(file: string): HandlerFacts[] {
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const facts: HandlerFacts[] = [];
    for (const statement of sf.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
      const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(statement.name.text)) continue;

      const fact: HandlerFacts = { name: statement.name.text, gatePos: null, authPos: null, rateLimitPos: null };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (ts.isIdentifier(callee) && callee.text === 'aiChatDisabledResponse') {
            fact.gatePos ??= node.getStart(sf);
          }
          if (ts.isIdentifier(callee) && callee.text === 'checkRateLimit') {
            fact.rateLimitPos ??= node.getStart(sf);
          }
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'getUser') {
            fact.authPos ??= node.getStart(sf);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(statement.body);
      facts.push(fact);
    }
    return facts;
  }

  it.each(Object.entries(GATED))('%s は、決めたハンドラ (%j) だけが aiChatDisabledResponse を呼ぶ', (file, methods) => {
    const handlers = handlersOf(file);
    const gated = handlers.filter((h) => h.gatePos !== null).map((h) => h.name).sort();
    expect(gated).toEqual([...methods].sort());
  });

  it.each(Object.entries(GATED))('%s は、認証のあと・レート制限の前にスイッチを見る', (file, methods) => {
    for (const handler of handlersOf(file).filter((h) => methods.includes(h.name))) {
      expect(handler.authPos, `${file} ${handler.name}: 認証`).not.toBeNull();
      expect(handler.gatePos, `${file} ${handler.name}: スイッチ`).not.toBeNull();
      expect(handler.gatePos!, `${file} ${handler.name}: 認証のあとにスイッチ`).toBeGreaterThan(handler.authPos!);
      if (handler.rateLimitPos !== null) {
        expect(handler.gatePos!, `${file} ${handler.name}: レート制限の前にスイッチ`).toBeLessThan(handler.rateLimitPos);
      }
    }
  });

  it('スイッチは ai_chat_enabled を、認証したユーザーの ID で見る', () => {
    const gate = code('src/lib/ai/ai-chat-gate.ts');
    expect(gate).toMatch(/AI_CHAT_FLAG_KEY\s*=\s*['"]ai_chat_enabled['"]/);
    expect(gate).toMatch(/isFeatureEnabled\(\s*AI_CHAT_FLAG_KEY\s*,\s*userId\s*\)/);
  });

  it('それ以外の AI 相談の API (閲覧・却下・重要マーク) は、スイッチを見ない', () => {
    const others = walk('src/app/api/ai/consultation', (file) => /route\.ts$/.test(file));
    for (const file of others) {
      const gatedMethods = GATED[file] ?? [];
      for (const handler of handlersOf(file)) {
        if (gatedMethods.includes(handler.name)) continue;
        expect(handler.gatePos, `${file} ${handler.name} は止めない`).toBeNull();
      }
    }
  });
});

describe('#1148 6. ミドルウェアは maintenance_mode を見る', () => {
  it('lib/supabase/middleware.ts が maintenance-mode の判定を使い、フラグの key は maintenance_mode', () => {
    const middleware = code('lib/supabase/middleware.ts');
    expect(middleware).toMatch(/from\s*['"]@\/lib\/maintenance-mode['"]/);
    expect(middleware).toMatch(/isMaintenanceFlagOn\(/);
    expect(middleware).toMatch(/isMaintenanceExemptPath\(/);
    expect(code('src/lib/maintenance-mode.ts')).toMatch(/MAINTENANCE_FLAG_KEY\s*=\s*['"]maintenance_mode['"]/);
  });
});

describe('#1148 7. migration', () => {
  it('feature_flags に最初の行を入れる migration と、その rollback が対になっている', () => {
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.startsWith('20261010120000_'));
    const rollbacks = fs.readdirSync(path.join(ROOT, 'supabase/rollbacks')).filter((f) => f.startsWith('20261010120000_'));
    expect(migrations).toEqual(['20261010120000_unify_feature_flags_seed.sql']);
    expect(rollbacks).toEqual(['20261010120000_unify_feature_flags_seed.down.sql']);
  });

  it('migration と rollback が、同じ 4 つのフラグと、同じ description を書いている', () => {
    const migration = read('supabase/migrations/20261010120000_unify_feature_flags_seed.sql');
    const rollback = read('supabase/rollbacks/20261010120000_unify_feature_flags_seed.down.sql');
    const keys = ['ai_chat_enabled', 'maintenance_mode', 'menu_generation_v5_wrapped', 'menu_generation_v5_direct'];
    for (const key of keys) {
      expect(migration).toContain(`'${key}'`);
      expect(rollback).toContain(`'${key}'`);
    }
    // description (「 ... (#1148 で作成...)」の文字列) が、migration と rollback で一字一句同じ
    const descriptions = (sql: string) =>
      [...sql.matchAll(/'([^'\n]*#1148 で作成[^'\n]*)'/g)].map((m) => m[1]).sort();
    expect(descriptions(migration)).toHaveLength(4);
    expect(descriptions(rollback)).toEqual(descriptions(migration));
  });
});
