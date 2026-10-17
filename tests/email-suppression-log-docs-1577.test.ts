/**
 * #1577 の回帰テスト: 宛先停止リスト (email_blacklist) に載った宛先へ送らなかったときの記録を、文書が経路ごとに正しく書く。
 *
 * 送らない判定は 2 か所にあり、残る記録が違う:
 *   - sendEmail の登録時 (src/lib/emails/send.ts): app_logs の warn (function_name は send.ts の createLogger の名前) と、
 *     email_outbox の dead の行。redact_after_send の登録は行を作らない
 *   - worker の送信の直前 (src/lib/emails/outbox.ts): fail_email_outbox で dead にし、app_logs に error
 *     (function_name は cron の route の ROUTE_NAME)
 * #1577 の R1 で、要件書と ENV_SETUP.md が「warn (function_name = 'email')」の 1 つだけを書き、worker の経路の error を
 * 落としていた。ログの水準・名前・文言は実コードから読み、文書がそれと同じことを書いているかを確かめる
 * (実コードが変われば文書の側も直すよう、ここが赤になる)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SEND_SOURCE = 'src/lib/emails/send.ts';
const OUTBOX_SOURCE = 'src/lib/emails/outbox.ts';
const OUTBOX_CRON_ROUTE = 'src/app/api/cron/email-outbox/route.ts';
const REQUIREMENTS_DOC = 'docs/requirements/03-operator-admin.md';
const ENV_SETUP_DOC = 'ENV_SETUP.md';

/** 要件書の Bounces の節の見出し */
const BOUNCES_HEADING = '**Bounces / Complaints**';
/** ENV_SETUP.md の #1184 の節の見出し */
const ENV_SETUP_HEADING = '### 届かない宛先・苦情の宛先へ送らない';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

/** 正規表現の最初のグループを返す。当たらなければ投げる (describe の読み込みで赤になる) */
function capture(source: string, pattern: RegExp, what: string): string {
  const value = source.match(pattern)?.[1];
  if (!value) throw new Error(`${what} を実コードから読めない (コードの形が変わったら、このテストの読み方も直す)`);
  return value;
}

/** 見出しから、次の空行 + 見出し (# / **…**) の手前まで */
function extractBlock(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`見出し ${heading} が見つからない`);
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/\n\n(?:#{1,6} |\*\*|```)/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** 実コードから読んだ、2 つの経路のログの水準・名前・文言 */
function codeFacts() {
  const send = read(SEND_SOURCE);
  const outbox = read(OUTBOX_SOURCE);
  const route = read(OUTBOX_CRON_ROUTE);
  return {
    registerLogger: capture(send, /const logger = createLogger\('([^']+)'\)/, 'sendEmail のロガーの名前'),
    registerLevel: capture(
      send,
      /if \(suppression\.status === 'suppressed'\) \{\s*logger\.(\w+)\(/,
      'sendEmail の停止リストのログの水準',
    ),
    registerSkipsRedactedRow: /if \(!row\.redact_after_send\) \{/.test(send),
    workerSuppressedIsFailure: /suppression\.status === 'suppressed'\) \{\s*outcome = \{ ok: false, failure: SUPPRESSED_FAILURE \}/.test(
      outbox,
    ),
    workerDeadLevel: capture(outbox, /if \(next === 'dead'\) \{[\s\S]*?deps\.log\.(\w+)\('/, 'worker の dead のログの水準'),
    workerDeadMessage: capture(outbox, /if \(next === 'dead'\) \{[\s\S]*?deps\.log\.\w+\('([^']+)'/, 'worker の dead のログの文言'),
    workerLogger: capture(route, /const ROUTE_NAME = '([^']+)'/, 'cron/email-outbox の ROUTE_NAME'),
  };
}

describe('宛先停止リストで送らなかった記録の文書 (#1577)', () => {
  const facts = codeFacts();

  it('実コードの前提: 登録時は warn・worker の直前は dead の error (水準が違う)', () => {
    expect(facts.registerSkipsRedactedRow).toBe(true);
    expect(facts.workerSuppressedIsFailure).toBe(true);
    expect(facts.registerLevel).not.toBe(facts.workerDeadLevel);
    expect(facts.registerLogger).not.toBe(facts.workerLogger);
  });

  describe(`${REQUIREMENTS_DOC} の Bounces の節`, () => {
    const block = extractBlock(read(REQUIREMENTS_DOC), BOUNCES_HEADING);
    const lines = block.split('\n');
    const registerLine = lines.find((line) => line.includes('`sendEmail` の登録時に当たったとき')) ?? '';
    const workerLine = lines.find((line) => line.includes('worker が送る直前に当たったとき')) ?? '';

    it('登録時の経路を、実コードの水準と名前で書き、redact_after_send の登録は行を作らないと書く', () => {
      expect(registerLine, '登録時の経路の行が無い').not.toBe('');
      expect(registerLine).toContain(`${facts.registerLevel} (\`function_name = '${facts.registerLogger}'\`)`);
      expect(registerLine).toContain("`last_error_code = 'suppressed'`");
      expect(registerLine).toContain('`redact_after_send` の登録');
      expect(registerLine).toContain('行を作らない');
    });

    it('worker の直前の経路を、実コードの水準・名前・文言で書く (登録時の warn と混ぜない)', () => {
      expect(workerLine, 'worker の経路の行が無い').not.toBe('');
      expect(workerLine).toContain(`${facts.workerDeadLevel} (\`function_name = '${facts.workerLogger}'\``);
      expect(workerLine).toContain(`「${facts.workerDeadMessage}」`);
      expect(workerLine).not.toContain(`function_name = '${facts.registerLogger}'`);
      expect(workerLine).toContain('`fail_email_outbox`');
    });

    it('送らなかった記録を、経路を分けずに 1 つの水準で書く文が残っていない', () => {
      expect(block).not.toMatch(/送らなかった記録は `app_logs` の warn/);
    });
  });

  describe(`${ENV_SETUP_DOC} の #1184 の節`, () => {
    const block = extractBlock(read(ENV_SETUP_DOC), ENV_SETUP_HEADING);

    it('登録時の warn と、worker の直前の error を両方書く', () => {
      expect(block).toContain(`\`function_name = '${facts.registerLogger}'\``);
      expect(block).toContain(`\`function_name = '${facts.workerLogger}'\``);
      expect(block).toContain(`「${facts.workerDeadMessage}」の ${facts.workerDeadLevel}`);
    });
  });
});
