/**
 * #2275 T2 モバイルの AI 相談の「作成の時間切れのあとに、読み直した一覧から作れていた相談を探す」判定
 * (apps/mobile/src/lib/ai-session-created-since.ts の sessionCreatedSince) が、Web の AI 相談 (src/components/AIChatBubble.tsx の
 * sessionCreatedSince。#2265 Q2・#2272 S2) と同じ結果を返すこと。
 *
 * モバイルはルートの src/ を import できない (.easignore が /src/ を除外する) ので、Web の判定を写して持つ。写しが Web からずれたら
 * (どちらかだけ判定を変えたら) ここで赤になる。Web の関数は画面のモジュールの中にあり (export していない)、読み込むと画面の依存まで
 * 要るので、ソースを TypeScript の構文木で読み、関数の宣言だけを JavaScript に変換して隔離した文脈で評価し、同じ入力で突き合わせる。
 *   1. 判定: 一覧の相談の並び × 見えていた相談の組み合わせで、Web とモバイルの選ぶ相談 (または無し) が一致する
 *   2. 写しが使われている: AIAdvisorSheet は判定を自分で持たず、この部品から読む
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sessionCreatedSince as mobileSessionCreatedSince } from '../apps/mobile/src/lib/ai-session-created-since';

const ROOT = path.resolve(__dirname, '..');
const WEB_CHAT_BUBBLE_PATH = 'src/components/AIChatBubble.tsx';
const ADVISOR_SHEET_PATH = 'apps/mobile/src/components/ai/AIAdvisorSheet.tsx';
const FUNCTION_NAME = 'sessionCreatedSince';

type Candidate = { id: string; title: string; messageCount: number; status?: string };
type CreatedSince = (sessions: readonly Candidate[], knownIds: ReadonlySet<string>) => Candidate | undefined;

/** Web の sessionCreatedSince を、宣言だけ取り出して評価した関数 */
function webSessionCreatedSince(): CreatedSince {
  const text = fs.readFileSync(path.join(ROOT, WEB_CHAT_BUBBLE_PATH), 'utf8');
  const source = ts.createSourceFile(WEB_CHAT_BUBBLE_PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === FUNCTION_NAME,
  );
  if (!declaration) throw new Error(`${WEB_CHAT_BUBBLE_PATH} に ${FUNCTION_NAME} が無い`);
  const { outputText } = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  });
  const context: { result?: unknown } = {};
  vm.runInNewContext(`${outputText}\nresult = ${FUNCTION_NAME};`, context);
  if (typeof context.result !== 'function') throw new Error(`${FUNCTION_NAME} を評価できない`);
  return context.result as CreatedSince;
}

const session = (id: string, messageCount: number, status?: string): Candidate => ({ id, title: 'AI相談', messageCount, status });

/** 一覧の相談の並び (更新の新しい順) */
const SESSION_LISTS: Record<string, readonly Candidate[]> = {
  空: [],
  '新しい空の相談だけ': [session('new', 0, 'active')],
  '状態の無い空の相談': [session('new', 0)],
  '終了した空の相談': [session('new', 0, 'closed')],
  'メッセージのある相談': [session('new', 1, 'active')],
  '見えていた空の相談と新しい空の相談': [session('known', 0, 'active'), session('new', 0, 'active')],
  '新しい空の相談が 2 つ (先頭を選ぶ)': [session('new', 0, 'active'), session('new-2', 0, 'active')],
  '終了・メッセージあり・新しい空の相談の順': [
    session('closed', 0, 'closed'),
    session('talked', 3, 'active'),
    session('new', 0, 'active'),
  ],
  'ほかの状態の空の相談': [session('new', 0, 'archived')],
};

/** 見えていた相談 (一覧に出た相談と、この画面で作れた相談) */
const KNOWN_ID_SETS: Record<string, ReadonlySet<string>> = {
  無し: new Set(),
  'known だけ': new Set(['known']),
  'new も見えていた': new Set(['known', 'new']),
  'new と new-2 も見えていた': new Set(['known', 'new', 'new-2']),
};

const CASES = Object.entries(SESSION_LISTS).flatMap(([listLabel, sessions]) =>
  Object.entries(KNOWN_ID_SETS).map(([knownLabel, knownIds]) => [listLabel, knownLabel, sessions, knownIds] as const),
);

describe('1. 判定が Web と一致する', () => {
  const web = webSessionCreatedSince();

  it.each(CASES)('一覧: %s / 見えていた相談: %s', (_listLabel, _knownLabel, sessions, knownIds) => {
    expect(mobileSessionCreatedSince(sessions, knownIds)).toBe(web(sessions, knownIds));
  });

  it('Web の判定が作れていた相談を選ぶ組み合わせと、選ばない組み合わせの両方を突き合わせている', () => {
    const results = CASES.map(([, , sessions, knownIds]) => web(sessions, knownIds));
    expect(results.some((result) => result !== undefined)).toBe(true);
    expect(results.some((result) => result === undefined)).toBe(true);
  });
});

describe('2. 写しが使われている', () => {
  it('AIAdvisorSheet は判定を自分で持たず、ai-session-created-since から読む', () => {
    const sheet = fs.readFileSync(path.join(ROOT, ADVISOR_SHEET_PATH), 'utf8');
    expect(sheet).toContain('import { sessionCreatedSince } from "../../lib/ai-session-created-since";');
    expect(sheet).not.toMatch(/function sessionCreatedSince\b/);
    expect(sheet).toContain('sessionCreatedSince(listed.sessions, knownSessionIds)');
  });
});
