import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import { SECRET_EMAIL_SAMPLES, SECRET_SAMPLE_TOKEN } from '../../../../tests/helpers/secret-email-samples';

// #1708 件名・本文に秘密 (トークンを含むリンク) を入れる文面は、封筒に contains_secret: true を入れる。
// sendEmail はそれを見て送信待ちの行に redact_after_send を立て、送れた・届けられなかったあとに宛先・件名・本文が伏せられる
// (生のトークンを email_outbox に残さない。cross/15 §3.1・operator/10 R-10)。
// 宣言は文面 (render*Email) の側にあるので、呼び出し元が付け忘れることは無い。ここでは文面の側の宣言の漏れを見張る:
//   1. src/lib/emails 配下の render*Email の文面は、すべて下の表 (秘密あり / 秘密なし) のどちらか一方に載っている (新しい文面は分類しないと赤)
//   2. 文面のコードが使うリンク・トークンの項目 (名前が _url / _link / _token / _code で終わる) は、表のその文面の行に載っている
//      (既存の文面にリンクを足したときも、秘密かどうかを決めないと赤)
//   3. contains_secret: true を書いているのは、秘密ありの文面だけ (書き忘れ・書き過ぎの両方を赤)
//   4. 秘密ありの文面の見本 (tests/helpers/secret-email-samples.ts) が揃っていて、本物の組み立てで本文にトークンが入り、宣言が付く

const EMAILS_DIR = path.resolve(__dirname, '../../../lib/emails');

/** 秘密ありの文面: 名前 → 秘密を運ぶ項目 */
const SECRET_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  dsr_verification: ['verify_url'], // 本人確認のリンク (?token=<生のトークン>)
  family_invite: ['invite_url'], // /invite/<招待のトークン>
  family_invite_new: ['invite_url'],
  family_invite_existing: ['invite_url'],
  org_invite_new: ['invite_url'],
  org_invite_existing: ['invite_url'],
  family_promote: ['accept_url'], // /family/promotions/<本人同意のトークン>
};

/** 秘密なしの文面: 名前 → 使うリンクの項目 (どれも、ログインした本人・運営だけが開ける画面か、だれでも読める公開の頁への固定のリンクか、秘密でない id) */
const PUBLIC_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  dsr_received: ['settings_url'],
  dsr_resolved: ['settings_url'],
  dsr_operator_notice: ['admin_url'],
  support_ticket_reply: ['contact_url'],
  contact_admin_notification: ['inquiries_url'],
  ops_app_log_error_spike: ['logs_url'],
  ops_email_dead_letter: ['outbox_url'],
  // #1125 (B) 定期処理の失敗・pg_cron の停止の運用メール。リンクは運用ログ画面 (super_admin だけが開ける固定の URL)
  ops_cron_failure: ['logs_url'],
  ops_pg_cron_stalled: ['logs_url'],
  // #1560 cron の共有シークレットのずれ・入れ替えの途中の運用メール。リンクは運用ログ画面 (super_admin だけが開ける固定の URL)
  ops_cron_secret_drift: ['logs_url'],
  // #1129 DB バックアップの鮮度の運用メール。リンクは運営のバックアップ・DR の画面 (super_admin だけが開ける固定の URL) で、文面の中で組み立てる
  ops_backup_stale: [],
  member_left: ['members_url'],
  // 保護者の同意の控え: 同意書の全文 (/legal/parental-consent・だれでも読める固定の頁) とメンバー管理画面 (ログインした本人だけ)
  family_parental_consent_recorded: ['document_url', 'members_url'],
  // 譲渡の提案のリンクは提案の id (/org/transfer-accept/<id>・/family/transfer-accept/<id>)。承諾できるのはログインした譲渡先の本人だけで、id は秘密ではない
  org_transfer_proposed: ['accept_url'],
  family_transfer_proposed: ['accept_url'],
  org_transfer_completed: [],
  family_transfer_completed: [],
  member_removed: [],
  operator_force_dissolve: [],
  operator_force_transfer: [],
  account_deleted: [], // 宛先を伏せるのは呼び出し元の redactAfterSend (退会した本人のアドレスを残さないため。秘密の宣言ではない)
  login_new_device: ['country_code'], // 新しい端末からのログインの通知 (cross/16 §18)。country_code は ISO 3166-1 の 2 文字の国コードで、リンクでもトークンでもない (名前が _code で終わるので走査が拾う)。リンクは getSiteUrl() + 固定のパス 2 つだけ
};

/** リンク・トークンらしい項目の名前 */
const LINK_FIELD = /\b([a-z][a-z0-9_]*_(?:url|link|token|code))\b/g;
/** 宣言 */
const SECRET_DECLARATION = /^\s+contains_secret: true,$/m;

/** コメントを除く (説明文の中の名前を項目として拾わない)。`https://` のような文字列の中の // は前が空白でないので残る */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else if (/\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

const renderers = collectFiles(EMAILS_DIR)
  .map((file) => ({ file, source: fs.readFileSync(file, 'utf-8') }))
  .filter(({ source }) => /export function render\w+Email\(/.test(source))
  .map(({ file, source }) => {
    const code = stripComments(source);
    return {
      relative: path.relative(EMAILS_DIR, file).split(path.sep).join('/'),
      template: [...source.matchAll(/^\s+template: '([^']*)',$/gm)].map((match) => match[1])[0] ?? '',
      linkFields: [...new Set([...code.matchAll(LINK_FIELD)].map((match) => match[1]))].sort(),
      declaresSecret: SECRET_DECLARATION.test(code),
    };
  });

const sorted = (values: readonly string[]) => [...values].sort();

describe('秘密を含むメールの文面の宣言 (contains_secret・#1708)', () => {
  it('走査が機能している: 秘密あり・秘密なしの既知の文面を検出し、リンクの項目を拾っている', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の検査が空振りで通ってしまわないようにする
    expect(renderers.length).toBe(Object.keys(SECRET_TEMPLATES).length + Object.keys(PUBLIC_TEMPLATES).length);
    const byTemplate = new Map(renderers.map((r) => [r.template, r]));
    expect(byTemplate.get('dsr_verification')?.linkFields).toEqual(['verify_url']);
    expect(byTemplate.get('org_invite_new')?.declaresSecret).toBe(true);
    expect(byTemplate.get('member_left')?.linkFields).toEqual(['members_url']);
    expect(byTemplate.get('member_left')?.declaresSecret).toBe(false);
    // 1 つの文面に項目が 2 つあっても両方を拾う (main で足された文面を表に載せ忘れると、件数・項目の検査で赤になる)
    expect(byTemplate.get('family_parental_consent_recorded')?.linkFields).toEqual(['document_url', 'members_url']);
  });

  it('秘密あり・秘密なしの表は重ならない', () => {
    const overlap = Object.keys(SECRET_TEMPLATES).filter((name) => name in PUBLIC_TEMPLATES);

    expect(overlap).toEqual([]);
  });

  it('すべての文面が表のどちらかに載っていて、表に余分な行が無い (新しい文面は秘密かどうかを決めて表に足す)', () => {
    const scanned = sorted(renderers.map((r) => r.template));
    const classified = sorted([...Object.keys(SECRET_TEMPLATES), ...Object.keys(PUBLIC_TEMPLATES)]);

    expect(scanned).toEqual(classified);
  });

  it.each(renderers.map((r) => [r.template, r.relative, r.linkFields] as const))(
    '%s (%s) が使うリンク・トークンの項目は、表のその文面の行と同じ',
    (template, _relative, linkFields) => {
      const expected = SECRET_TEMPLATES[template] ?? PUBLIC_TEMPLATES[template] ?? [];

      expect(linkFields).toEqual(sorted(expected));
    },
  );

  it.each(renderers.map((r) => [r.template, r.relative, r.declaresSecret] as const))(
    '%s (%s) は、秘密ありの文面のときだけ contains_secret: true を書いている',
    (template, _relative, declaresSecret) => {
      expect(declaresSecret).toBe(template in SECRET_TEMPLATES);
    },
  );

  it('秘密ありの文面の見本 (tests/helpers/secret-email-samples.ts) は、表の秘密ありの文面と過不足なく 1 つずつ', () => {
    expect(sorted(SECRET_EMAIL_SAMPLES.map((sample) => sample.template))).toEqual(sorted(Object.keys(SECRET_TEMPLATES)));
  });

  it.each(SECRET_EMAIL_SAMPLES.map((sample) => [sample.template, sample] as const))(
    '%s: 本物の組み立てで本文にトークンが入り、封筒に contains_secret: true が付き、スキーマを通っても残る',
    (template, sample) => {
      const envelope = sample.render('someone@example.com');

      expect(envelope.template).toBe(template);
      expect(envelope.text).toContain(SECRET_SAMPLE_TOKEN);
      expect(envelope.contains_secret).toBe(true);
      // sendEmail は封筒をスキーマで検証してから使う (落ちる項目があると宣言が届かない)
      expect(EmailEnvelopeSchema.parse(envelope).contains_secret).toBe(true);
    },
  );
});
