import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #1193 メール送信の失敗ログ (app_logs) は、どの文面のメールかを template の名前で区別する。
// 文面を作る render*Email 関数が template を返し忘れると、ログが 'unknown' ばかりになって原因を追えなくなる。
// 新しい文面を足したときに入れ忘れないよう、src/lib/emails 配下の render*Email を走査して確かめる。

const EMAILS_DIR = path.resolve(__dirname, '../../../lib/emails');

function collectTemplateFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTemplateFiles(full));
    else if (/\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** render*Email 関数を持つファイルと、その関数が返す封筒に入っている template の名前 */
const renderers = collectTemplateFiles(EMAILS_DIR)
  .map((file) => ({ file, source: fs.readFileSync(file, 'utf-8') }))
  .filter(({ source }) => /export function render\w+Email\(/.test(source))
  .map(({ file, source }) => ({
    relative: path.relative(EMAILS_DIR, file).split(path.sep).join('/'),
    names: [...source.matchAll(/^\s+template: '([^']*)',$/gm)].map((match) => match[1]),
  }));

describe('メールの文面 (render*Email) の template 名 (#1193)', () => {
  it('走査が機能している: 既知の文面を検出している', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の検査が空振りで通ってしまわないようにする
    expect(renderers.length).toBeGreaterThanOrEqual(15);
    expect(renderers.map((r) => r.relative)).toEqual(
      expect.arrayContaining([
        'membership/org-invite-new.ts',
        'membership/family-invite-new.ts',
        'membership/member-removed.ts',
        'support/ticket-reply.ts',
      ]),
    );
  });

  it.each(renderers.map((r) => [r.relative, r.names] as const))(
    '%s は、返す封筒に snake_case の template を 1 つ入れている',
    (_relative, names) => {
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    },
  );

  it('template の名前は文面ごとに一意 (ログで別の文面と取り違えない)', () => {
    const all = renderers.flatMap((r) => r.names);

    expect(new Set(all).size).toBe(all.length);
  });

  it('サポートの返信メールは、送信記録 (email_delivery_logs.template) と同じ support_ticket_reply', () => {
    const reply = renderers.find((r) => r.relative === 'support/ticket-reply.ts');

    expect(reply?.names).toEqual(['support_ticket_reply']);
  });
});
