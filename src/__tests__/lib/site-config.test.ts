import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1194 サイトの URL・メールの送信元・問い合わせ先を決める唯一の場所 (src/lib/site-config.ts)。
// 不正な値の警告は「1 回だけ」出す作りで、状態をモジュールの中に持つ。警告の回数を確かめるテストが
// 互いに影響しないよう、テストごとにモジュールを読み込み直す。

type SiteConfig = typeof import('@/lib/site-config');

async function loadSiteConfig(): Promise<SiteConfig> {
  vi.resetModules();
  return import('@/lib/site-config');
}

beforeEach(() => {
  // 開発者の手元の環境変数に左右されないよう、3 つとも未設定から始める (Vercel の環境を示す変数も外す)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  vi.stubEnv('EMAIL_FROM', '');
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('既定値は、環境変数を設定していない今の本番の値のまま (homegohan.com への切り替えは環境変数だけで行う)', () => {
  it('サイトの URL: いま実際にアプリが動いている URL', async () => {
    const { DEFAULT_SITE_URL, getSiteUrl } = await loadSiteConfig();
    expect(DEFAULT_SITE_URL).toBe('https://homegohan-app.vercel.app');
    expect(getSiteUrl()).toBe('https://homegohan-app.vercel.app');
  });

  it('メールの送信元: 従来のメールテンプレートと同じ送信元', async () => {
    const { DEFAULT_EMAIL_FROM, getEmailFrom } = await loadSiteConfig();
    expect(DEFAULT_EMAIL_FROM).toBe('ほめゴハン <noreply@homegohan.app>');
    expect(getEmailFrom()).toBe('ほめゴハン <noreply@homegohan.app>');
  });

  it('問い合わせ先: 従来のメールテンプレートと同じ問い合わせ先', async () => {
    const { DEFAULT_SUPPORT_EMAIL, getSupportEmail } = await loadSiteConfig();
    expect(DEFAULT_SUPPORT_EMAIL).toBe('support@homegohan.app');
    expect(getSupportEmail()).toBe('support@homegohan.app');
  });

  it('環境変数が未設定 (undefined) でも既定値になる', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('EMAIL_FROM', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', undefined);
    const config = await loadSiteConfig();
    expect(config.getSiteUrl()).toBe(config.DEFAULT_SITE_URL);
    expect(config.getEmailFrom()).toBe(config.DEFAULT_EMAIL_FROM);
    expect(config.getSupportEmail()).toBe(config.DEFAULT_SUPPORT_EMAIL);
  });

  it('空文字・空白だけの値も、未設定と同じ扱い (Vercel の画面で空のまま保存されていても既定値に戻る)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '   ');
    vi.stubEnv('EMAIL_FROM', '\t');
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', ' ');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = await loadSiteConfig();

    expect(config.getSiteUrl()).toBe(config.DEFAULT_SITE_URL);
    expect(config.getEmailFrom()).toBe(config.DEFAULT_EMAIL_FROM);
    expect(config.getSupportEmail()).toBe(config.DEFAULT_SUPPORT_EMAIL);
    // 空は「設定していない」だけで、誤りではない。警告は出さない
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('getSiteUrl (NEXT_PUBLIC_APP_URL)', () => {
  it('設定した値を返す', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.com');
    const { getSiteUrl } = await loadSiteConfig();
    expect(getSiteUrl()).toBe('https://homegohan.com');
  });

  it('末尾の / と前後の空白は除く (メールのリンクが // にならない)', async () => {
    const { getSiteUrl } = await loadSiteConfig();

    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.com/');
    expect(getSiteUrl()).toBe('https://homegohan.com');

    vi.stubEnv('NEXT_PUBLIC_APP_URL', '  https://homegohan.com///  ');
    expect(getSiteUrl()).toBe('https://homegohan.com');
  });

  it('開発用の http://localhost:3000 も使える', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    const { getSiteUrl } = await loadSiteConfig();
    expect(getSiteUrl()).toBe('http://localhost:3000');
  });

  it('呼ぶたびに環境変数を読む (テストや設定の差し替えが反映される)', async () => {
    const { getSiteUrl, DEFAULT_SITE_URL } = await loadSiteConfig();

    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://a.example.test');
    expect(getSiteUrl()).toBe('https://a.example.test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://b.example.test');
    expect(getSiteUrl()).toBe('https://b.example.test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(getSiteUrl()).toBe(DEFAULT_SITE_URL);
  });

  it.each([
    ['https:// の無いホスト名だけ', 'homegohan.com'],
    ['http(s) 以外のスキーム', 'ftp://homegohan.com'],
    ['javascript: スキーム', 'javascript:alert(1)'],
    ['途中に空白がある', 'https://home gohan.com'],
    ['クエリ付き (後ろにパスを足せない)', 'https://homegohan.com/?a=1'],
    ['ハッシュ付き (後ろにパスを足せない)', 'https://homegohan.com/#top'],
  ])('不正な値 (%s) は無視して既定値に戻し、警告を 1 回だけ出す。警告に値そのものは出さない', async (_label, value) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', value);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getSiteUrl, DEFAULT_SITE_URL } = await loadSiteConfig();

    expect(getSiteUrl()).toBe(DEFAULT_SITE_URL);
    expect(getSiteUrl()).toBe(DEFAULT_SITE_URL);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('NEXT_PUBLIC_APP_URL');
    expect(message).not.toContain(value);
  });
});

describe('getSiteUrl: Vercel の本番環境では localhost の URL を使わない', () => {
  // 開発用の .env.example の値 (http://localhost:3000) をそのまま本番に登録してしまっても、
  // メール・招待のリンクが、受け取った人の端末で開けない URL にならないようにする安全策。
  it.each([['VERCEL_ENV'], ['NEXT_PUBLIC_VERCEL_ENV']])(
    '%s=production のとき、localhost 系の設定は無視して既定値に戻し、警告を 1 回だけ出す',
    async (envName) => {
      vi.stubEnv(envName, 'production');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { getSiteUrl, DEFAULT_SITE_URL } = await loadSiteConfig();

      for (const value of [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://0.0.0.0:3000',
        'http://[::1]:3000',
        'http://app.localhost:3000',
      ]) {
        vi.stubEnv('NEXT_PUBLIC_APP_URL', value);
        expect(getSiteUrl(), value).toBe(DEFAULT_SITE_URL);
      }

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('NEXT_PUBLIC_APP_URL');
    },
  );

  it('本番でも、公開されているサイトの URL はそのまま使う', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.com');
    const { getSiteUrl } = await loadSiteConfig();
    expect(getSiteUrl()).toBe('https://homegohan.com');
  });

  it('localhost を含むだけの公開ホスト名は、本番でもそのまま使う (localhost 自体ではない)', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://localhost.example.test');
    const { getSiteUrl } = await loadSiteConfig();
    expect(getSiteUrl()).toBe('https://localhost.example.test');
  });

  it.each([['preview'], ['development'], ['']])(
    '本番以外 (VERCEL_ENV=%j) や、Vercel の外 (ローカル・CI の next start) では、localhost の URL もそのまま使える',
    async (vercelEnv) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv);
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { getSiteUrl } = await loadSiteConfig();

      expect(getSiteUrl()).toBe('http://localhost:3000');
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

describe('getEmailFrom (EMAIL_FROM)', () => {
  it('「表示名 <アドレス>」の形をそのまま返す', async () => {
    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.homegohan.com>');
    const { getEmailFrom } = await loadSiteConfig();
    expect(getEmailFrom()).toBe('ほめゴハン <noreply@mail.homegohan.com>');
  });

  it('アドレスだけの形も使える', async () => {
    vi.stubEnv('EMAIL_FROM', 'noreply@mail.homegohan.com');
    const { getEmailFrom } = await loadSiteConfig();
    expect(getEmailFrom()).toBe('noreply@mail.homegohan.com');
  });

  it('前後の空白は除く', async () => {
    vi.stubEnv('EMAIL_FROM', '  ほめゴハン <noreply@mail.homegohan.com>  ');
    const { getEmailFrom } = await loadSiteConfig();
    expect(getEmailFrom()).toBe('ほめゴハン <noreply@mail.homegohan.com>');
  });

  it.each([
    ['アドレスの形になっていない', 'noreply'],
    ['@ の後ろにドメインが無い', 'ほめゴハン <noreply@>'],
    ['山括弧が閉じていない', 'ほめゴハン <noreply@mail.homegohan.com'],
    ['アドレスが 2 つ', 'ほめゴハン <a@example.test> <b@example.test>'],
    ['改行で別のヘッダーを足そうとしている', 'noreply@mail.example.test\r\nBcc: someone@example.test'],
    ['表示名の中に改行', 'ほめ\nゴハン <noreply@mail.example.test>'],
  ])('不正な値 (%s) は無視して既定値に戻し、警告を 1 回だけ出す', async (_label, value) => {
    vi.stubEnv('EMAIL_FROM', value);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getEmailFrom, DEFAULT_EMAIL_FROM } = await loadSiteConfig();

    expect(getEmailFrom()).toBe(DEFAULT_EMAIL_FROM);
    expect(getEmailFrom()).toBe(DEFAULT_EMAIL_FROM);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EMAIL_FROM');
  });
});

describe('getSupportEmail (NEXT_PUBLIC_SUPPORT_EMAIL)', () => {
  it('設定した値を返す (前後の空白は除く)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', ' support@homegohan.com ');
    const { getSupportEmail } = await loadSiteConfig();
    expect(getSupportEmail()).toBe('support@homegohan.com');
  });

  it.each([
    ['@ が無い', 'support'],
    ['ドメインが無い', 'support@'],
    ['ドメインにドットが無い', 'support@localhost'],
    ['表示名つき (問い合わせ先の表示と mailto: には使えない)', 'ほめゴハン <support@example.test>'],
    ['途中に空白がある', 'sup port@example.test'],
  ])('不正な値 (%s) は無視して既定値に戻し、警告を 1 回だけ出す', async (_label, value) => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', value);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getSupportEmail, DEFAULT_SUPPORT_EMAIL } = await loadSiteConfig();

    expect(getSupportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(getSupportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('NEXT_PUBLIC_SUPPORT_EMAIL');
  });
});

describe('警告は環境変数ごとに 1 回ずつ', () => {
  it('3 つとも不正なら、それぞれ 1 回ずつ (合計 3 回)。同じ変数を何度呼んでも増えない', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'homegohan.com');
    vi.stubEnv('EMAIL_FROM', 'noreply');
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'support');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = await loadSiteConfig();

    for (let i = 0; i < 3; i += 1) {
      config.getSiteUrl();
      config.getEmailFrom();
      config.getSupportEmail();
    }

    expect(warn).toHaveBeenCalledTimes(3);
    const names = warn.mock.calls.map((call) => String(call[0]));
    expect(names.some((m) => m.includes('NEXT_PUBLIC_APP_URL'))).toBe(true);
    expect(names.some((m) => m.includes('EMAIL_FROM'))).toBe(true);
    expect(names.some((m) => m.includes('NEXT_PUBLIC_SUPPORT_EMAIL'))).toBe(true);
  });
});
