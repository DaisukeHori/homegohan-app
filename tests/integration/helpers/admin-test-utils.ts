/**
 * 運営コンソール (/api/admin/*) 向け統合テストの共通ユーティリティ (#849)
 *
 * - TestUserPool: テストユーザーの作成と後片付け。作成の途中で失敗しても、作れた分は必ず消す
 * - expectError / errorCodeOf: `{ error: { code, message } }` 形式のエラー応答の検証
 * - latestAuditLog: admin_audit_logs の最新 1 件を service_role で読む (副作用の検証用)
 */
import { expect } from 'vitest';
import type { ApiResponse } from './api';
import { supabaseAdmin } from './supabase';
import {
  cleanupAuditLogs,
  cleanupTestUser,
  createTestUserWithRoles,
  testEmail,
  type TestUser,
} from './users';

/**
 * テストユーザーの作成と後片付けをまとめて扱う。
 * 後片付けは「監査ログ → ユーザー」の順 (admin_audit_logs.actor_id の外部キーが NO ACTION のため)。
 * ユーザーに紐づく業務データ (チケット・リード等) は、呼び出し側が cleanup() より先に消すこと。
 */
export class TestUserPool {
  private readonly users: TestUser[] = [];

  /**
   * @param ts     メールアドレスを一意にする時刻 (通常は Date.now())
   * @param prefix テストファイルを見分けるための接頭辞 (取り残されたユーザーの出所を追えるように)
   */
  constructor(
    private readonly ts: number,
    private readonly prefix: string,
  ) {}

  async create(label: string, roles: string[]): Promise<TestUser> {
    // メールアドレスは小文字で作る (GoTrue は大文字小文字を区別しないが、念のため揃える)
    const emailLabel = `${this.prefix}-${label}`.toLowerCase();
    const user = await createTestUserWithRoles({ email: testEmail(emailLabel, this.ts), roles });
    this.users.push(user);
    return user;
  }

  /** ラベル → ロール配列の対応から、まとめてユーザーを作る。1 人でも失敗したら全員の完了を待ってから throw する */
  async createMany<K extends string>(specs: Record<K, string[]>): Promise<Record<K, TestUser>> {
    const labels = Object.keys(specs) as K[];
    const results = await Promise.allSettled(labels.map((label) => this.create(label, specs[label])));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    return Object.fromEntries(
      labels.map((label, i) => [label, (results[i] as PromiseFulfilledResult<TestUser>).value]),
    ) as Record<K, TestUser>;
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(this.users.map((u) => cleanupAuditLogs(u.userId)));
    await Promise.allSettled(this.users.map((u) => cleanupTestUser(u.userId)));
  }
}

/** `{ error: { code } }` 形式のエラー本文から code を取り出す。形式が違えば undefined */
export function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 応答が期待するステータス (と任意でエラーコード) であることを確認する。
 * ステータスが違うときは応答本文を失敗メッセージに含める (CI のログだけで原因を追えるように)。
 */
export function expectError(res: ApiResponse, status: number, code?: string): void {
  expect(res.status, `status が違う。応答本文: ${JSON.stringify(res.body)}`).toBe(status);
  if (code !== undefined) {
    expect(errorCodeOf(res.body), `error.code が違う。応答本文: ${JSON.stringify(res.body)}`).toBe(code);
  }
}

/** 成功応答 (2xx) のときの `{ data }` を取り出す。ステータスが違えば応答本文付きで失敗させる */
export function dataOf<T>(res: ApiResponse, status = 200): T {
  expect(res.status, `status が違う。応答本文: ${JSON.stringify(res.body)}`).toBe(status);
  return (res.body as { data: T }).data;
}

export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  action_type: string;
  target_id: string | null;
  target_type: string | null;
  severity: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

/** admin_audit_logs の最新 1 件 (actor + action_type [+ target_id] で絞る)。無ければ null */
export async function latestAuditLog(params: {
  actorId: string;
  actionType: string;
  targetId?: string;
}): Promise<AuditLogRow | null> {
  let query = supabaseAdmin
    .from('admin_audit_logs')
    .select('*')
    .eq('actor_id', params.actorId)
    .eq('action_type', params.actionType)
    .order('created_at', { ascending: false })
    .limit(1);
  if (params.targetId) query = query.eq('target_id', params.targetId);

  const { data, error } = await query;
  if (error) throw new Error(`latestAuditLog failed: ${error.message}`);
  return (data?.[0] as AuditLogRow | undefined) ?? null;
}

/** 存在しないことが確実な UUID (v4) */
export function randomUuid(): string {
  return crypto.randomUUID();
}
