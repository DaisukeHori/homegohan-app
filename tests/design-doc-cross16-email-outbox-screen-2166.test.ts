/**
 * #2166 (docs-1101d) cross/16 の §3 の見出しの行が、送信待ちの一覧と再送の画面・API (operator/10 §9.2 の段 C) を
 * 「無い」と、読み取りの時点 (origin/main の sha) の限定なしに言わない
 *
 * cross/16 (docs/design/cross/16-auth-history-sessions.md) の §3 の見出しの行は、前提の事実を 1 行に並べる。
 * そこにはもともと「v1.8 R1 の修正で origin/main 9f4f6da8 と突き合わせた: 送信待ちの画面と API (operator/10 §9.2) は無い」
 * と sha で区切った記録があった。docs-1101d で来歴の文を外したとき、sha の限定だけが外れて「送信待ちの画面と API は無い」が
 * 今の事実の文として残りかけた (R1 の指摘)。段 C の画面と API は #1806 で入っている (下の EMAIL_OUTBOX_STAGE_C_FILES)。
 *   1. 段 C の画面と API のファイルがある (この見張りの前提。消すなら cross/16 の §3 も一緒に直す)
 *   2. §3 の見出しの行の文 (「。」で区切る) のうち、段 C の画面・API を名指しして「無い」と言う文は、同じ文に
 *      origin/main の sha を持つ (読み取りの時点の記録として読める)。sha の無い「無い」は赤
 *   3. 2 の判定が、R1 で指摘された文を赤にし、sha で区切った文と今の事実の文を通す (判定そのものの空振りを防ぐ)
 *   4. §3 の見出しの行が名指す、リポジトリの根からのパス (`src/…`・`docs/…`・`tests/…`・`supabase/…`・`lib/…`) はある
 * 冊のほかの行 (段 C の前 / 後で書き分けた行) は見ない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const CROSS16_PATH = 'docs/design/cross/16-auth-history-sessions.md';
const SECTION3_HEADING_PREFIX = '## 3. 前提の事実';

/** operator/10 §9.2 の段 C (#1806) の画面と API */
const EMAIL_OUTBOX_STAGE_C_FILES = [
  'src/app/super-admin/email-outbox/page.tsx',
  'src/app/api/super-admin/email-outbox/route.ts',
  'src/app/api/super-admin/email-outbox/[id]/requeue/route.ts',
] as const;

/** 段 C の画面・API を名指しする語 */
const STAGE_C_SCREEN_MENTION = /送信待ちの(?:一覧と再送の)?画面|再送の画面|super-admin\/email-outbox|operator\/10 §9\.2/;
/** 「無い」と言う語 */
const ABSENCE_CLAIM = /無い/;
/** git の短い sha の最小の長さ (git の既定の短縮の長さ) */
const MIN_SHORT_SHA_LENGTH = 7;
const ORIGIN_MAIN_SHA = new RegExp(`origin/main [0-9a-f]{${MIN_SHORT_SHA_LENGTH},}`);
/** リポジトリの根からのパスとして名指す、バッククォートの中の語 */
const REPO_PATH_IN_BACKTICKS = /`((?:src|docs|tests|supabase|lib)\/[^`\s]+)`/g;

function readSection3Heading(): string {
  const lines = fs.readFileSync(path.join(REPO_ROOT, CROSS16_PATH), 'utf8').split('\n');
  const headings = lines.filter((line) => line.startsWith(SECTION3_HEADING_PREFIX));
  expect(headings, `${CROSS16_PATH} の §3 の見出しの行は 1 行`).toHaveLength(1);
  return headings[0];
}

/** 段 C の画面・API を名指しして「無い」と言い、origin/main の sha を持たない文 */
function unboundedStageCAbsenceSentences(text: string): string[] {
  return text
    .split('。')
    .filter((sentence) => STAGE_C_SCREEN_MENTION.test(sentence) && ABSENCE_CLAIM.test(sentence))
    .filter((sentence) => !ORIGIN_MAIN_SHA.test(sentence));
}

describe('#2166 cross/16 §3 の見出しの行は、段 C の画面と API を限定なしに「無い」と言わない', () => {
  it('段 C の画面と API のファイルがある', () => {
    const missing = EMAIL_OUTBOX_STAGE_C_FILES.filter((file) => !fs.existsSync(path.join(REPO_ROOT, file)));
    expect(missing).toEqual([]);
  });

  it('§3 の見出しの行に、sha の限定の無い「段 C の画面と API は無い」の文が無い', () => {
    expect(unboundedStageCAbsenceSentences(readSection3Heading())).toEqual([]);
  });

  it('判定は R1 で指摘された文を赤にし、sha で区切った文と今の事実の文を通す', () => {
    const r1Defect =
      '`email_outbox` の表と RPC がある。送信待ちの画面と API (operator/10 §9.2) は無い (下の `src/lib/emails/send.ts` の項)。';
    const shaBounded =
      'v1.8 R1 の修正で origin/main 9f4f6da8 と突き合わせた: 送信待ちの画面と API (operator/10 §9.2) は無い (下の項)。';
    const presentFact =
      '送信待ちの一覧と再送の画面・API は operator/10 §9.2 の段 C (#1806) にあり、本書はそこに分岐を足さない (§7.1・§10.2)。';
    expect(unboundedStageCAbsenceSentences(r1Defect)).toEqual([
      '送信待ちの画面と API (operator/10 §9.2) は無い (下の `src/lib/emails/send.ts` の項)',
    ]);
    expect(unboundedStageCAbsenceSentences(shaBounded)).toEqual([]);
    expect(unboundedStageCAbsenceSentences(presentFact)).toEqual([]);
  });

  it('§3 の見出しの行が名指すリポジトリのパスはある', () => {
    const heading = readSection3Heading();
    const named = [...heading.matchAll(REPO_PATH_IN_BACKTICKS)].map((match) => match[1]);
    const missing = named.filter((repoPath) => !fs.existsSync(path.join(REPO_ROOT, repoPath)));
    expect(missing).toEqual([]);
  });
});
