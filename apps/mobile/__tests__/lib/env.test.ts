/**
 * env.test.ts
 * apps/mobile/src/lib/env.ts のテスト (#1182)
 *
 * 必須の環境変数 (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY) が入っていないビルドを見分ける。
 *  - 両方あれば、値を加工せずそのまま返す
 *  - 足りなければ、足りない変数名を返す (空・空白だけも未設定。値は含めない)
 *  - Metro がビルド時に値へ置き換えられるよう、名前を直接書いて読んでいる (process.env[name] と書いていない)
 */

import fs from 'fs';
import path from 'path';

import {
  MobileConfigError,
  REQUIRED_MOBILE_ENV_NAMES,
  resolveApiBaseUrl,
  resolveRequiredMobileEnv,
  resolveSupabaseEnv,
} from '../../src/lib/env';

const URL_VALUE = 'https://abcdefgh.supabase.co';
const KEY_VALUE = 'anon-key-value-secret-looking';
const API_BASE_VALUE = 'https://api.example.com';

describe('resolveSupabaseEnv', () => {
  // process.env は差し替えず、同じオブジェクトを書き換えて戻す。
  // jest-expo では `process.env.EXPO_PUBLIC_X` が expo/virtual/env 経由の参照に置き換わり、そこは読み込み時の
  // process.env を握り続けるため、process.env = {...} と差し替えると、ソース側から新しい値が見えなくなる
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of REQUIRED_MOBILE_ENV_NAMES) saved[name] = process.env[name];
  });

  afterEach(() => {
    for (const name of REQUIRED_MOBILE_ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('両方あれば、値を加工せずそのまま返す', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = URL_VALUE;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = KEY_VALUE;

    expect(resolveSupabaseEnv()).toEqual({ ok: true, url: URL_VALUE, anonKey: KEY_VALUE });
  });

  it('前後に空白がある値も、trim せずそのまま返す', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = ` ${URL_VALUE} `;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = KEY_VALUE;

    expect(resolveSupabaseEnv()).toEqual({ ok: true, url: ` ${URL_VALUE} `, anonKey: KEY_VALUE });
  });

  it('URL が無ければ EXPO_PUBLIC_SUPABASE_URL だけを足りないものとして返す', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = KEY_VALUE;

    expect(resolveSupabaseEnv()).toEqual({ ok: false, missing: ['EXPO_PUBLIC_SUPABASE_URL'] });
  });

  it('anon キーが無ければ EXPO_PUBLIC_SUPABASE_ANON_KEY だけを足りないものとして返す', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = URL_VALUE;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    expect(resolveSupabaseEnv()).toEqual({ ok: false, missing: ['EXPO_PUBLIC_SUPABASE_ANON_KEY'] });
  });

  it('両方無ければ、2 つとも足りないものとして返す (URL が先)', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    expect(resolveSupabaseEnv()).toEqual({
      ok: false,
      missing: ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'],
    });
  });

  it.each(['', ' ', '\t\n'])('値が %j (空・空白だけ) でも、未設定として扱う', (blank) => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = blank;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = KEY_VALUE;

    expect(resolveSupabaseEnv()).toEqual({ ok: false, missing: ['EXPO_PUBLIC_SUPABASE_URL'] });
  });

  it('足りないものを返すとき、設定されている変数の値は含めない', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = KEY_VALUE;

    expect(JSON.stringify(resolveSupabaseEnv())).not.toContain(KEY_VALUE);
  });

  it('必須の環境変数の名前は 3 つ (Supabase の 2 つと API の基点。#1434)', () => {
    expect([...REQUIRED_MOBILE_ENV_NAMES]).toEqual([
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_SUPABASE_ANON_KEY',
      'EXPO_PUBLIC_API_BASE_URL',
    ]);
  });
});

describe('resolveApiBaseUrl / resolveRequiredMobileEnv (#1434)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of REQUIRED_MOBILE_ENV_NAMES) saved[name] = process.env[name];
    process.env.EXPO_PUBLIC_SUPABASE_URL = URL_VALUE;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = KEY_VALUE;
    process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE_VALUE;
  });

  afterEach(() => {
    for (const name of REQUIRED_MOBILE_ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('API の基点があれば、加工せずそのまま返す', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = ` ${API_BASE_VALUE} `;

    expect(resolveApiBaseUrl()).toBe(` ${API_BASE_VALUE} `);
  });

  it.each([undefined, '', ' ', '\t\n'])('API の基点が %j (未設定・空・空白だけ) なら undefined', (value) => {
    if (value === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = value;

    expect(resolveApiBaseUrl()).toBeUndefined();
  });

  it('3 つともあれば ok', () => {
    expect(resolveRequiredMobileEnv()).toEqual({ ok: true });
  });

  it('API の基点だけが無ければ、EXPO_PUBLIC_API_BASE_URL だけを足りないものとして返す', () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;

    expect(resolveRequiredMobileEnv()).toEqual({ ok: false, missing: ['EXPO_PUBLIC_API_BASE_URL'] });
  });

  it('3 つとも無ければ、REQUIRED_MOBILE_ENV_NAMES の順で全部返す', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = ' ';
    process.env.EXPO_PUBLIC_API_BASE_URL = '';

    expect(resolveRequiredMobileEnv()).toEqual({ ok: false, missing: [...REQUIRED_MOBILE_ENV_NAMES] });
  });

  it('足りないものを返すとき、設定されている変数の値は含めない', () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;

    const text = JSON.stringify(resolveRequiredMobileEnv());
    expect(text).not.toContain(URL_VALUE);
    expect(text).not.toContain(KEY_VALUE);
  });
});

describe('MobileConfigError', () => {
  it('メッセージに足りない変数名を入れ (既存の getApiBaseUrl と同じ書き方)、missing にも持つ', () => {
    const error = new MobileConfigError(['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MobileConfigError');
    expect(error.message).toBe('[mobile] Missing env: EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY');
    expect(error.missing).toEqual(['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']);
  });
});

describe('ソースの確認', () => {
  // コメントの中の説明 (process.env[name] など) に反応しないよう、コメントを除いて確かめる
  const source = fs
    .readFileSync(path.resolve(__dirname, '../../src/lib/env.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('Metro がビルド時に値へ置き換えられるよう、process.env.EXPO_PUBLIC_X と名前を直接書いて読んでいる', () => {
    expect(source).toContain('process.env.EXPO_PUBLIC_SUPABASE_URL');
    expect(source).toContain('process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY');
    expect(source).toContain('process.env.EXPO_PUBLIC_API_BASE_URL');
    // process.env[name] のように名前を変数にすると、リリースビルドでは置き換わらず常に undefined になる
    expect(source).not.toMatch(/process\.env\s*\[/);
  });

  it('何も import しない (ルートの layout から、Provider の外でも呼べる)', () => {
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
