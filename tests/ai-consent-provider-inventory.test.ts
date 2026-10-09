/**
 * T15 (#1154) 同意画面の「提供先の事業者」と、コードが実際に送っている AI 事業者が一致すること
 *
 * コード (テストを除く) に書かれた送信先 (https:// のホストと、事業者の SDK) を集め、
 *   - AI 事業者の送信先は、すべて同意を取る事業者 (AI_CONSENT_PROVIDERS) のどれかに対応する (一覧にない事業者へ送る経路が無い)
 *   - 同意を取る事業者は、すべてコードのどこかで実際に使われている (使っていない事業者を一覧に残さない)
 *   - AI 事業者でない送信先 (自社・決済・メール・公開情報のサイトなど) は、理由つきで NON_AI_HOSTS に載っている
 * を確かめる。送信先を足したら、ここと supabase/functions/_shared/ai-consent.ts の AI_CONSENT_PROVIDERS・
 * 同意画面の表示内容 (src/lib/ai/consent-config.ts)・DB の CHECK を一緒に直し、AI_CONSENT_VERSION を上げること。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_CONSENT_PROVIDERS } from '../supabase/functions/_shared/ai-consent';
import { AI_CONSENT_PROVIDER_INFO } from '../src/lib/ai/consent-config';

const ROOT = path.resolve(__dirname, '..');

/** AI 事業者の送信先 → 同意を取る事業者 */
const AI_HOSTS: Record<string, string> = {
  'api.x.ai': 'xai',
  'generativelanguage.googleapis.com': 'google',
  'api.openai.com': 'openai',
  'api.perplexity.ai': 'perplexity',
  'api.aimlapi.com': 'aimlapi',
};

/** AI 事業者の SDK (import の名前) → 同意を取る事業者。openai の SDK は xAI の互換 API にも使う (baseURL で決まる) */
const AI_SDKS: Record<string, string> = {
  '@google/genai': 'google',
};

/** AI 事業者ではない送信先 → 理由 */
const NON_AI_HOSTS: Record<string, string> = {
  'homegohan.com': '自社のサイト',
  'homegohan.app': '自社のサイト',
  'homegohan-app.vercel.app': '自社のサイト',
  'flmeolcfutuwwbjmzyoz.supabase.co': '自社の Supabase',
  'placeholder.supabase.co': 'アプリの Supabase の URL が未設定のときの仮の値',
  'api.stripe.com': '決済 (Stripe)',
  'dashboard.stripe.com': '決済 (Stripe) の管理画面へのリンク',
  'api.resend.com': 'メールの送信 (Resend)',
  'eu.i.posthog.com': '利用状況の計測の残り (#1166 で外した設定の値)',
  'esm.sh': 'Edge Functions のモジュールの取得',
  'holidays-jp.github.io': '祝日の一覧 (公開情報)',
  'api.firecrawl.dev': 'コンビニ商品のカタログ (公開情報) の取り込み。利用者のデータは送らない',
  'www.mhlw.go.jp': '厚生労働省の資料へのリンク',
  'images.unsplash.com': '見本の画像',
  'ai.google.dev': 'Google の AI の説明ページへのリンク (送信先ではない)',
  'supabase.com': 'Supabase の説明ページへのリンク',
  'vercel.com': 'Vercel の説明ページへのリンク',
  'www.w3.org': 'SVG の名前空間',
};

/** コンビニ各社の公開サイト (カタログの取り込み元)。利用者のデータは送らない */
const CATALOG_SITE_PATTERN =
  /(^|\.)(sej\.co\.jp|seicomart\.co\.jp|sakura-mikura\.jp|s-kiosk\.jp|poplar-cvs\.co\.jp|orebo\.jp|ministop\.co\.jp|lawson\.co\.jp|family\.co\.jp|daily-yamazaki\.jp|cisca\.jp|jr-cross\.co\.jp)$/;

/** テスト用の作り物のホスト */
const TEST_HOST_PATTERN = /(^|\.)(example\.(com|test|co)|example|test)$|^(user|home|evil\.com|localhost\.example\.test)$/;

const SCAN_DIRS = ['src', 'supabase/functions', 'shared', 'lib', 'packages', 'apps/mobile/app', 'apps/mobile/src'];
const SKIP = /(__tests__|\.test\.|\.spec\.|node_modules|\/dist\/)/;

function listCodeFiles(dir: string): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const relPath = path.join(dir, entry.name);
    if (SKIP.test(relPath)) continue;
    if (entry.isDirectory()) out.push(...listCodeFiles(relPath));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(relPath);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function collect() {
  const hosts = new Map<string, string[]>();
  const sdks = new Map<string, string[]>();
  for (const file of SCAN_DIRS.flatMap(listCodeFiles)) {
    const text = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const match of text.matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) {
      const host = match[1].replace(/\.$/, '');
      hosts.set(host, [...(hosts.get(host) ?? []), file]);
    }
    for (const sdk of Object.keys(AI_SDKS)) {
      if (new RegExp(`from ['"]${sdk.replace('/', '\\/')}['"]`).test(text)) sdks.set(sdk, [...(sdks.get(sdk) ?? []), file]);
    }
  }
  return { hosts, sdks };
}

describe('同意を取る事業者と、実際の送信先', () => {
  const { hosts, sdks } = collect();

  it('送信先の集め方が壊れていない (自社の Supabase と xAI は必ず見つかる)', () => {
    expect(hosts.has('api.x.ai')).toBe(true);
    expect(hosts.size).toBeGreaterThan(5);
  });

  it('すべての送信先は、同意を取る AI 事業者か、AI 事業者ではない理由つきの送信先のどれか', () => {
    const unknown = [...hosts.keys()].filter(
      (host) =>
        !(host in AI_HOSTS) && !(host in NON_AI_HOSTS) && !CATALOG_SITE_PATTERN.test(host) && !TEST_HOST_PATTERN.test(host),
    );
    expect(
      unknown.map((host) => `${host} (${hosts.get(host)?.slice(0, 2).join(', ')})`),
      'AI 事業者なら AI_HOSTS と AI_CONSENT_PROVIDERS に、そうでなければ理由つきで NON_AI_HOSTS に載せること',
    ).toEqual([]);
  });

  it('AI 事業者の送信先は、すべて同意を取る事業者に入っている (一覧にない事業者へ送らない)', () => {
    const used = new Set<string>();
    for (const host of hosts.keys()) if (host in AI_HOSTS) used.add(AI_HOSTS[host]);
    for (const sdk of sdks.keys()) used.add(AI_SDKS[sdk]);
    for (const provider of used) expect([...AI_CONSENT_PROVIDERS], provider).toContain(provider);
  });

  it('同意を取る事業者は、すべて実際に使われている。画面に出す名前・国・使い道がある', () => {
    const used = new Set<string>([...hosts.keys()].filter((h) => h in AI_HOSTS).map((h) => AI_HOSTS[h]));
    for (const sdk of sdks.keys()) used.add(AI_SDKS[sdk]);
    for (const provider of AI_CONSENT_PROVIDERS) {
      expect(used.has(provider), `${provider} はコードのどこにも送信先が無い。一覧から外すこと`).toBe(true);
      const info = AI_CONSENT_PROVIDER_INFO[provider];
      expect(info.id).toBe(provider);
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.country.length).toBeGreaterThan(0);
      expect(info.usage.length).toBeGreaterThan(0);
    }
  });

  it('DB の CHECK (external_data_consents.provider) は、同意を取る事業者をすべて受け付ける', () => {
    const migrations = fs
      .readdirSync(path.join(ROOT, 'supabase/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const latestCheck = migrations
      .map((f) => fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8'))
      .flatMap((sql) => [...sql.matchAll(/external_data_consents_provider_check"?\s+CHECK\s*\(([\s\S]*?)\)\s*\)?;/g)].map((m) => m[1]))
      .pop();
    expect(latestCheck, 'external_data_consents_provider_check が見つからない').toBeTruthy();
    for (const provider of AI_CONSENT_PROVIDERS) expect(latestCheck).toContain(`'${provider}'`);
  });
});
