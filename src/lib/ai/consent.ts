/**
 * 外国の AI 事業者への提供の同意: 状況の確認・同意の記録・撤回 (サーバー専用)
 *
 * T15 (#1154 / #1133 / #1169)。external_data_consents テーブルを読み書きする。
 * 画面に出す文面・事業者の一覧・版は src/lib/ai/consent-config.ts にある (ブラウザからも使うので別ファイル)。
 * ここはその内容を再エクスポートするので、サーバー側のコードは `@/lib/ai/consent` だけ import すればよい。
 * 【ブラウザのコード ('use client') は、このファイルを import しない】
 * next/headers を読み込むサーバー専用の部品を引き込み、ビルドが失敗する。画面は consent-config.ts と consent-client.ts を使う。
 *
 * 【AI への送信は止めない】
 * この PR では、同意の有無で AI の呼び出しを止めない (オーナーの決定。強制は別タスク T18 で、AI_CONSENT_ENFORCEMENT で切り替える予定)。
 * getAiConsentStatus は、T18 が各 AI の route で同意の有無を判定するときにも使う。
 *
 * 【書き込みは service role だけ】
 * external_data_consents の書き込み (INSERT / UPDATE) は、サーバーの API だけが service role で行う
 * (20261008150000_ai_consent_policy_version.sql が、クライアントからの INSERT のポリシーと権限を外した)。
 * IP アドレスと User-Agent は、クライアントの申告ではなくリクエストのヘッダーから取る (extractClientIp / extractUserAgent)。
 * grantAiConsent / revokeAiConsent は、認証で確定した userId だけを渡して呼ぶこと
 * (リクエストの body / URL の値を userId に使わない。service role は RLS を通さないため)。
 *
 * 【同意の記録の持ち方】
 * - 「同意しない」「あとで」は行にしない。有効な行は (user_id, provider) ごとに 1 件の部分ユニーク索引
 *   (idx_ext_consents_active) があり、拒否の行があると、あとの同意の行が作れなくなるため。
 * - 同意は事業者ごとに 1 行 (consented = true, policy_version = 同意した版, ip_address, user_agent)。全事業者ぶんをまとめて記録する。
 * - 撤回は revoked_at を入れる。行は消さない (監査のため。DELETE は RLS が拒否する)。
 * - 文面の版が変わったときの再同意では、古い有効な行に revoked_at を入れて閉じ、新しい版の行を作る。
 *   この revoked_at は「撤回」ではなく「新しい同意に置き換わった」ことを表す。古い行は同意の履歴として残る。
 */
import { isIP } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import {
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_VERSION,
  type AiConsentProviderStatus,
  type AiConsentStatus,
} from './consent-config';

export * from './consent-config';

const TABLE = 'external_data_consents';

/** DB の外部キー・索引を考えて、1 ユーザーぶんの履歴として読む上限 (1 回の同意で事業者数ぶん増える。レート制限で増え方は抑えている) */
const HISTORY_LIMIT = 200;

/** User-Agent を保存するときの最大文字数 (ヘッダーは長くなりうる) */
const USER_AGENT_MAX_LENGTH = 512;

/** 呼び出し側が持っている Supabase クライアント (テストでは差し替える) */
export type ConsentDb = Pick<SupabaseClient, 'from'>;

/** external_data_consents の行のうち、状況の判定に使う列 */
export interface AiConsentRow {
  id?: string;
  provider: string;
  consented: boolean;
  consented_at: string | null;
  revoked_at: string | null;
  policy_version: string | null;
}

function toTime(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function latest(values: Array<string | null>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value && (best === null || toTime(value) > toTime(best))) best = value;
  }
  return best;
}

/** 行の一覧から、同意の状況を求める (DB には触れない) */
export function summarizeAiConsent(
  rows: readonly AiConsentRow[],
  version: string = AI_CONSENT_VERSION,
): AiConsentStatus {
  const providers: AiConsentProviderStatus[] = AI_CONSENT_PROVIDERS.map((provider) => {
    const mine = rows.filter((row) => row.provider === provider);
    // 拒否の行 (consented = false) は同意として数えない
    const active = mine.find((row) => row.revoked_at === null && row.consented === true);
    if (active) {
      return {
        provider,
        state: active.policy_version === version ? 'granted' : 'outdated',
        consentedAt: active.consented_at,
        policyVersion: active.policy_version ?? null,
        revokedAt: null,
      };
    }
    return {
      provider,
      state: 'none',
      consentedAt: null,
      policyVersion: null,
      revokedAt: latest(mine.map((row) => row.revoked_at)),
    };
  });

  const consented = providers.every((p) => p.state === 'granted');
  return {
    version,
    consented,
    providers,
    consentedAt: consented ? latest(providers.map((p) => p.consentedAt)) : null,
    revokedAt: providers.some((p) => p.state !== 'none') ? null : latest(providers.map((p) => p.revokedAt)),
  };
}

/**
 * ユーザーの同意の状況を返す。
 * db を省略すると、リクエストのセッションのクライアントで読む (RLS により自分の行だけが見える)。
 * userId は認証で確定した ID を渡す。
 */
export async function getAiConsentStatus(userId: string, db?: ConsentDb): Promise<AiConsentStatus> {
  const client: ConsentDb = db ?? createClient();
  const { data, error } = await client
    .from(TABLE)
    .select('id, provider, consented, consented_at, revoked_at, policy_version')
    .eq('user_id', userId)
    .order('consented_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) {
    throw new Error(`getAiConsentStatus: ${error.message}`);
  }
  return summarizeAiConsent((data ?? []) as AiConsentRow[]);
}

export interface GrantAiConsentInput {
  /** 認証で確定したログインユーザーの ID */
  userId: string;
  /** リクエストの x-forwarded-for の先頭の値 (extractClientIp)。取れなければ null */
  ipAddress: string | null;
  /** リクエストの User-Agent (extractUserAgent)。取れなければ null */
  userAgent: string | null;
  /** テスト用。省略時は現在時刻 */
  now?: Date;
}

/**
 * 全事業者について、現行の版への同意を記録する。何度呼んでも、同じ版への同意の行は増えない (冪等)。
 * - すでに現行の版で有効な行がある事業者は、そのまま (最初の同意の日時・IP を残す)。
 * - 古い版の行 / 拒否の行 (consented = false) / 版が無い行がある事業者は、その行に revoked_at を入れて閉じ、新しい行を作る。
 * - 同時に同じ人が 2 回押しても、部分ユニーク索引 (23505) で片方が弾かれるだけで、同意は 1 件に収まる。
 * 失敗したら例外を投げる。途中で失敗しても、状況は「全事業者に同意している」にならないだけで、もう一度呼べば続きから揃う。
 * db を省略すると service role のクライアントを使う。
 */
export async function grantAiConsent(input: GrantAiConsentInput, db?: ConsentDb): Promise<AiConsentStatus> {
  const client: ConsentDb = db ?? getSupabaseAdmin();
  const now = (input.now ?? new Date()).toISOString();

  const { data, error } = await client
    .from(TABLE)
    .select('id, provider, consented, policy_version')
    .eq('user_id', input.userId)
    .is('revoked_at', null);
  if (error) {
    throw new Error(`grantAiConsent: read active rows: ${error.message}`);
  }
  const active = (data ?? []) as Array<Pick<AiConsentRow, 'id' | 'provider' | 'consented' | 'policy_version'>>;

  for (const provider of AI_CONSENT_PROVIDERS) {
    const current = active.find((row) => row.provider === provider);
    if (current && current.consented === true && current.policy_version === AI_CONSENT_VERSION) continue;

    if (current) {
      const { error: closeError } = await client
        .from(TABLE)
        .update({ revoked_at: now })
        .eq('id', current.id)
        .is('revoked_at', null);
      if (closeError) {
        throw new Error(`grantAiConsent: close old row (${provider}): ${closeError.message}`);
      }
    }

    const { error: insertError } = await client.from(TABLE).insert({
      user_id: input.userId,
      provider,
      consented: true,
      consented_at: now,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      policy_version: AI_CONSENT_VERSION,
    });
    // 23505: 同時に届いた別のリクエストが、同じ事業者の行を先に作った。同意は記録されているので成功として扱う
    if (insertError && insertError.code !== '23505') {
      throw new Error(`grantAiConsent: insert (${provider}): ${insertError.message}`);
    }
  }

  return getAiConsentStatus(input.userId, client);
}

/**
 * 有効な同意をすべて撤回する (revoked_at を入れる。行は消さない)。有効な同意が無ければ何もしない。
 * 撤回しても、いまは AI への送信は止まらない (止めるのは T18)。
 * db を省略すると service role のクライアントを使う。
 */
export async function revokeAiConsent(
  userId: string,
  db?: ConsentDb,
  now: Date = new Date(),
): Promise<{ revokedCount: number }> {
  const client: ConsentDb = db ?? getSupabaseAdmin();
  const { data, error } = await client
    .from(TABLE)
    .update({ revoked_at: now.toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id');
  if (error) {
    throw new Error(`revokeAiConsent: ${error.message}`);
  }
  return { revokedCount: (data ?? []).length };
}

/** "1.2.3.4:5678" や "[::1]:5678" のポートと、IPv6 のゾーン ("%eth0") を外す */
function stripPortAndZone(value: string): string {
  let host = value;
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) host = bracketed[1];
  else if ((host.match(/:/g) ?? []).length === 1) host = host.split(':')[0];
  const zone = host.indexOf('%');
  return zone >= 0 ? host.slice(0, zone) : host;
}

/**
 * リクエストの x-forwarded-for の先頭の値 (クライアントの IP アドレス) を返す。
 * IP アドレスとして正しくない値は null にする (inet の列に不正な文字列を入れると INSERT が失敗し、同意が記録できなくなる)。
 * Vercel ではプラットフォームが x-forwarded-for を付け直す。ヘッダーを自由に付けられる環境では偽装できるため、
 * 同意の証拠としては補助的な情報になる。
 */
export function extractClientIp(headers: Pick<Headers, 'get'>): string | null {
  const raw = headers.get('x-forwarded-for');
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim();
  if (!first) return null;
  const candidate = stripPortAndZone(first);
  return isIP(candidate) !== 0 ? candidate : null;
}

/** リクエストの User-Agent を返す。空なら null。長すぎる値は切り詰める */
export function extractUserAgent(headers: Pick<Headers, 'get'>): string | null {
  const raw = headers.get('user-agent')?.trim();
  if (!raw) return null;
  return raw.slice(0, USER_AGENT_MAX_LENGTH);
}
