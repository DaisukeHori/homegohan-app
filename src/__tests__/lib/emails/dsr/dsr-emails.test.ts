/**
 * #1178 個人情報の請求 (DSR) のメール 4 通 (src/lib/emails/dsr/*.ts) の文面のテスト (設計 cross/15 §10・§15)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema, type EmailEnvelope } from '@/lib/emails/envelope';
import { renderDsrVerificationEmail } from '@/lib/emails/dsr/verification';
import { renderDsrReceivedEmail } from '@/lib/emails/dsr/received';
import { renderDsrOperatorNoticeEmail } from '@/lib/emails/dsr/operator-notice';
import { renderDsrResolvedEmail } from '@/lib/emails/dsr/resolved';
import { formatDsrDueDate } from '@/lib/emails/dsr/format';
import {
  DSR_ADMIN_PATH,
  DSR_REQUEST_TYPES,
  DSR_REQUEST_TYPE_LABELS,
  DSR_SETTINGS_PATH,
  DSR_VERIFICATION_TTL_HOURS,
  buildDsrVerifyUrl,
} from '@/lib/data-subject-requests/core';
import { DEFAULT_SUPPORT_EMAIL } from '@/lib/site-config';

const SITE = 'https://app.example.test';
const TO = 'taro@example.com';
const OPERATOR = 'ops@example.test';
const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const TOKEN = 'b'.repeat(64);
/** 2026-11-14 15:30 UTC = 日本時間 2026-11-15 00:30 (日付が変わる時刻) */
const DUE_AT = '2026-11-14T15:30:00.000Z';
const DETAILS = '請求の内容の秘密の文';
const RESPONSE_NOTE = '運営の応答の本文';

function renderAll(): Array<{ name: string; envelope: EmailEnvelope }> {
  return [
    {
      name: 'verification',
      envelope: renderDsrVerificationEmail({
        to_email: TO,
        request_type: 'disclosure',
        request_id: ID,
        verify_url: buildDsrVerifyUrl(SITE, ID, TOKEN),
      }),
    },
    {
      name: 'received',
      envelope: renderDsrReceivedEmail({
        to_email: TO,
        request_type: 'correction',
        request_id: ID,
        due_at: DUE_AT,
        settings_url: `${SITE}${DSR_SETTINGS_PATH}`,
      }),
    },
    {
      name: 'operator-notice',
      envelope: renderDsrOperatorNoticeEmail({
        to_email: OPERATOR,
        request_type: 'suspension',
        request_id: ID,
        due_at: DUE_AT,
        admin_url: `${SITE}${DSR_ADMIN_PATH}/${ID}`,
      }),
    },
    {
      name: 'resolved',
      envelope: renderDsrResolvedEmail({
        to_email: TO,
        request_type: 'erasure',
        request_id: ID,
        status: 'fulfilled',
        settings_url: `${SITE}${DSR_SETTINGS_PATH}`,
      }),
    },
  ];
}

beforeEach(() => {
  vi.stubEnv('EMAIL_FROM', '');
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DSR のメール 4 通', () => {
  it('template 名は dsr_verification / dsr_received / dsr_operator_notice / dsr_resolved で、snake_case・一意', () => {
    const names = renderAll().map((r) => r.envelope.template);
    expect(names).toEqual(['dsr_verification', 'dsr_received', 'dsr_operator_notice', 'dsr_resolved']);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
  });

  it('件名は 100 字以内で、送信前の検証 (EmailEnvelopeSchema) を通る', () => {
    for (const { name, envelope } of renderAll()) {
      expect(envelope.subject.length, name).toBeLessThanOrEqual(100);
      expect(EmailEnvelopeSchema.safeParse(envelope).success, name).toBe(true);
    }
  });

  it('件名は設計 §10 のとおり', () => {
    expect(renderAll().map((r) => r.envelope.subject)).toEqual([
      '【ほめゴハン】個人情報の請求の本人確認のお願い',
      '【ほめゴハン】個人情報の請求を受け付けました',
      `【運営】個人情報の請求 (${DSR_REQUEST_TYPE_LABELS.suspension}) を受け付けました`,
      '【ほめゴハン】個人情報の請求への対応が完了しました',
    ]);
  });

  it('本文に請求の内容・応答・宛先のメールアドレスを含まない (宛先は封筒の to にだけ)', () => {
    for (const { name, envelope } of renderAll()) {
      expect(envelope.text, name).not.toContain(DETAILS);
      expect(envelope.text, name).not.toContain(RESPONSE_NOTE);
      expect(envelope.text, name).not.toContain(TO);
      expect(envelope.text, name).not.toContain(OPERATOR);
    }
    expect(renderAll().map((r) => r.envelope.to)).toEqual([TO, TO, OPERATOR, TO]);
  });

  it('どの文面にも種類のラベルと受付番号 (id の先頭 8 桁) が入り、id の全体は運営の URL のほかには出さない', () => {
    for (const { name, envelope } of renderAll()) {
      expect(envelope.text, name).toContain('受付番号: #0a1b2c3d');
    }
    const [verification, received, notice, resolved] = renderAll().map((r) => r.envelope.text);
    expect(verification).toContain(`種類: ${DSR_REQUEST_TYPE_LABELS.disclosure}`);
    expect(received).toContain(`種類: ${DSR_REQUEST_TYPE_LABELS.correction}`);
    expect(notice).toContain(`種類: ${DSR_REQUEST_TYPE_LABELS.suspension}`);
    expect(resolved).toContain(`種類: ${DSR_REQUEST_TYPE_LABELS.erasure}`);
  });

  it('本人確認のメール: 確認リンクに id と token が入り、有効時間・ログインの案内・問い合わせ先がある', () => {
    const text = renderAll()[0].envelope.text;
    const link = text.split('\n').find((line) => line.startsWith(`${SITE}/`));
    expect(link).toBeDefined();
    const url = new URL(link ?? '');
    expect(url.searchParams.get('id')).toBe(ID);
    expect(url.searchParams.get('token')).toBe(TOKEN);
    expect(text).toContain(`${DSR_VERIFICATION_TTL_HOURS} 時間有効`);
    expect(text).toContain('ログインしてから開いてください');
    expect(text).toContain(DEFAULT_SUPPORT_EMAIL);
  });

  it('受付のメールと運営への知らせ: 期限は日本時間の日付 (UTC の前日の 15:30 は日本時間の翌日)', () => {
    const [, received, notice] = renderAll().map((r) => r.envelope.text);
    expect(received).toContain('応答の期限: 2026年11月15日 (日本時間)');
    expect(notice).toContain('応答の期限: 2026年11月15日 (日本時間)');
    expect(received).toContain(`${SITE}${DSR_SETTINGS_PATH}`);
    expect(notice).toContain(`${SITE}${DSR_ADMIN_PATH}/${ID}`);
  });

  it('完了のメール: 結果のラベル・設定画面のリンク・設定画面を開けないときの問い合わせ先 (getSupportEmail)', () => {
    const text = renderAll()[3].envelope.text;
    expect(text).toContain('結果: 対応済み');
    expect(text).toContain(`${SITE}${DSR_SETTINGS_PATH}`);
    expect(text).toContain(`設定画面を開けない場合は、${DEFAULT_SUPPORT_EMAIL} までお問い合わせください。`);

    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'help@example.test');
    const rejected = renderDsrResolvedEmail({
      to_email: TO,
      request_type: 'disclosure',
      request_id: ID,
      status: 'rejected',
      settings_url: `${SITE}${DSR_SETTINGS_PATH}`,
    }).text;
    expect(rejected).toContain('結果: 対応できず');
    expect(rejected).toContain('help@example.test');
  });

  it.each(DSR_REQUEST_TYPES)('運営への知らせの件名は種類 %s のラベルを入れても 100 字以内', (requestType) => {
    const envelope = renderDsrOperatorNoticeEmail({
      to_email: OPERATOR,
      request_type: requestType,
      request_id: ID,
      due_at: DUE_AT,
      admin_url: `${SITE}${DSR_ADMIN_PATH}/${ID}`,
    });
    expect(envelope.subject).toContain(DSR_REQUEST_TYPE_LABELS[requestType]);
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe('formatDsrDueDate', () => {
  it('日本時間の日付にする。Date も文字列も受ける', () => {
    expect(formatDsrDueDate(DUE_AT)).toBe('2026年11月15日');
    expect(formatDsrDueDate(new Date('2026-11-14T14:59:59.000Z'))).toBe('2026年11月14日');
  });

  it('null・日時として読めない値は「未定」', () => {
    expect(formatDsrDueDate(null)).toBe('未定');
    expect(formatDsrDueDate('not-a-date')).toBe('未定');
  });
});
