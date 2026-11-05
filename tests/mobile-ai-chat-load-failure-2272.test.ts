/**
 * #2272 S1 モバイルの AI 相談の読み込み・作成の失敗の一文 (apps/mobile/src/lib/ai-chat-load-failure.ts) が、Web の AI 相談
 * (src/components/AIChatBubble.tsx。#2265 Q2) の一文と同じ文・同じ id・同じ選び方であること。
 *
 * モバイルはルートの src/ を import できない (.easignore が /src/ を除外する) ので、Web の文を写して持つ。写しが Web からずれたら
 * (どちらかだけ文を変えたら) ここで赤になる。Web の部品は画面のモジュールの中にあり、読み込むと画面の依存まで要るので、ソースを
 * TypeScript の構文木で読み、定数の文字列を取り出して比べる。
 *   1. 文: SESSIONS_/MESSAGES_/SESSION_CREATE_ の TIMEOUT / FAILED の 6 つが Web と同じ
 *   2. id: 一文の種類ごとの id (CHAT_LOAD_FAILURE_NOTE_IDS) が Web と同じ
 *   3. 選び方: 種類と時間切れかから選ぶ一文 (chatLoadFailureMessageOf) が Web の switch と同じ対応
 *   4. 時間切れの見分け (isChatLoadTimeout): 共通クライアントの待ちの上限 (kind が 'timeout') と打ち切り・自前の上限は時間切れ、
 *      圏外 (kind が 'offline')・失敗の応答は時間切れでない
 *   5. 写しが使われている: AIAdvisorSheet は文を自分で持たず、この部品から読む
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { HttpNetworkError } from '@homegohan/core';
import * as mobile from '../apps/mobile/src/lib/ai-chat-load-failure';
import { ConsultationRequestTimeoutError } from '../apps/mobile/src/lib/ai-consultation-request-time-limit';

const ROOT = path.resolve(__dirname, '..');
const WEB_CHAT_BUBBLE_PATH = 'src/components/AIChatBubble.tsx';
const ADVISOR_SHEET_PATH = 'apps/mobile/src/components/ai/AIAdvisorSheet.tsx';
const MESSAGE_NAMES = [
  'SESSIONS_LOAD_TIMEOUT_MESSAGE',
  'SESSIONS_LOAD_FAILED_MESSAGE',
  'MESSAGES_LOAD_TIMEOUT_MESSAGE',
  'MESSAGES_LOAD_FAILED_MESSAGE',
  'SESSION_CREATE_TIMEOUT_MESSAGE',
  'SESSION_CREATE_FAILED_MESSAGE',
] as const;
/** テストの待ち時間 (文の選び方に関わらない) */
const TIMEOUT_MS_FOR_TEST = 1_000;

function webSource(): ts.SourceFile {
  const text = fs.readFileSync(path.join(ROOT, WEB_CHAT_BUBBLE_PATH), 'utf8');
  return ts.createSourceFile(WEB_CHAT_BUBBLE_PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** ソースの最上位の const 宣言 (name) の初期値 */
function topLevelInitializer(source: ts.SourceFile, name: string): ts.Expression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  throw new Error(`${WEB_CHAT_BUBBLE_PATH} に ${name} が無い`);
}

/** 文字列の定数の値 */
function stringConstant(source: ts.SourceFile, name: string): string {
  const initializer = topLevelInitializer(source, name);
  if (!ts.isStringLiteralLike(initializer)) throw new Error(`${name} が文字列の定数でない`);
  return initializer.text;
}

/** `{ key: 'value', ... } as const` の中身 */
function stringRecordConstant(source: ts.SourceFile, name: string): Record<string, string> {
  let initializer = topLevelInitializer(source, name);
  if (ts.isAsExpression(initializer)) initializer = initializer.expression;
  if (!ts.isObjectLiteralExpression(initializer)) throw new Error(`${name} がオブジェクトの定数でない`);
  const record: Record<string, string> = {};
  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !ts.isStringLiteralLike(property.initializer)) {
      throw new Error(`${name} に文字列でない項目がある`);
    }
    record[property.name.text] = property.initializer.text;
  }
  return record;
}

/** Web の chatLoadFailureMessageOf の switch の対応 (種類 → [時間切れの定数名, 失敗の定数名]) */
function webMessageChoices(source: ts.SourceFile): Record<string, [string, string]> {
  const choices: Record<string, [string, string]> = {};
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'chatLoadFailureMessageOf') {
      node.forEachChild(function walk(child) {
        if (ts.isCaseClause(child) && ts.isStringLiteralLike(child.expression)) {
          const returned = child.statements.find(ts.isReturnStatement)?.expression;
          if (
            returned &&
            ts.isConditionalExpression(returned) &&
            ts.isIdentifier(returned.whenTrue) &&
            ts.isIdentifier(returned.whenFalse)
          ) {
            choices[child.expression.text] = [returned.whenTrue.text, returned.whenFalse.text];
          }
        }
        child.forEachChild(walk);
      });
    }
    node.forEachChild(visit);
  };
  visit(source);
  return choices;
}

describe('1. 文が Web と一致する', () => {
  it.each(MESSAGE_NAMES)('%s', (name) => {
    expect(mobile[name]).toBe(stringConstant(webSource(), name));
  });
});

describe('2. 一文の id が Web と一致する', () => {
  it('CHAT_LOAD_FAILURE_NOTE_IDS', () => {
    expect({ ...mobile.CHAT_LOAD_FAILURE_NOTE_IDS }).toEqual(stringRecordConstant(webSource(), 'CHAT_LOAD_FAILURE_NOTE_IDS'));
  });
});

describe('3. 種類と時間切れかから選ぶ一文が Web と同じ', () => {
  it('Web の switch の対応と、モバイルの chatLoadFailureMessageOf の結果が一致する', () => {
    const choices = webMessageChoices(webSource());
    const kinds = Object.keys(mobile.CHAT_LOAD_FAILURE_NOTE_IDS) as (keyof typeof mobile.CHAT_LOAD_FAILURE_NOTE_IDS)[];
    expect(Object.keys(choices).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const [timeoutName, failedName] = choices[kind];
      expect(mobile.chatLoadFailureMessageOf(kind, true), `${kind} の時間切れ`).toBe(stringConstant(webSource(), timeoutName));
      expect(mobile.chatLoadFailureMessageOf(kind, false), `${kind} の失敗`).toBe(stringConstant(webSource(), failedName));
    }
  });
});

describe('4. 時間切れの見分け', () => {
  it.each([
    ['共通クライアントの待ちの上限 (timeout)', new HttpNetworkError('timeout', 'timed out', { timeoutMs: TIMEOUT_MS_FOR_TEST }), true],
    ['自前の上限の時間切れ', new ConsultationRequestTimeoutError(), true],
    ['打ち切り (AbortError)', Object.assign(new Error('Aborted'), { name: 'AbortError' }), true],
    ['圏外 (offline)', new HttpNetworkError('offline', 'offline'), false],
    ['失敗の応答', new Error('HTTP 500 Internal Server Error: {}'), false],
    ['例外でない値', null, false],
  ] as const)('%s → %s', (_label, error, expected) => {
    expect(mobile.isChatLoadTimeout(error)).toBe(expected);
  });
});

describe('5. 写しが使われている', () => {
  it('AIAdvisorSheet は一文を自分で持たず、ai-chat-load-failure から読む', () => {
    const sheet = fs.readFileSync(path.join(ROOT, ADVISOR_SHEET_PATH), 'utf8');
    expect(sheet).toContain('from "../../lib/ai-chat-load-failure"');
    for (const name of MESSAGE_NAMES) {
      expect(sheet, `${name} の文が AIAdvisorSheet に写されている`).not.toContain(mobile[name]);
    }
  });
});
