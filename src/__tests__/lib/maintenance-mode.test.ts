// @vitest-environment node
/**
 * src/__tests__/lib/maintenance-mode.test.ts
 *
 * #1148 メンテナンスモードの部品 (src/lib/maintenance-mode.ts) のユニットテスト。
 * ミドルウェア全体の挙動は lib/supabase/__tests__/middleware-maintenance.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsFeatureEnabled = vi.fn(async (_key: string, _userId?: string, _options?: unknown) => false);
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string, options?: unknown) => mockIsFeatureEnabled(key, userId, options),
}));
// @/proxy を import するだけなので、Supabase のクライアントは作らせない
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }));

import { serviceUnavailableMessageOfBody } from '@homegohan/shared';
import { config } from '@/proxy';
import {
  MAINTENANCE_FLAG_TIMEOUT_MS,
  MAINTENANCE_MESSAGE,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  isMaintenanceExemptPath,
  RESEND_WEBHOOK_API_PATH,
  isMaintenanceFlagOn,
  isOperatorRoles,
  maintenanceApiResponse,
  maintenancePageResponse,
} from '@/lib/maintenance-mode';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFeatureEnabled.mockReset();
  mockIsFeatureEnabled.mockResolvedValue(false);
});

describe('isOperatorRoles', () => {
  it('admin / super_admin を持っていれば運営', () => {
    expect(isOperatorRoles(['admin'])).toBe(true);
    expect(isOperatorRoles(['user', 'super_admin'])).toBe(true);
  });

  it('それ以外のロール (support・sales・finance・org_admin など)・空・null・未定義は運営ではない', () => {
    expect(isOperatorRoles(['user'])).toBe(false);
    expect(isOperatorRoles(['support', 'sales', 'finance', 'content_moderator'])).toBe(false);
    expect(isOperatorRoles(['org_admin', 'org_manager', 'org_member'])).toBe(false);
    expect(isOperatorRoles([])).toBe(false);
    expect(isOperatorRoles(null)).toBe(false);
    expect(isOperatorRoles(undefined)).toBe(false);
  });

  it('配列でない値 (壊れたデータ) は運営ではない', () => {
    expect(isOperatorRoles('admin' as unknown as string[])).toBe(false);
    expect(isOperatorRoles({ 0: 'admin', length: 1 } as unknown as string[])).toBe(false);
  });
});

describe('isMaintenanceExemptPath', () => {
  it.each([
    '/login',
    '/login/',
    '/login/reset',
    '/auth',
    '/auth/native-bridge',
    '/auth/callback',
    '/terms',
    '/terms/',
    '/privacy',
    // #1486: 特定商取引法に基づく表記・お問い合わせの画面
    '/legal',
    '/legal/',
    '/contact',
    '/contact/',
    '/_next/static/chunks/main.js',
    '/_next/image',
    '/api/health',
    '/api/auth/session-sync',
    '/api/auth/native-bridge/code',
    '/api/cron/process-menu-queue',
    '/api/feature-flags',
    // #1636: 通知のトークンの claim (端末の後片付け)。この 1 本だけ
    '/api/push-tokens/claim',
    // #1577 の 4: Resend の Webhook の受け口 (機械から機械)。この 1 本だけ
    '/api/webhooks/resend',
  ])('%s はメンテナンス中でも通す', (path) => {
    expect(isMaintenanceExemptPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/home',
    '/admin',
    '/super-admin',
    '/pricing',
    // #1486: 新規登録は止めたまま。似た名前 (/legal-consent は規約への同意の画面) も通さない
    '/signup',
    '/signup/verify',
    '/legal-consent',
    '/legalx',
    '/contactx',
    '/loginx',
    '/authx',
    '/termsx',
    '/privacyx',
    '/_nextx',
    '/api',
    '/api/pantry',
    '/api/healthz',
    '/api/health/',
    '/api/health/goals',
    '/api/authx',
    '/api/cronx',
    '/api/feature-flags/extra',
    '/api/feature-flagsx',
    '/api/log',
    '/api/contact',
    // #1486: 画面を通しても、その下の API は通さない (お問い合わせの送信・規約への同意の記録)
    '/api/legal/accept',
    '/api/signup',
    '/api/super-admin/flags',
    // #1636: claim の 1 本だけを通す。似たパス・release・下のパスは止める
    '/api/push-tokens',
    '/api/push-tokens/',
    '/api/push-tokens/claim/',
    '/api/push-tokens/claimx',
    '/api/push-tokens/claim/extra',
    '/api/push-tokens/release',
    '/API/push-tokens/claim',
    // #1577 の 4: Resend の Webhook の 1 本だけを通す。似たパス・下のパス・ほかの Webhook (Stripe) は止める
    '/api/webhooks',
    '/api/webhooks/',
    '/api/webhooks/resend/',
    '/api/webhooks/resendx',
    '/api/webhooks/resend/extra',
    '/api/webhooks/stripe',
    '/api/webhooks/stripe/',
    '/API/webhooks/resend',
  ])('%s は止める', (path) => {
    expect(isMaintenanceExemptPath(path)).toBe(false);
  });

  it('#1577 の 4: 止めない Webhook の受け口の定数は、Resend の Webhook の route のパスと一致する', () => {
    expect(RESEND_WEBHOOK_API_PATH).toBe('/api/webhooks/resend');
  });

  it('API のパスは、静的ファイルの拡張子を付けても通さない (動的な API ルートを通り抜けさせない)', () => {
    for (const path of ['/api/recipes/abc.json', '/api/recipes/abc.png', '/api/pantry/x.css', '/api/log.js']) {
      expect(isMaintenanceExemptPath(path), path).toBe(false);
    }
  });

  it('ミドルウェアの matcher が外している /_next と死活監視は、こちらでも通す (どちらかを直しても食い違わない)', () => {
    const [matcher] = config.matcher;
    const runsMiddleware = (path: string) => new RegExp(`^${matcher}$`).test(path);

    for (const path of ['/_next/static/chunks/main.js', '/_next/image', '/api/health']) {
      expect(runsMiddleware(path), `${path} は matcher が外している前提`).toBe(false);
      // matcher を通らないので、メンテナンスの判定には届かないが、通る側に倒してある
      expect(isMaintenanceExemptPath(path), `${path} はメンテナンス中も通す`).toBe(true);
    }
  });

  it('静的ファイル (画像・manifest・robots・サービスワーカー) は matcher が外していて、ミドルウェアに届かない。拡張子で通す処理は持たない', () => {
    const [matcher] = config.matcher;
    const runsMiddleware = (path: string) => new RegExp(`^${matcher}$`).test(path);

    for (const path of [
      '/favicon.ico',
      '/manifest.json',
      '/robots.txt',
      '/sw.js',
      '/workbox-abc123.js',
      '/logo.png',
      '/photo.jpg',
      '/photo.jpeg',
      '/anim.gif',
      '/hero.webp',
      '/icon.svg',
      '/_vercel/speed-insights/script.js',
    ]) {
      // ミドルウェアが走らないので、メンテナンスの対象にもならない (一般ユーザーにもそのまま届く)
      expect(runsMiddleware(path), `${path} は matcher が外している`).toBe(false);
    }
  });

  it('動的なページのパスは、末尾が静的ファイルに見えても止める (/meals/abc.json のようなパスで、メンテナンス中の画面を通り抜けさせない)', () => {
    for (const path of [
      '/meals/abc.json',
      '/invite/x.txt',
      '/family/members/x.js',
      '/pantry/x.css',
      '/home.xml',
      '/fonts/noto.woff2',
      '/chunk.js.map',
    ]) {
      expect(isMaintenanceExemptPath(path), path).toBe(false);
    }
  });
});

describe('isMaintenanceFlagOn', () => {
  it('maintenance_mode を、ユーザー ID・ロール・短い待ち時間の上限つきで読む', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    await expect(isMaintenanceFlagOn('user-1', ['user', 'support'])).resolves.toBe(true);

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('maintenance_mode', 'user-1', {
      timeoutMs: MAINTENANCE_FLAG_TIMEOUT_MS,
      context: { roles: ['user', 'support'] },
    });
    expect(MAINTENANCE_FLAG_TIMEOUT_MS).toBeLessThanOrEqual(1000);
  });

  it('未ログイン (ユーザー ID・ロールなし) でも読める', async () => {
    await isMaintenanceFlagOn();
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('maintenance_mode', undefined, {
      timeoutMs: MAINTENANCE_FLAG_TIMEOUT_MS,
      context: undefined,
    });
  });

  it('OFF なら false', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    await expect(isMaintenanceFlagOn('user-1', [])).resolves.toBe(false);
  });

  it('判定が (万一) 例外を投げても false (止めない)', async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error('boom'));
    await expect(isMaintenanceFlagOn('user-1', [])).resolves.toBe(false);
  });
});

describe('maintenanceApiResponse', () => {
  it('503 + { error: 固定の文, code: MAINTENANCE_MODE, retryAfter }。Retry-After が付き、キャッシュさせない', async () => {
    const res = maintenanceApiResponse();

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      error: 'ただいまメンテナンス中です。しばらくしてから、もう一度お試しください。',
      code: 'MAINTENANCE_MODE',
      retryAfter: MAINTENANCE_RETRY_AFTER_SECONDS,
    });
  });

  it('#1486 回帰: 本文の error は文字列 (Web の画面が data.error をそのまま出しても、落ちず・[object Object] にならず固定の文になる)', async () => {
    const body = await maintenanceApiResponse().json();

    expect(typeof body.error).toBe('string');
    expect(String(body.error)).not.toContain('[object Object]');
    // モバイル (packages/shared) も同じ本文から同じ固定の文を読む
    expect(serviceUnavailableMessageOfBody(body)).toBe(MAINTENANCE_MESSAGE);
    // AI 相談の緊急停止の 503 と同じ形 (error / code / retryAfter のほかの項目を持たない)
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'retryAfter']);
  });
});

describe('maintenancePageResponse', () => {
  it('503 の HTML。Retry-After が付き、キャッシュさせない', async () => {
    const res = maintenancePageResponse();

    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('retry-after')).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('日本語の文面・スマホ向けの viewport・ライト/ダーク両対応で、外部の資源を読まない', async () => {
    const html = await maintenancePageResponse().text();

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<title>メンテナンス中 | ほめゴハン</title>');
    expect(html).toContain('ただいまメンテナンス中です');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<img');
  });

  it('毎回同じ内容を返す (リクエストの情報を埋め込まない)', async () => {
    const first = await maintenancePageResponse().text();
    const second = await maintenancePageResponse().text();
    expect(first).toBe(second);
  });
});
