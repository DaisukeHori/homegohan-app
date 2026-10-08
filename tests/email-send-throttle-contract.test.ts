/**
 * #1163 メール送信の回数制限 (invite-throttle) のソース走査 contract テスト
 *
 * 利用者が指定したアドレスへメールを送る API が増えたときに、送信回数の制限を付け忘れないための安全網。
 * src/ 配下 (メール送信の実装 src/lib/emails と __tests__ を除く) の全ファイルをソースとして読み、
 *
 *   1. メールを送るファイル (@/lib/emails/send を使う / Resend を直接呼ぶ) は、
 *      src/lib/membership/invite-throttle.ts の判定を通しているか、理由付きの除外リストに載っていること
 *   2. 判定を使うファイルは、最初の RPC (副作用) とメール送信より前に判定を呼ぶこと
 *   3. 招待・参加リクエスト・譲渡提案の RPC は、判定を通すファイルからだけ呼ぶこと (判定の迂回を防ぐ)
 *   4. 除外リストが古くならないこと (存在しない・もうメールを送らない・もう判定を通している項目は消す)
 *
 * を確かめる。新しいメール送信 API を追加してこのテストが落ちたら、まず invite-throttle の判定を通す。
 * 宛先が利用者の指定ではない (固定宛先・既存メンバーのみ・運営専用など) 場合だけ、理由を書いて除外リストに足す。
 * 走査は TypeScript の構文木で行うので、コメントや文字列の中の `sendEmail(` には反応しない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src';
// メール送信の実装とテンプレート自体は走査しない
const EXCLUDED_DIRS = ['src/lib/emails'];

const THROTTLE_MODULE = '@/lib/membership/invite-throttle';
const THROTTLE_FILE = 'src/lib/membership/invite-throttle.ts';
const THROTTLE_FUNCTIONS = ['checkInviteEmailLimits', 'checkTransferProposeLimit'];

// 呼ぶとメール送信につながる RPC (招待・参加リクエスト・譲渡提案を作る)。判定を通すファイルからだけ呼ぶ。
const MAIL_TRIGGERING_RPCS = [
  'create_org_invite',
  'create_family_invite',
  'request_child_promotion',
  'propose_org_owner_transfer',
  'propose_family_representative_transfer',
];

/**
 * 判定を通さずにメールを送ってよいファイルと、その理由。
 * 理由は「利用者が宛先を指定できない」「本人が 1 回しか実行できない」など、乱用の余地が無い根拠を書く。
 */
const EXEMPT_EMAIL_SENDERS: Record<string, string> = {
  'src/app/api/contact/route.ts':
    '宛先は環境変数 ADMIN_NOTIFICATION_EMAIL の固定アドレスだけで、利用者は宛先を指定できない。IP 単位の専用リミッタ (10 回/分) がある',
  'src/app/api/family/representative-transfer/[id]/accept/route.ts':
    '提案された本人だけが 1 回だけ実行できる (2 回目は TRANSFER_NOT_PENDING)。宛先は旧・新の代表者に固定で、利用者は宛先を指定できない',
  'src/app/api/operator/membership/family/[id]/transfer/route.ts':
    '運営の super_admin 専用 (requireSuperAdmin)。宛先は対象グループの既存メンバーで、利用者は宛先を指定できない',
  'src/app/api/operator/membership/family/[id]/dissolve/route.ts':
    '運営の super_admin 専用 (requireSuperAdmin)。宛先は対象グループの既存メンバーで、利用者は宛先を指定できない',
  'src/app/api/operator/membership/org/[id]/transfer/route.ts':
    '運営の super_admin 専用 (requireSuperAdmin)。宛先は対象組織の既存メンバーで、利用者は宛先を指定できない',
  'src/app/api/operator/membership/org/[id]/dissolve/route.ts':
    '運営の super_admin 専用 (requireSuperAdmin)。宛先は対象組織の既存メンバーで、利用者は宛先を指定できない',
};

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────
interface SourceAnalysis {
  /**
   * メールを送る (sendEmail を呼ぶ / Resend を直接使う / 送信モジュールを動的 import する)。
   * 使っていない import だけでは「送る」とは見なさない。
   */
  sendsEmail: boolean;
  /** invite-throttle を import している */
  importsThrottle: boolean;
  /** 判定関数 (checkInviteEmailLimits / checkTransferProposeLimit) の呼び出し位置 */
  throttleCallPositions: number[];
  /** メール送信の呼び出し位置 (sendEmail(...) / Resend 直接呼び出し) */
  mailCallPositions: number[];
  /** `.rpc(...)` の呼び出し位置 */
  rpcCallPositions: number[];
  /** `.rpc('<name>', ...)` で呼んでいる RPC 名 */
  rpcNames: string[];
}

function isEmailSendModule(specifier: string): boolean {
  return /(^|\/)emails\/send$/.test(specifier) || specifier === 'resend';
}

function analyzeSource(source: string, fileName = 'file.ts'): SourceAnalysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const analysis: SourceAnalysis = {
    sendsEmail: false,
    importsThrottle: false,
    throttleCallPositions: [],
    mailCallPositions: [],
    rpcCallPositions: [],
    rpcNames: [],
  };
  // sendEmail を別名で import している場合に備えて、ローカル名を集める
  const sendEmailLocalNames = new Set<string>(['sendEmail']);
  // 送信モジュールの動的 import (呼び出しの別名までは追えないので、import した時点で送信と見なす)
  let importsMailerDynamically = false;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier === THROTTLE_MODULE) analysis.importsThrottle = true;
      if (isEmailSendModule(specifier)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === 'sendEmail') sendEmailLocalNames.add(element.name.text);
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const position = node.getStart(sf);

      // 動的 import('@/lib/emails/send')
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          if (isEmailSendModule(arg.text)) importsMailerDynamically = true;
          if (arg.text === THROTTLE_MODULE) analysis.importsThrottle = true;
        }
      }
      if (ts.isIdentifier(callee)) {
        if (sendEmailLocalNames.has(callee.text)) analysis.mailCallPositions.push(position);
        if (THROTTLE_FUNCTIONS.includes(callee.text)) analysis.throttleCallPositions.push(position);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === 'rpc') {
          analysis.rpcCallPositions.push(position);
          const first = node.arguments[0];
          if (first && ts.isStringLiteralLike(first)) analysis.rpcNames.push(first.text);
        }
        // resend.emails.send(...)
        if (
          callee.name.text === 'send' &&
          ts.isPropertyAccessExpression(callee.expression) &&
          callee.expression.name.text === 'emails'
        ) {
          analysis.mailCallPositions.push(position);
        }
      }
    }

    // new Resend(...)
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Resend') {
      analysis.mailCallPositions.push(node.getStart(sf));
    }

    // fetch('https://api.resend.com/emails', ...) のような直接の HTTP 呼び出し
    if (ts.isStringLiteralLike(node) && node.text.includes('api.resend.com')) {
      analysis.mailCallPositions.push(node.getStart(sf));
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  analysis.sendsEmail = analysis.mailCallPositions.length > 0 || importsMailerDynamically;
  return analysis;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(ROOT, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      if (EXCLUDED_DIRS.includes(relative)) continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const analyses = new Map<string, SourceAnalysis>();
for (const file of collectSourceFiles(path.join(ROOT, SCAN_ROOT))) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  analyses.set(relative, analyzeSource(fs.readFileSync(file, 'utf-8'), relative));
}

/** 判定を実際に呼んでいるファイル (import だけして呼ばない場合は含めない) */
const isThrottled = (a: SourceAnalysis) => a.importsThrottle && a.throttleCallPositions.length > 0;

const firstPosition = (positions: number[]) => (positions.length > 0 ? Math.min(...positions) : Infinity);

// ─────────────────────────────────────────────
// 1〜4. リポジトリのソースに対する contract
// ─────────────────────────────────────────────
describe('メール送信の回数制限 (#1163): リポジトリのソース', () => {
  it('走査が機能している: 既知のメール送信ファイルを検出している', () => {
    const senders = [...analyses].filter(([, a]) => a.sendsEmail).map(([file]) => file);

    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(senders).toEqual(
      expect.arrayContaining([
        'src/lib/membership/org-invite.ts',
        'src/app/api/family/invites/route.ts',
        'src/app/api/family/members/[member_id]/promote/route.ts',
        'src/app/api/org/owner-transfer/propose/route.ts',
        'src/app/api/family/representative-transfer/propose/route.ts',
        'src/app/api/contact/route.ts',
      ]),
    );
    expect(analyses.size).toBeGreaterThan(100);
  });

  it('メールを送るファイルは、invite-throttle の判定を通すか、理由付きの除外リストに載っている', () => {
    const violations = [...analyses]
      .filter(([, a]) => a.sendsEmail)
      .filter(([file, a]) => !isThrottled(a) && !(file in EXEMPT_EMAIL_SENDERS))
      .map(([file]) => file);

    expect(
      violations,
      `メールを送る処理は ${THROTTLE_MODULE} の送信回数制限を通すこと。` +
        '宛先が利用者の指定ではない場合だけ、このテストの EXEMPT_EMAIL_SENDERS に理由を書いて足す: ' +
        violations.join(', '),
    ).toEqual([]);
  });

  it('判定を使うファイルは、最初の RPC とメール送信より前に判定を呼ぶ', () => {
    const throttledFiles = [...analyses].filter(([file, a]) => file !== THROTTLE_FILE && a.importsThrottle);
    // 判定を使うファイルが無いと、この contract が空振りになる
    expect(throttledFiles.map(([file]) => file)).toEqual(
      expect.arrayContaining([
        'src/lib/membership/org-invite.ts',
        'src/app/api/family/invites/route.ts',
        'src/app/api/family/members/[member_id]/promote/route.ts',
        'src/app/api/org/owner-transfer/propose/route.ts',
        'src/app/api/family/representative-transfer/propose/route.ts',
      ]),
    );

    const violations = throttledFiles
      .filter(([, a]) => {
        const throttleAt = firstPosition(a.throttleCallPositions);
        const sideEffectAt = Math.min(firstPosition(a.rpcCallPositions), firstPosition(a.mailCallPositions));
        return !(throttleAt < sideEffectAt);
      })
      .map(([file]) => file);

    expect(
      violations,
      '送信回数の判定は、最初の副作用 (RPC・メール送信) より前に呼ぶこと: ' + violations.join(', '),
    ).toEqual([]);
  });

  it('招待・参加リクエスト・譲渡提案の RPC は、判定を通すファイルからだけ呼ぶ (判定を迂回できない)', () => {
    const violations = [...analyses]
      .filter(([, a]) => a.rpcNames.some((name) => MAIL_TRIGGERING_RPCS.includes(name)))
      .filter(([, a]) => !isThrottled(a))
      .map(([file, a]) => `${file} (${a.rpcNames.filter((n) => MAIL_TRIGGERING_RPCS.includes(n)).join(', ')})`);

    expect(
      violations,
      `${MAIL_TRIGGERING_RPCS.join(' / ')} を呼ぶファイルは ${THROTTLE_MODULE} の判定を通すこと: ` + violations.join(', '),
    ).toEqual([]);
  });

  it('メール送信の RPC を呼ぶ入口が、既知の 6 つ (判定を通すファイル) に収まっている', () => {
    const callers = [...analyses]
      .filter(([, a]) => a.rpcNames.some((name) => MAIL_TRIGGERING_RPCS.includes(name)))
      .map(([file]) => file)
      .sort();

    // create_org_invite は共通ヘルパー (org-invite.ts) だけが呼び、/api/org/invites と /api/org/members はそれを使う
    expect(callers).toEqual(
      [
        'src/app/api/family/invites/route.ts',
        'src/app/api/family/members/[member_id]/promote/route.ts',
        'src/app/api/family/representative-transfer/propose/route.ts',
        'src/app/api/org/owner-transfer/propose/route.ts',
        'src/lib/membership/org-invite.ts',
      ].sort(),
    );
  });

  it('組織の招待を作る 2 つの route は、判定を内蔵した共通ヘルパー経由で呼んでいる', () => {
    for (const routeFile of ['src/app/api/org/invites/route.ts', 'src/app/api/org/members/route.ts']) {
      const source = fs.readFileSync(path.join(ROOT, routeFile), 'utf-8');
      expect(source, `${routeFile} は createOrgInviteWithEmail を使うこと`).toMatch(/createOrgInviteWithEmail\s*\(/);
      expect(analyses.get(routeFile)!.rpcNames, `${routeFile} は create_org_invite を直接呼ばないこと`).not.toContain(
        'create_org_invite',
      );
    }
  });

  describe('除外リストが古くなっていない', () => {
    it.each(Object.entries(EXEMPT_EMAIL_SENDERS))('%s', (file, reason) => {
      expect(reason.trim().length, '理由を書くこと').toBeGreaterThan(10);
      expect(analyses.has(file), `${file} が存在しない: 除外リストから消すこと`).toBe(true);

      const analysis = analyses.get(file)!;
      expect(analysis.sendsEmail, `${file} はもうメールを送っていない: 除外リストから消すこと`).toBe(true);
      expect(isThrottled(analysis), `${file} は判定を通すようになった: 除外リストから消すこと`).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────
// 走査ロジック自体の確認 (合成ソースで検出できること / 誤検出しないこと)
// ─────────────────────────────────────────────
describe('メール送信の回数制限 (#1163): ソース解析のロジック', () => {
  it('@/lib/emails/send を import して sendEmail を呼ぶファイルはメール送信として検出する', () => {
    const a = analyzeSource(`
      import { sendEmail } from '@/lib/emails/send';
      export async function POST() { await sendEmail({ to: 'a@example.com' }); }
    `);

    expect(a.sendsEmail).toBe(true);
    expect(a.mailCallPositions).toHaveLength(1);
    expect(a.importsThrottle).toBe(false);
  });

  it('別名で import した sendEmail の呼び出しも検出する', () => {
    const a = analyzeSource(`
      import { sendEmail as deliver } from '@/lib/emails/send';
      export async function POST() { await deliver({}); }
    `);

    expect(a.sendsEmail).toBe(true);
    expect(a.mailCallPositions).toHaveLength(1);
  });

  it('動的 import で送信モジュールを読むファイルもメール送信として検出する', () => {
    const a = analyzeSource(`
      export async function POST() { const { sendEmail } = await import('@/lib/emails/send'); await sendEmail({}); }
    `);

    expect(a.sendsEmail).toBe(true);
  });

  it('Resend の直接利用 (new Resend / emails.send / api.resend.com) も検出する', () => {
    expect(analyzeSource(`import { Resend } from 'resend'; const r = new Resend('key');`).sendsEmail).toBe(true);
    expect(analyzeSource(`await resend.emails.send({ to: 'a@example.com' });`).sendsEmail).toBe(true);
    expect(analyzeSource(`await fetch('https://api.resend.com/emails', { method: 'POST' });`).sendsEmail).toBe(true);
    expect(analyzeSource('await fetch(`https://api.resend.com/emails`);').sendsEmail).toBe(true);
  });

  it('コメントや無関係な文字列の中の sendEmail( には反応しない', () => {
    const a = analyzeSource(`
      // sendEmail(envelope) を呼ぶ前に判定する
      /* await sendEmail(x); api.resend.com */
      const note = 'sendEmail( と書いてあるだけの文字列';
      export const sendEmailLater = 1;
    `);

    expect(a.sendsEmail).toBe(false);
    expect(a.mailCallPositions).toEqual([]);
  });

  it('判定の import と呼び出し位置、RPC の呼び出し位置と RPC 名を取り出す', () => {
    const a = analyzeSource(`
      import { checkInviteEmailLimits } from '@/lib/membership/invite-throttle';
      import { sendEmail } from '@/lib/emails/send';
      export async function POST(supabase) {
        const failure = await checkInviteEmailLimits({});
        await supabase.rpc('create_family_invite', {});
        await sendEmail({});
      }
    `);

    expect(a.importsThrottle).toBe(true);
    expect(a.rpcNames).toEqual(['create_family_invite']);
    expect(firstPosition(a.throttleCallPositions)).toBeLessThan(firstPosition(a.rpcCallPositions));
    expect(firstPosition(a.rpcCallPositions)).toBeLessThan(firstPosition(a.mailCallPositions));
    expect(isThrottled(a)).toBe(true);
  });

  it('判定を import していても呼んでいなければ「通している」とは見なさない', () => {
    const a = analyzeSource(`
      import { checkInviteEmailLimits } from '@/lib/membership/invite-throttle';
      import { sendEmail } from '@/lib/emails/send';
      export async function POST() { await sendEmail({}); }
    `);

    expect(a.importsThrottle).toBe(true);
    expect(isThrottled(a)).toBe(false);
  });

  it('判定を RPC より後ろで呼ぶと、順序の contract が検出する', () => {
    const a = analyzeSource(`
      import { checkInviteEmailLimits } from '@/lib/membership/invite-throttle';
      export async function POST(supabase) {
        await supabase.rpc('create_family_invite', {});
        await checkInviteEmailLimits({});
      }
    `);

    expect(firstPosition(a.throttleCallPositions)).toBeGreaterThan(firstPosition(a.rpcCallPositions));
  });
});
