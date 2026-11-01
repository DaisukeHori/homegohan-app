/**
 * #2134 U1: 運営に見える文のロールの呼び名を、運営の画面の表示名「運営最上位」(src/lib/admin/operator-role-labels.ts) にそろえる
 *
 * 以前の問題:
 *   - U1-1: 凍結・審査のフォームは API の 403 / 409 の文をそのまま出すが、その文が『スーパー管理者 (super_admin)』で、同じフォームの
 *     選択肢の注記『運営最上位のみ』と食い違っていた。二段階認証の画面の FORBIDDEN の文・緊急介入の画面の『Super Admin に戻る』・
 *     監査の画面の『(スーパー管理者のみ)』・運用メールの『(super_admin のみ)』も同じ
 *   - U1-2: メイン画面のロール別の管理メニューで /super-admin の名前が『Super Admin』のまま (行き先の見出しは『運営最上位の画面』)
 *
 * 確かめること:
 *   - API・ライブラリの文の値が、表示名の定数から作った文になっている (1 件ごと)
 *   - 同じ型: src/app/api の route の失敗の本文の文 (定数・テンプレートの式をたどって値にしたもの) に旧い呼び名が無い
 *   - メイン画面の管理メニューは super_admin の行だけを SUPER_ADMIN_SCREEN_LABEL にし、ほかの 3 行は今の名前のまま
 * 画面のソースの文字の走査 (src/app/(operator)・src/lib/auth/mfa・src/lib/emails/ops・MainLayout) は
 * tests/admin-sidebar-role-labels-2128.test.tsx の SCANNED_PATHS が受け持つ。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_ROUTES_ROOT,
  REPO_ROOT,
  findErrorTexts,
  routeFilesUnder,
  type SubstitutionOptions,
} from './helpers/api-error-text-scan';
import { OPERATOR_ROLE_LABELS, SUPER_ADMIN_ONLY_NOTE, SUPER_ADMIN_SCREEN_LABEL } from '@/lib/admin/operator-role-labels';
import {
  PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE,
  SUPER_ADMIN_BAN_REJECTED_MESSAGE,
  SUPER_ADMIN_FREEZE_REJECTED_MESSAGE,
} from '@/lib/admin/user-ban';
import { MFA_ERROR_MESSAGES, mfaErrorMessage } from '@/lib/auth/mfa/client';
import { FREEZE_NOTIFICATION_UNKNOWN_MESSAGE } from '@/lib/admin/freeze-notification-status';

/** 旧い呼び名 (英字の super_admin / Super Admin と、日本語の『スーパー管理者』) */
const OLD_SUPER_ADMIN_NAME = /super_admin|super admin|スーパー管理者/i;

/** route の中で失敗の本文を作る自前の関数と、その文の引数の位置 (tests/api-error-english-field-names.test.ts と同じ) */
const ROUTE_ERROR_TEXT_CALLS: ReadonlyMap<string, number> = new Map([
  ['errorResponse', 2],
  ['errorBody', 1],
  ['errorJson', 1],
  ['badRequest', 0],
  ['notSupportedResponse', 0],
]);
/** 読み取れない式は印にする (見逃しの一覧は持たない。旧い呼び名は印にならないので、一覧が無くても判定は変わらない) */
const SUBSTITUTIONS: SubstitutionOptions = { exempt: new Map() };

const FREEZE_ROUTE = 'src/app/api/admin/users/[id]/freeze/route.ts';
const MODERATION_ROUTE = 'src/app/api/admin/moderation/[type]/[id]/route.ts';
const MAIN_LAYOUT = 'src/app/(main)/MainLayout.tsx';

const routeTexts = (file: string) =>
  findErrorTexts(file, { extraTextCalls: ROUTE_ERROR_TEXT_CALLS, substitutions: SUBSTITUTIONS }).map((found) => found.text);

describe('U1-1: API・ライブラリの文のロールの呼び名は「運営最上位」', () => {
  it('表示名の定数の値 (この案件で使う語)', () => {
    expect(OPERATOR_ROLE_LABELS.super_admin).toBe('運営最上位');
    expect(SUPER_ADMIN_ONLY_NOTE).toBe('運営最上位のみ');
    expect(SUPER_ADMIN_SCREEN_LABEL).toBe('運営最上位の画面');
  });

  it('無期限凍結を断る文 (凍結の route と審査の route の 403 OP_PERMISSION_DENIED)', () => {
    expect(PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE).toBe('無期限凍結は運営最上位のみ実行できます');
    expect(PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE).toContain(SUPER_ADMIN_ONLY_NOTE);
  });

  it('super_admin の凍結を断る文 (凍結の route の 403 OP_TARGET_PROTECTED)', () => {
    expect(SUPER_ADMIN_FREEZE_REJECTED_MESSAGE).toBe('運営最上位のユーザーは凍結できません');
  });

  it('super_admin の凍結を断る文 (審査の applyUserBan が返し、審査の route が本文の message にする)', () => {
    expect(SUPER_ADMIN_BAN_REJECTED_MESSAGE).toBe('運営最上位のユーザーは凍結できません');
  });

  it('二段階認証の画面の FORBIDDEN の文', () => {
    expect(mfaErrorMessage('FORBIDDEN')).toBe('この操作には運営最上位の権限と、二段階認証の確認が必要です。');
    for (const [code, message] of MFA_ERROR_MESSAGES) {
      expect(message, code).not.toMatch(OLD_SUPER_ADMIN_NAME);
    }
  });

  it('凍結の通知の結果が読めないときの文 (凍結のフォームが出す) は、開ける画面を運営の画面の呼び名で書く', () => {
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).toContain(`${SUPER_ADMIN_SCREEN_LABEL}の監査ログ閲覧`);
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).not.toMatch(OLD_SUPER_ADMIN_NAME);
  });
});

describe('同じ型: src/app/api の route の失敗の本文の文に旧い呼び名が無い', () => {
  const files = routeFilesUnder(API_ROUTES_ROOT);

  it('走査は route の文を定数・テンプレートの式までたどって読む (凍結・審査の route の直した文を集める)', () => {
    expect(files).toEqual(expect.arrayContaining([FREEZE_ROUTE, MODERATION_ROUTE]));
    expect(routeTexts(FREEZE_ROUTE)).toEqual(
      expect.arrayContaining([PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE, SUPER_ADMIN_FREEZE_REJECTED_MESSAGE]),
    );
    expect(routeTexts(MODERATION_ROUTE)).toContain(PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE);
  });

  it('走査が機能している: 直す前の route の文の形を検出する', () => {
    const fixture = `
      import { NextResponse } from 'next/server';
      export async function POST() {
        if (a) return NextResponse.json({ error: { code: 'OP_PERMISSION_DENIED', message: '永久 BAN はスーパー管理者 (super_admin) のみ実行可能です' } }, { status: 403 });
        if (b) return NextResponse.json({ error: { code: 'OP_TARGET_PROTECTED', message: 'スーパー管理者 (super_admin) のユーザーを凍結することはできません' } }, { status: 403 });
        if (c) return NextResponse.json({ error: 'Super Admin only' }, { status: 403 });
        return NextResponse.json({ ok: true });
      }
    `;
    const found = findErrorTexts('src/app/api/__fixture_old_name__/route.ts', { text: fixture, substitutions: SUBSTITUTIONS })
      .map((item) => item.text)
      .filter((text) => OLD_SUPER_ADMIN_NAME.test(text));
    expect(found).toHaveLength(3);
  });

  it('違反が 0 件', () => {
    const violations = files.flatMap((file) =>
      findErrorTexts(file, { extraTextCalls: ROUTE_ERROR_TEXT_CALLS, substitutions: SUBSTITUTIONS })
        .filter((found) => OLD_SUPER_ADMIN_NAME.test(found.text))
        .map((found) => `${found.file}:${found.line} 「${found.text}」`),
    );
    expect(violations).toEqual([]);
  });
});

describe('U1-2: メイン画面のロール別の管理メニュー (選択 A: super_admin の行だけ)', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, MAIN_LAYOUT), 'utf8');
  const menuRow = (role: string) => source.match(new RegExp(`^\\s*${role}: \\{ href: [^\\n]*$`, 'm'))?.[0] ?? '';

  it('super_admin の行は行き先の見出しと同じ SUPER_ADMIN_SCREEN_LABEL を名前にする', () => {
    expect(menuRow('super_admin')).toContain('href: "/super-admin", label: SUPER_ADMIN_SCREEN_LABEL');
    expect(source).toMatch(/import \{ SUPER_ADMIN_SCREEN_LABEL \} from "@\/lib\/admin\/operator-role-labels";/);
  });

  it('ほかの 3 行は今の行き先の名前のまま', () => {
    expect(menuRow('support')).toContain('label: "サポート"');
    expect(menuRow('org_admin')).toContain('label: "組織管理"');
    expect(menuRow('admin')).toContain('label: "管理者"');
  });

  it('/super-admin の見出しも同じ定数 (入口と行き先の呼び名がそろう)', () => {
    const superAdminLayout = fs.readFileSync(path.join(REPO_ROOT, 'src/app/super-admin/layout.tsx'), 'utf8');
    expect(superAdminLayout).toContain('{SUPER_ADMIN_SCREEN_LABEL}');
  });
});
