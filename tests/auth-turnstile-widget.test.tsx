/**
 * #1165 Cloudflare Turnstile のウィジェット (src/components/auth/TurnstileWidget.tsx) の単体テスト
 *
 * 確かめること:
 *   A. サイトキーが無い (空・空白だけも含む) とき = Turnstile 無効
 *      何も描画せず、ready は常に true、takeToken() は null。window.turnstile にも触らない。
 *   B. サイトキーがあるとき
 *      - トークンが無い間は送信できない (ready=false → 送信ボタンが disabled)
 *      - callback でトークンが届くと送信できる
 *      - 期限切れ (expired-callback) / 時間切れ (timeout-callback) でトークンを捨て、また送信できなくなる
 *      - takeToken() はトークンを 1 回分として返し、捨てて、ウィジェットを reset する
 *        (送信の二度押しでも、同じトークンを 2 回使わない)
 *      - 失敗 (error-callback) では利用者向けの文言と「もう一度確認する」を出し、押すと reset する。
 *        Turnstile の自動再試行で成功したら、エラー表示は消える
 *      - 取り外すとき、ウィジェットを remove する
 *   C. api.js の読み込み
 *      - script タグは 1 つだけ。読み込めたらウィジェットを描画する
 *      - 読み込めなかったらエラー表示にし、「もう一度確認する」で読み込み直す (失敗した script タグは残さない)
 *   D. isCaptchaFailure: Supabase Auth の CAPTCHA エラーだけを見分ける
 *
 * このリポジトリには @testing-library/react が無いため、他のコンポーネントテストと同じく
 * react-dom/client + act で実際に描画する。Cloudflare の api.js は読み込まず (jsdom は外部 script を読まない)、
 * window.turnstile の偽物を使う。
 */
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITE_KEY = '1x00000000000000000000AA';

interface RenderOptions {
  sitekey: string;
  action?: string;
  theme?: string;
  language?: string;
  size?: string;
  'response-field'?: boolean;
  'refresh-expired'?: string;
  'refresh-timeout'?: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'timeout-callback': () => void;
  'error-callback': (code: string) => boolean | void;
}

interface RenderCall {
  container: HTMLElement;
  options: RenderOptions;
  widgetId: string;
}

/** window.turnstile の偽物。render の呼び出しを記録し、ウィジェット id を連番で返す */
function createFakeTurnstile() {
  const renders: RenderCall[] = [];
  const api = {
    render: vi.fn((container: HTMLElement, options: RenderOptions) => {
      const widgetId = `widget-${renders.length + 1}`;
      renders.push({ container, options, widgetId });
      return widgetId as string | undefined;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  return { api, renders };
}

type FakeTurnstile = ReturnType<typeof createFakeTurnstile>;

function installFakeTurnstile(): FakeTurnstile {
  const fake = createFakeTurnstile();
  (window as unknown as { turnstile?: unknown }).turnstile = fake.api;
  return fake;
}

function uninstallTurnstile() {
  delete (window as unknown as { turnstile?: unknown }).turnstile;
}

let container: HTMLDivElement;
let root: Root;
let submitted: Array<string | null>;

/** このテストの足場: ウィジェット + 送信ボタン。送信すると takeToken() の結果を記録する */
async function renderHarness() {
  const { TurnstileWidget, useTurnstile } = await import('@/components/auth/TurnstileWidget');
  const Harness: ComponentType = () => {
    const captcha = useTurnstile();
    return createElement(
      'form',
      {
        onSubmit: (e: { preventDefault: () => void }) => {
          e.preventDefault();
          submitted.push(captcha.takeToken());
        },
      },
      createElement(TurnstileWidget, { ...captcha.widgetProps, action: 'login' }),
      createElement('button', { type: 'submit', disabled: !captcha.ready }, '送信'),
    );
  };
  await act(async () => {
    root.render(createElement(Harness));
  });
  // loadTurnstileApi() の Promise が解けて render が呼ばれるまで進める
  await act(async () => {});
}

const text = () => container.textContent ?? '';
const submitButton = () => container.querySelector('button[type="submit"]') as HTMLButtonElement;
const widgetStatus = () => container.querySelector('[data-testid="turnstile"]')?.getAttribute('data-turnstile-status');
const retryButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('もう一度確認する'));

async function emitToken(call: RenderCall, token: string) {
  await act(async () => {
    call.options.callback(token);
  });
}

async function pressSubmit() {
  await act(async () => {
    // jsdom の submit() は submit イベントを出さないので、ボタンを押す (disabled のボタンは何も起こさない)
    submitButton().click();
  });
}

/** 送信ボタンを経由せず、フォームの submit イベントだけを出す (Enter キーなどでボタンを通らずに送られた場合) */
async function dispatchSubmitEvent() {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  // モジュール内に api.js の読み込み状態を持つので、テストごとに作り直す
  vi.resetModules();
  uninstallTurnstile();
  document.head.querySelectorAll('script[src*="challenges.cloudflare.com"]').forEach((s) => s.remove());
  submitted = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  uninstallTurnstile();
  document.head.querySelectorAll('script[src*="challenges.cloudflare.com"]').forEach((s) => s.remove());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('A. サイトキーが無いとき (Turnstile 無効)', () => {
  it.each([
    ['未設定', undefined],
    ['空文字 (.env.example の NEXT_PUBLIC_TURNSTILE_SITE_KEY= のまま)', ''],
    ['空白だけ', '   '],
  ])('%s: 何も描画せず、送信ボタンは押せて、トークンは null', async (_label, value) => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', value);
    const fake = installFakeTurnstile();

    await renderHarness();

    expect(container.querySelector('[data-testid="turnstile"]')).toBeNull();
    expect(submitButton().disabled).toBe(false);
    expect(fake.api.render).not.toHaveBeenCalled();
    // api.js も読み込まない (script タグを足さない)
    expect(document.head.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();

    await pressSubmit();
    expect(submitted).toEqual([null]);
  });

  it('api.js をまだ読み込んでいなくても、何もしない', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');

    await renderHarness();

    expect(document.head.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    expect(submitButton().disabled).toBe(false);
  });
});

describe('B. サイトキーがあるとき', () => {
  let fake: FakeTurnstile;

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
    fake = installFakeTurnstile();
  });

  it('サイトキーと設定を渡してウィジェットを 1 つ描画する (Managed 前提: 日本語・light・フォームに hidden 欄を足さない)', async () => {
    await renderHarness();

    expect(fake.renders).toHaveLength(1);
    const { container: target, options } = fake.renders[0];
    expect(target.getAttribute('data-testid')).toBe('turnstile-widget');
    expect(container.contains(target)).toBe(true);
    expect(options.sitekey).toBe(SITE_KEY);
    expect(options.action).toBe('login');
    expect(options.theme).toBe('light');
    expect(options.language).toBe('ja');
    expect(options['response-field']).toBe(false);
    // 期限切れ・時間切れのあとは Turnstile が自動で取り直す (取り直すまで送信を止めるだけで済ませるため、明示している)
    expect(options['refresh-expired']).toBe('auto');
    expect(options['refresh-timeout']).toBe('auto');
  });

  it('サイトキーの前後の空白は取り除いて渡す', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', `  ${SITE_KEY}\n`);

    await renderHarness();

    expect(fake.renders[0].options.sitekey).toBe(SITE_KEY);
  });

  it('トークンが無い間は送信ボタンが無効で、確認中の案内を出す。押しても送信されない', async () => {
    await renderHarness();

    expect(submitButton().disabled).toBe(true);
    expect(widgetStatus()).toBe('loading');
    expect(text()).toContain('ボットではないことを確認しています');

    await pressSubmit();
    expect(submitted).toEqual([]);
  });

  it('トークンが届くと送信ボタンが有効になり、案内が消える', async () => {
    await renderHarness();

    await emitToken(fake.renders[0], 'tok-1');

    expect(submitButton().disabled).toBe(false);
    expect(widgetStatus()).toBe('ready');
    expect(text()).not.toContain('ボットではないことを確認しています');
  });

  it('送信するとトークンを 1 回分として渡し、ウィジェットを reset して、また送信できなくする', async () => {
    await renderHarness();
    await emitToken(fake.renders[0], 'tok-1');

    await pressSubmit();

    expect(submitted).toEqual(['tok-1']);
    expect(fake.api.reset).toHaveBeenCalledTimes(1);
    expect(fake.api.reset).toHaveBeenCalledWith('widget-1');
    expect(submitButton().disabled).toBe(true);
    expect(widgetStatus()).toBe('loading');
  });

  it('送信の二度押し (ボタンを通らない submit) でも、同じトークンを 2 回使わない', async () => {
    await renderHarness();
    await emitToken(fake.renders[0], 'tok-1');

    await dispatchSubmitEvent();
    await dispatchSubmitEvent();

    expect(submitted).toEqual(['tok-1', null]);
    expect(fake.api.reset).toHaveBeenCalledTimes(1);
  });

  it('reset のあとに新しいトークンが届くと、また送信できる', async () => {
    await renderHarness();
    await emitToken(fake.renders[0], 'tok-1');
    await pressSubmit();

    await emitToken(fake.renders[0], 'tok-2');
    expect(submitButton().disabled).toBe(false);
    await pressSubmit();

    expect(submitted).toEqual(['tok-1', 'tok-2']);
    expect(fake.api.reset).toHaveBeenCalledTimes(2);
  });

  it('トークンの期限が切れたら (expired-callback)、捨てて送信できなくする', async () => {
    await renderHarness();
    await emitToken(fake.renders[0], 'tok-1');
    expect(submitButton().disabled).toBe(false);

    await act(async () => {
      fake.renders[0].options['expired-callback']();
    });

    expect(submitButton().disabled).toBe(true);
    expect(widgetStatus()).toBe('loading');
    await dispatchSubmitEvent();
    expect(submitted).toEqual([null]);
  });

  it('操作が必要な確認が時間切れになったら (timeout-callback)、捨てて送信できなくする', async () => {
    await renderHarness();
    await emitToken(fake.renders[0], 'tok-1');

    await act(async () => {
      fake.renders[0].options['timeout-callback']();
    });

    expect(submitButton().disabled).toBe(true);
    expect(widgetStatus()).toBe('loading');
  });

  it('失敗したら (error-callback)、利用者向けの文言とエラーコードを出し、送信はできないまま。true を返して Turnstile に「処理済み」と伝える', async () => {
    await renderHarness();
    await emitToken(fake.renders[0], 'tok-1');

    let handled: boolean | void = undefined;
    await act(async () => {
      handled = fake.renders[0].options['error-callback']('300030');
    });

    expect(handled).toBe(true);
    expect(widgetStatus()).toBe('error');
    expect(text()).toContain('ボットではないことの確認を完了できませんでした');
    expect(text()).toContain('エラーコード: 300030');
    expect(retryButton()).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it('「もう一度確認する」を押すと reset して確認し直す。自動再試行で成功すればエラー表示は消えて送信できる', async () => {
    await renderHarness();
    await act(async () => {
      fake.renders[0].options['error-callback']('300030');
    });

    await act(async () => {
      retryButton()!.click();
    });

    expect(fake.api.reset).toHaveBeenCalledWith('widget-1');
    expect(widgetStatus()).toBe('loading');
    expect(retryButton()).toBeUndefined();

    await emitToken(fake.renders[0], 'tok-9');
    expect(widgetStatus()).toBe('ready');
    expect(text()).not.toContain('エラーコード');
    expect(submitButton().disabled).toBe(false);
  });

  it('エラー表示のまま Turnstile の自動再試行が成功したら、案内を戻して送信できる', async () => {
    await renderHarness();
    await act(async () => {
      fake.renders[0].options['error-callback']('300030');
    });
    expect(widgetStatus()).toBe('error');

    await emitToken(fake.renders[0], 'tok-auto');

    expect(widgetStatus()).toBe('ready');
    expect(retryButton()).toBeUndefined();
    expect(submitButton().disabled).toBe(false);
  });

  it('画面から外すとき、ウィジェットを remove する', async () => {
    await renderHarness();
    expect(fake.api.remove).not.toHaveBeenCalled();

    await act(async () => {
      root.render(createElement('div'));
    });

    expect(fake.api.remove).toHaveBeenCalledWith('widget-1');
    expect(container.querySelector('[data-testid="turnstile"]')).toBeNull();
  });

  it('render が ウィジェット id を返さなかったら (描画できなかったら)、エラー表示にする', async () => {
    fake.api.render.mockReturnValueOnce(undefined);

    await renderHarness();

    expect(widgetStatus()).toBe('error');
    expect(text()).toContain('エラーコード: render');
    expect(submitButton().disabled).toBe(true);
  });

  it('render が例外を投げても (サイトキーの形式が不正など)、画面は壊さずエラー表示にする', async () => {
    fake.api.render.mockImplementationOnce(() => {
      throw new Error('Invalid or missing type for parameter "sitekey"');
    });

    await renderHarness();

    expect(widgetStatus()).toBe('error');
    expect(text()).toContain('エラーコード: render');
    expect(submitButton().disabled).toBe(true);
  });
});

describe('C. api.js の読み込み', () => {
  const scriptTags = () => document.head.querySelectorAll('script[src*="challenges.cloudflare.com"]');

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', SITE_KEY);
  });

  it('window.turnstile が無ければ script タグを 1 つだけ足し、読み込めたらウィジェットを描画する', async () => {
    await renderHarness();

    expect(scriptTags()).toHaveLength(1);
    const script = scriptTags()[0] as HTMLScriptElement;
    expect(script.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    expect(submitButton().disabled).toBe(true);

    const fake = installFakeTurnstile();
    await act(async () => {
      script.onload?.(new Event('load'));
    });

    expect(fake.renders).toHaveLength(1);
    // 読み込めたあとも script タグは残す (api.js は自分の script タグを探して設定を読む)
    expect(scriptTags()).toHaveLength(1);
    await emitToken(fake.renders[0], 'tok-1');
    expect(submitButton().disabled).toBe(false);
  });

  it('読み込めなかったら (広告ブロッカーなど) エラー表示にし、失敗した script タグは残さない', async () => {
    await renderHarness();
    const script = scriptTags()[0] as HTMLScriptElement;

    await act(async () => {
      script.onerror?.(new Event('error'));
    });

    expect(widgetStatus()).toBe('error');
    expect(text()).toContain('エラーコード: script');
    expect(submitButton().disabled).toBe(true);
    expect(scriptTags()).toHaveLength(0);
  });

  it('「もう一度確認する」で api.js を読み込み直し、読み込めたら描画する', async () => {
    await renderHarness();
    await act(async () => {
      (scriptTags()[0] as HTMLScriptElement).onerror?.(new Event('error'));
    });
    expect(retryButton()).toBeTruthy();

    await act(async () => {
      retryButton()!.click();
    });
    await act(async () => {});

    expect(scriptTags()).toHaveLength(1);
    expect(widgetStatus()).toBe('loading');

    const fake = installFakeTurnstile();
    await act(async () => {
      (scriptTags()[0] as HTMLScriptElement).onload?.(new Event('load'));
    });
    expect(fake.renders).toHaveLength(1);
    await emitToken(fake.renders[0], 'tok-after-retry');
    expect(submitButton().disabled).toBe(false);
  });

  it('script は読み込めたが window.turnstile が無いときも、エラー表示にする', async () => {
    await renderHarness();

    await act(async () => {
      (scriptTags()[0] as HTMLScriptElement).onload?.(new Event('load'));
    });

    expect(widgetStatus()).toBe('error');
    expect(scriptTags()).toHaveLength(0);
  });
});

describe('D. isCaptchaFailure: Supabase Auth の CAPTCHA エラーの見分け方', () => {
  it('error.code が captcha_failed なら true', async () => {
    const { isCaptchaFailure } = await import('@/lib/auth/turnstile');
    expect(isCaptchaFailure({ code: 'captcha_failed', message: 'x', status: 400 })).toBe(true);
  });

  it('message に captcha を含んでいれば true (大文字小文字は問わない)', async () => {
    const { isCaptchaFailure } = await import('@/lib/auth/turnstile');
    expect(isCaptchaFailure({ message: 'captcha verification process failed' })).toBe(true);
    expect(isCaptchaFailure(new Error('captcha protection: request disallowed (invalid-input-response)'))).toBe(true);
    expect(isCaptchaFailure({ message: 'CAPTCHA failed' })).toBe(true);
  });

  it('パスワード違い・レート制限・null などは false', async () => {
    const { isCaptchaFailure } = await import('@/lib/auth/turnstile');
    expect(isCaptchaFailure({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(false);
    expect(isCaptchaFailure({ code: 'over_request_rate_limit', message: 'For security purposes' })).toBe(false);
    expect(isCaptchaFailure({})).toBe(false);
    expect(isCaptchaFailure(null)).toBe(false);
    expect(isCaptchaFailure(undefined)).toBe(false);
    expect(isCaptchaFailure('captcha')).toBe(false);
  });
});
