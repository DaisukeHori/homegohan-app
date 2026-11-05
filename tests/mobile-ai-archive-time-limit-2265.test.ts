/**
 * #2265 Q1 モバイルの AI 相談のアーカイブ (/close) の時間の上限が、Web の『相談を終了』の上限 (#2259 P1) と同じ値・同じ判定であること。
 *
 * モバイル (apps/mobile/src/lib/ai-consultation-request-time-limit.ts) はルートの src/ を import できない (.easignore が /src/ を
 * 除外する) ので、Web の部品 (src/lib/ai/consultation-request-time-limit.ts) と同じ値・同じ判定を写して持つ。写しが Web から
 * ずれたら (どちらかだけ値や判定を変えたら) ここで赤になる。
 *   1. 値: 既定の上限・下限・route の maxDuration の最大・時間切れの例外の文と name
 *   2. 判定: 環境変数の上書きの読み方 (resolveAiChatRequestTimeLimitMs)・時間切れの見分け (isConsultationRequestTimeout) を同じ入力で比べる
 *   3. 待ち方: withinConsultationRequestTimeLimit が、上限までに終われば結果を返し、過ぎたら signal を打ち切って時間切れの例外で
 *      終える (fetch が打ち切りに応じなくても終える)。両方の部品を同じ手順で確かめる
 *   4. 文: 時間切れの一文は Web の CLOSE_SESSION_TIMEOUT_MESSAGE と同じ扱い (失敗と言い切らず、相談の一覧で確かめてもらう)
 *   5. 写しが走査の対象: アーカイブ (AIAdvisorSheet の archiveSession) がこの部品の上限で待っている
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as web from '@/lib/ai/consultation-request-time-limit';
import * as mobile from '../apps/mobile/src/lib/ai-consultation-request-time-limit';

const ROOT = path.resolve(__dirname, '..');
const WEB_CHAT_BUBBLE_PATH = 'src/components/AIChatBubble.tsx';
const ADVISOR_SHEET_PATH = 'apps/mobile/src/components/ai/AIAdvisorSheet.tsx';
/** テストの上限 (偽の時刻で進める) */
const TEST_LIMIT_MS = 1_000;
/** 上限の 1 ミリ秒手前 */
const JUST_BEFORE_LIMIT_MS = TEST_LIMIT_MS - 1;

afterEach(() => {
  vi.useRealTimers();
});

describe('1. 値が Web と一致する', () => {
  it('既定の上限・下限・route の maxDuration の最大が Web と同じ', () => {
    expect(mobile.AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS).toBe(web.AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS);
    expect(mobile.AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS).toBe(web.AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS);
    expect(mobile.AI_ROUTE_MAX_DURATION_SECONDS).toBe(web.AI_ROUTE_MAX_DURATION_SECONDS);
  });

  it('環境変数を入れないときの上限は Web の既定と同じ (モバイルの変数が未設定のこのテストの環境)', () => {
    expect(process.env.EXPO_PUBLIC_AI_CHAT_REQUEST_TIME_LIMIT_MS).toBeUndefined();
    expect(mobile.AI_CHAT_REQUEST_TIME_LIMIT_MS).toBe(web.AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS);
  });

  it('時間切れの例外の文と name が Web と同じ', () => {
    expect(mobile.CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE).toBe(web.CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE);
    const mobileError = new mobile.ConsultationRequestTimeoutError();
    const webError = new web.ConsultationRequestTimeoutError();
    expect(mobileError.name).toBe(webError.name);
    expect(mobileError.message).toBe(webError.message);
  });
});

describe('2. 判定が Web と一致する', () => {
  const RAW_INPUTS: (string | undefined)[] = [
    undefined,
    '',
    '   ',
    'abc',
    '-1',
    '0',
    '999',
    '1000',
    ' 1000 ',
    '1500.5',
    '1e4',
    '60000',
    String(web.AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS),
    '99999999999999999999',
  ];

  it.each(RAW_INPUTS)('resolveAiChatRequestTimeLimitMs(%j) が Web と同じ値', (raw) => {
    expect(mobile.resolveAiChatRequestTimeLimitMs(raw)).toBe(web.resolveAiChatRequestTimeLimitMs(raw));
  });

  it('入力の表が両方の分岐 (既定に戻す・そのまま使う) を通っている (表が空振りしていない)', () => {
    const resolved = RAW_INPUTS.map((raw) => mobile.resolveAiChatRequestTimeLimitMs(raw));
    expect(resolved).toContain(mobile.AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS);
    expect(resolved).toContain(mobile.AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS);
  });

  const ERRORS: [string, unknown][] = [
    ['モバイルの時間切れの例外', new mobile.ConsultationRequestTimeoutError()],
    ['Web の時間切れの例外', new web.ConsultationRequestTimeoutError()],
    ['name が TimeoutError', Object.assign(new Error('x'), { name: 'TimeoutError' })],
    ['name が AbortError', Object.assign(new Error('x'), { name: 'AbortError' })],
    ['通信の失敗 (TypeError)', new TypeError('Network request failed')],
    ['ふつうの Error', new Error('failed')],
    ['null', null],
    ['undefined', undefined],
    ['文字列', 'TimeoutError'],
    ['name だけのオブジェクト', { name: 'AbortError' }],
  ];

  it.each(ERRORS)('isConsultationRequestTimeout(%s) が Web と同じ', (_label, error) => {
    expect(mobile.isConsultationRequestTimeout(error)).toBe(web.isConsultationRequestTimeout(error));
  });

  it('時間切れの表が両方の答え (時間切れ・そうでない) を通っている', () => {
    const answers = ERRORS.map(([, error]) => mobile.isConsultationRequestTimeout(error));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });
});

describe.each([
  ['Web', web.withinConsultationRequestTimeLimit],
  ['モバイル', mobile.withinConsultationRequestTimeLimit],
] as const)('3. withinConsultationRequestTimeLimit (%s) の待ち方', (_label, within) => {
  it('上限までに終われば結果を返し、signal を打ち切らず、予約を残さない', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    const result = await within(TEST_LIMIT_MS, async (signal) => {
      seen = signal;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('打ち切りに応じない run (応答が返らない) でも、上限で時間切れの例外で終え、signal を打ち切る', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    const waiting = within(TEST_LIMIT_MS, (signal) => {
      seen = signal;
      return new Promise<never>(() => {});
    });
    const outcome = waiting.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(JUST_BEFORE_LIMIT_MS);
    expect(seen!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(mobile.isConsultationRequestTimeout(error)).toBe(true);
    expect((error as Error).message).toBe(web.CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE);
    expect(seen!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('打ち切りに応じて AbortError で終わる run でも、待ちの結果は時間切れの例外 (AbortError を先に返さない)', async () => {
    vi.useFakeTimers();
    const waiting = within(TEST_LIMIT_MS, (signal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    );
    const outcome = waiting.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(TEST_LIMIT_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(web.CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE);
  });

  it('上限までに失敗した run の例外はそのまま返し、予約を残さない', async () => {
    vi.useFakeTimers();
    const failure = new TypeError('Network request failed');
    await expect(within(TEST_LIMIT_MS, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** ファイルの中の `export const <name> = '...'` の文字列の値 (構文木で読む。コンポーネントを import しない) */
function exportedStringOf(file: string, name: string): string {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer && ts.isStringLiteralLike(decl.initializer)) {
        return decl.initializer.text;
      }
    }
  }
  throw new Error(`${file} に ${name} の文字列が無い`);
}

/** 文の 1 つ目の「。」より後ろ (2 文目以降) */
function afterFirstSentence(message: string): string {
  return message.slice(message.indexOf('。') + 1);
}

describe('4. 時間切れの一文は Web の CLOSE_SESSION_TIMEOUT_MESSAGE と同じ扱い', () => {
  const webMessage = exportedStringOf(WEB_CHAT_BUBBLE_PATH, 'CLOSE_SESSION_TIMEOUT_MESSAGE');

  it('『失敗しました』『できませんでした』と言い切らず、確かめられなかったと言う', () => {
    expect(mobile.ARCHIVE_SESSION_TIMEOUT_MESSAGE).toContain('確かめられませんでした');
    expect(mobile.ARCHIVE_SESSION_TIMEOUT_MESSAGE).not.toContain('失敗');
    expect(mobile.ARCHIVE_SESSION_TIMEOUT_MESSAGE).not.toMatch(/できませんでした/);
  });

  it('次の手 (相談の一覧で確かめてから、もう一度) は Web の文と同じ', () => {
    expect(afterFirstSentence(webMessage)).toContain('相談の一覧で確かめて');
    expect(afterFirstSentence(mobile.ARCHIVE_SESSION_TIMEOUT_MESSAGE)).toBe(afterFirstSentence(webMessage));
  });
});

describe('5. アーカイブがこの部品の上限で待っている', () => {
  it('AIAdvisorSheet の archiveSession は withinConsultationRequestTimeLimit(AI_CHAT_REQUEST_TIME_LIMIT_MS, ...) の中で /close を送り、signal を fetch に渡す', () => {
    const text = fs.readFileSync(path.join(ROOT, ADVISOR_SHEET_PATH), 'utf8');
    const sf = ts.createSourceFile(ADVISOR_SHEET_PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let archive: ts.FunctionDeclaration | null = null;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'archiveSession') archive = node;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(archive, 'archiveSession がある').not.toBeNull();

    const limited: ts.CallExpression[] = [];
    const visitArchive = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'withinConsultationRequestTimeLimit' &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === 'AI_CHAT_REQUEST_TIME_LIMIT_MS'
      ) {
        limited.push(node);
      }
      ts.forEachChild(node, visitArchive);
    };
    visitArchive(archive!);
    expect(limited).toHaveLength(1);
    const runText = limited[0].arguments[1].getText(sf);
    expect(runText).toMatch(/\bfetch\s*\(/);
    expect(runText).toContain('/close');
    expect(runText).toMatch(/\bsignal\b/);
    // import 元はモバイルの写し (Web の部品ではない)
    expect(text).toMatch(/from\s+"\.\.\/\.\.\/lib\/ai-consultation-request-time-limit"/);
  });
});
