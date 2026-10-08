/**
 * secure-session-storage.test.ts
 * apps/mobile/src/lib/secureSessionStorage.ts のテスト (#1038 F7-06)
 *
 * - セッションは端末の安全な保管庫に置き、平文の AsyncStorage には残さない
 * - 保管庫の 1 値の上限 (2048 バイト) を超えないよう、分けて保存する
 * - 旧バージョンが AsyncStorage に置いた平文のセッションは、最初に読んだときに保管庫へ移す
 * - 保管庫に書けない端末でもログインできなくならない (AsyncStorage に退避)
 * - iOS の Keychain はアプリ削除後も残るので、再インストール後に前のセッションを復活させない
 */

import {
  INSTALL_MARKER_KEY,
  createSecureSessionStorage,
  splitIntoChunks,
  type LegacyStorageLike,
  type SecureSessionStorageIssue,
  type SecureStoreLike,
} from '../../src/lib/secureSessionStorage';

const KEY = 'sb-abcdefgh-auth-token';

// ── テスト用の保管庫 (メモリ) ─────────────────────────────────────────────────
function createFakeSecureStore() {
  const data = new Map<string, string>();
  const state = {
    failSet: undefined as undefined | ((key: string, value: string) => boolean),
    failGet: undefined as undefined | ((key: string) => boolean),
    setOptions: [] as Array<unknown>,
    getCalls: 0,
    getKeys: [] as string[],
    setCalls: 0,
  };
  const store: SecureStoreLike = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
    async getItemAsync(key) {
      state.getCalls += 1;
      state.getKeys.push(key);
      if (!/^[\w.-]+$/.test(key)) throw new Error(`Invalid key: ${key}`);
      if (state.failGet?.(key)) throw new Error('keychain is locked');
      return data.has(key) ? (data.get(key) as string) : null;
    },
    async setItemAsync(key, value, options) {
      state.setCalls += 1;
      if (!/^[\w.-]+$/.test(key)) throw new Error(`Invalid key: ${key}`);
      if (state.failSet?.(key, value)) throw new Error('keystore write failed');
      state.setOptions.push(options);
      data.set(key, value);
    },
    async deleteItemAsync(key) {
      if (!/^[\w.-]+$/.test(key)) throw new Error(`Invalid key: ${key}`);
      data.delete(key);
    },
  };
  return { store, data, state };
}

// ── テスト用の AsyncStorage (メモリ) ──────────────────────────────────────────
function createFakeLegacy() {
  const data = new Map<string, string>();
  const state = { failSet: false, failGet: false };
  const legacy: LegacyStorageLike = {
    async getItem(key) {
      if (state.failGet) throw new Error('async storage unavailable');
      return data.has(key) ? (data.get(key) as string) : null;
    },
    async setItem(key, value) {
      if (state.failSet) throw new Error('async storage is full');
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
  return { legacy, data, state };
}

function setup() {
  const secure = createFakeSecureStore();
  const legacy = createFakeLegacy();
  const issues: Array<SecureSessionStorageIssue> = [];
  let clock = 1_700_000_000_000;
  const storage = createSecureSessionStorage({
    secureStore: secure.store,
    legacyStorage: legacy.legacy,
    onIssue: (issue) => issues.push(issue),
    now: () => (clock += 1000),
  });
  /** 再起動のつもりで、同じ保存先から storage を作り直す (メモリのキャッシュだけが消える) */
  const restart = () =>
    createSecureSessionStorage({
      secureStore: secure.store,
      legacyStorage: legacy.legacy,
      onIssue: (issue) => issues.push(issue),
      now: () => (clock += 1000),
    });
  return { storage, restart, secure, legacy, issues };
}

/** 本物のセッションに近い JSON (JWT 2 本 + user のメタデータ)。約 3.5KB */
function makeSessionJson(extra: Record<string, unknown> = {}): string {
  const jwtLike = (n: number) => `eyJhbGciOiJIUzI1NiIs.${'a1B2c3D4e5'.repeat(n)}.signaturesignaturesignature`;
  // Google ログインでは provider_token なども入るため、実際のセッションは 3〜5KB になる
  return JSON.stringify({
    access_token: jwtLike(180),
    provider_token: jwtLike(120),
    refresh_token: 'v1.MR5OBK2qk3lA9wxkmjm0YRkd0tg9FdcYT5CqvW9_pw9nE0j',
    expires_in: 3600,
    expires_at: 1_900_000_000,
    token_type: 'bearer',
    user: {
      id: '0c6a3b7e-1111-4222-8333-944455556666',
      email: 'user@example.com',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { nickname: 'ほめゴハン太郎' },
      identities: [{ provider: 'email', identity_data: { email: 'user@example.com' } }],
    },
    ...extra,
  });
}

const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('splitIntoChunks', () => {
  it('ASCII だけなら 1500 文字ずつ、日本語を含むなら 500 文字ずつに分ける (どちらも UTF-8 で 2048 バイト未満)', () => {
    const ascii = 'a'.repeat(3200);
    expect(splitIntoChunks(ascii).map((c) => c.length)).toEqual([1500, 1500, 200]);

    const wide = 'あ'.repeat(1200);
    const chunks = splitIntoChunks(wide);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 200]);
    for (const chunk of chunks) expect(utf8Bytes(chunk)).toBeLessThan(2048);
  });

  it('サロゲートペア (絵文字) を断片の境目で割らない', () => {
    // 499 文字 + 絵文字(2 単位) が 500 の境目をまたぐ並び
    const value = `${'あ'.repeat(499)}😀${'い'.repeat(10)}`;
    const chunks = splitIntoChunks(value);
    expect(chunks.join('')).toBe(value);
    for (const chunk of chunks) {
      // どの断片も UTF-8 に変換して元に戻せる = ペアが割れていない
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
    }
  });

  it('空文字は 1 断片、結合すれば元に戻る', () => {
    expect(splitIntoChunks('')).toEqual(['']);
    const value = `x${'あ'.repeat(777)}y`;
    expect(splitIntoChunks(value).join('')).toBe(value);
  });
});

describe('createSecureSessionStorage — 保存と読み出し', () => {
  it('セッションを保管庫に置き、平文の AsyncStorage にはトークンを残さない (#1038 F7-06)', async () => {
    const { storage, secure, legacy } = setup();
    const json = makeSessionJson();

    await storage.setItem(KEY, json);

    // 平文の保存先 (AsyncStorage) にはセッションもトークンも無い。あるのは「入っている」印だけ
    expect([...legacy.data.keys()]).toEqual([INSTALL_MARKER_KEY]);
    expect(JSON.stringify([...legacy.data.values()])).not.toContain('access_token');
    expect(JSON.stringify([...legacy.data.values()])).not.toContain('eyJhbGci');
    // 保管庫には目次と断片がある
    expect(secure.data.has(KEY)).toBe(true);
    expect([...secure.data.values()].join('')).toContain('eyJhbGci');
  });

  it('保管庫の 1 値は 2048 バイト未満 (複数に分けて保存)。再起動後も同じ値を読める', async () => {
    const { storage, restart, secure } = setup();
    const json = makeSessionJson();
    expect(utf8Bytes(json)).toBeGreaterThan(2048); // 1 値には収まらない大きさ

    await storage.setItem(KEY, json);

    for (const value of secure.data.values()) expect(utf8Bytes(value)).toBeLessThan(2048);
    expect(secure.data.size).toBeGreaterThan(2); // 目次 + 2 つ以上の断片

    expect(await restart().getItem(KEY)).toBe(json);
  });

  it('日本語・絵文字を含むセッションも欠けずに往復し、1 値は 2048 バイト未満', async () => {
    const { storage, restart, secure } = setup();
    const json = makeSessionJson({ user_metadata: { nickname: 'ほめゴハン'.repeat(300) + '😀'.repeat(50) } });

    await storage.setItem(KEY, json);

    for (const value of secure.data.values()) expect(utf8Bytes(value)).toBeLessThan(2048);
    expect(await restart().getItem(KEY)).toBe(json);
  });

  it('保管庫のキーは SecureStore の規則 (英数字 . - _) に合う。Supabase の他のキー (code-verifier) も同様', async () => {
    const { storage, secure } = setup();

    await storage.setItem(`${KEY}-code-verifier`, 'verifier-1234567890');
    await storage.setItem('weird key/with:chars', 'v');

    for (const key of secure.data.keys()) expect(key).toMatch(/^[\w.-]+$/);
  });

  it('保存していないキーは null', async () => {
    const { storage } = setup();
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it('空文字も保存できる', async () => {
    const { storage, restart } = setup();
    await storage.setItem(KEY, '');
    expect(await restart().getItem(KEY)).toBe('');
  });

  it('端末の初回ロック解除後に読める・バックアップで他の端末へ移らない設定で書く', async () => {
    const { storage, secure } = setup();
    await storage.setItem(KEY, makeSessionJson());

    expect(secure.state.setOptions.length).toBeGreaterThan(0);
    for (const options of secure.state.setOptions) {
      expect(options).toEqual({ keychainAccessible: 1 }); // AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
    }
  });

  it('上書きすると新しい世代に切り替わり、古い断片は消える (保管庫のキーが増え続けない)', async () => {
    const { storage, restart, secure } = setup();
    const first = makeSessionJson();
    const second = makeSessionJson({ expires_at: 1_900_003_600 });

    await storage.setItem(KEY, first);
    const sizeAfterFirst = secure.data.size;
    await storage.setItem(KEY, second);
    await storage.setItem(KEY, first);

    expect(secure.data.size).toBe(sizeAfterFirst);
    expect(await restart().getItem(KEY)).toBe(first);
  });

  it('値が小さくなったときも、使わなくなった断片を残さない', async () => {
    const { storage, secure } = setup();
    await storage.setItem(KEY, makeSessionJson());
    await storage.setItem(KEY, 'small');

    expect(secure.data.size).toBe(2); // 目次 + 断片 1 つ
  });

  it('2 回目以降の読み出しはメモリから返し、保管庫に問い合わせない (getSession() は API 呼び出しごとに走るため)', async () => {
    const { restart, secure, storage } = setup();
    await storage.setItem(KEY, makeSessionJson());
    const fresh = restart();

    await fresh.getItem(KEY);
    const callsAfterFirstRead = secure.state.getCalls;
    await fresh.getItem(KEY);
    await fresh.getItem(KEY);

    expect(secure.state.getCalls).toBe(callsAfterFirstRead);
  });

  it('同時に呼んでも壊れない (操作は 1 つずつ順に実行される)', async () => {
    const { storage, restart } = setup();
    const a = makeSessionJson({ expires_at: 1 });
    const b = makeSessionJson({ expires_at: 2 });
    const c = makeSessionJson({ expires_at: 3 });

    await Promise.all([storage.setItem(KEY, a), storage.setItem(KEY, b), storage.setItem(KEY, c)]);

    expect(await storage.getItem(KEY)).toBe(c);
    expect(await restart().getItem(KEY)).toBe(c);
  });
});

describe('createSecureSessionStorage — 削除', () => {
  it('removeItem は保管庫と AsyncStorage の両方から消し、メモリの値も捨てる', async () => {
    const { storage, restart, secure, legacy } = setup();
    await storage.setItem(KEY, makeSessionJson());
    legacy.data.set(KEY, 'legacy-plaintext'); // 万一 AsyncStorage に残っていても消す

    await storage.removeItem(KEY);

    expect(secure.data.size).toBe(0);
    expect(legacy.data.has(KEY)).toBe(false);
    expect(await storage.getItem(KEY)).toBeNull();
    expect(await restart().getItem(KEY)).toBeNull();
  });

  it('存在しないキーを消してもエラーにならない', async () => {
    const { storage } = setup();
    await expect(storage.removeItem(KEY)).resolves.toBeUndefined();
  });

  it('保管庫の削除に失敗しても例外にしない (サインアウトを止めない)。失敗は通知する', async () => {
    const { storage, secure, issues } = setup();
    await storage.setItem(KEY, makeSessionJson());
    const original = secure.store.deleteItemAsync;
    secure.store.deleteItemAsync = async () => {
      throw new Error('delete failed');
    };

    await expect(storage.removeItem(KEY)).resolves.toBeUndefined();

    secure.store.deleteItemAsync = original;
    expect(issues).toContain('secure_delete_failed');
    // 画面側の状態は「ログアウト済み」(メモリは空)
    expect(await storage.getItem(KEY)).toBeNull();
  });
});

describe('createSecureSessionStorage — 旧バージョンからの移行', () => {
  it('AsyncStorage に平文で保存されていたセッションを、最初に読んだときに保管庫へ移して AsyncStorage から消す', async () => {
    const { storage, restart, secure, legacy } = setup();
    const json = makeSessionJson();
    legacy.data.set(KEY, json); // 旧バージョンが保存したセッション

    expect(await storage.getItem(KEY)).toBe(json);

    expect(legacy.data.has(KEY)).toBe(false); // 平文は消えた
    expect(legacy.data.get(INSTALL_MARKER_KEY)).toBe('1');
    expect(secure.data.has(KEY)).toBe(true);
    // 次回以降は保管庫から読める
    expect(await restart().getItem(KEY)).toBe(json);
  });

  it('保管庫に書けなかったときは、平文のまま残して値は返す (次回また移行を試す)', async () => {
    const { storage, restart, secure, legacy, issues } = setup();
    const json = makeSessionJson();
    legacy.data.set(KEY, json);
    secure.state.failSet = () => true;

    expect(await storage.getItem(KEY)).toBe(json);
    expect(issues).toContain('migration_failed');
    expect(legacy.data.get(KEY)).toBe(json); // 失うよりは平文で持ち続ける

    // 保管庫が使えるようになったら、再起動後の最初の読み出しで移る
    secure.state.failSet = undefined;
    expect(await restart().getItem(KEY)).toBe(json);
    expect(legacy.data.has(KEY)).toBe(false);
    expect(secure.data.has(KEY)).toBe(true);
  });

  it('移行済みで AsyncStorage に印がある端末では、保管庫の値をそのまま使う', async () => {
    const { storage, restart, legacy } = setup();
    await storage.setItem(KEY, makeSessionJson());
    expect(legacy.data.get(INSTALL_MARKER_KEY)).toBe('1');

    expect(await restart().getItem(KEY)).toBe(makeSessionJson());
  });
});

describe('createSecureSessionStorage — 保管庫に書けない端末', () => {
  it('書き込みに失敗したら AsyncStorage に退避し、ログインを失敗させない。読み出しもできる', async () => {
    const { storage, restart, secure, legacy, issues } = setup();
    const json = makeSessionJson();
    secure.state.failSet = () => true;

    await expect(storage.setItem(KEY, json)).resolves.toBeUndefined();

    expect(issues).toContain('secure_write_failed');
    expect(legacy.data.get(KEY)).toBe(json);
    expect(await storage.getItem(KEY)).toBe(json);
    expect(await restart().getItem(KEY)).toBe(json);
  });

  it('途中の断片で失敗しても、古い世代が壊れず読め、書きかけの断片は残らない', async () => {
    const { storage, restart, secure } = setup();
    const first = makeSessionJson({ expires_at: 1 });
    await storage.setItem(KEY, first);
    const sizeBefore = secure.data.size;

    // 2 つ目の断片の書き込みで失敗させる
    let writes = 0;
    secure.state.failSet = () => {
      writes += 1;
      return writes === 2;
    };
    await storage.setItem(KEY, makeSessionJson({ expires_at: 2 }));
    secure.state.failSet = undefined;

    // 保管庫側は古い世代のまま (書きかけの断片は掃除されている)
    expect(secure.data.size).toBe(sizeBefore);
    // 新しい値は退避先に入っているので、読み出しは新しい値になる
    expect(await restart().getItem(KEY)).toBe(makeSessionJson({ expires_at: 2 }));
  });
});

describe('createSecureSessionStorage — 再インストールと壊れた値', () => {
  it('アプリを削除して入れ直した後 (AsyncStorage の印が無いのに Keychain に値がある) は、前のセッションを復活させず消す', async () => {
    const { storage, restart, secure, legacy, issues } = setup();
    await storage.setItem(KEY, makeSessionJson());
    // アプリ削除: AsyncStorage は消えるが Keychain は残る
    legacy.data.clear();

    expect(await restart().getItem(KEY)).toBeNull();

    expect(issues).toContain('reinstall_leftover_removed');
    expect(secure.data.size).toBe(0);
  });

  it('保管庫の読み出しが一時的に失敗しても、値は消さない (端末のロック中など)。直れば読める', async () => {
    const { storage, restart, secure, issues } = setup();
    const json = makeSessionJson();
    await storage.setItem(KEY, json);
    const sizeBefore = secure.data.size;

    secure.state.failGet = () => true;
    const fresh = restart();
    expect(await fresh.getItem(KEY)).toBeNull();
    expect(issues).toContain('secure_read_failed');
    expect(secure.data.size).toBe(sizeBefore);

    secure.state.failGet = undefined;
    expect(await fresh.getItem(KEY)).toBe(json);
  });

  it('断片が欠けた (目次だけ残った) 値は null として扱い、掃除する', async () => {
    const { storage, restart, secure, issues } = setup();
    await storage.setItem(KEY, makeSessionJson());
    const chunkKeys = [...secure.data.keys()].filter((k) => k !== KEY);
    secure.data.delete(chunkKeys[0]);

    expect(await restart().getItem(KEY)).toBeNull();

    expect(issues).toContain('corrupt_entry_removed');
    expect(secure.data.size).toBe(0);
  });

  it('目次が壊れた値も null として扱い、掃除する', async () => {
    const { restart, secure, legacy, issues } = setup();
    legacy.data.set(INSTALL_MARKER_KEY, '1');
    secure.data.set(KEY, 'not-a-manifest');

    expect(await restart().getItem(KEY)).toBeNull();

    expect(issues).toContain('corrupt_entry_removed');
    expect(secure.data.has(KEY)).toBe(false);
  });

  it('異常に大きい目次 (断片数) は読みに行かない', async () => {
    const { restart, secure, legacy, issues } = setup();
    legacy.data.set(INSTALL_MARKER_KEY, '1');
    secure.data.set(KEY, 'v1.abc.9999');

    expect(await restart().getItem(KEY)).toBeNull();
    // 目次のキーしか問い合わせていない (9999 個の断片を読みに行かない)
    expect(new Set(secure.state.getKeys)).toEqual(new Set([KEY]));
    expect(issues).toContain('corrupt_entry_removed');
  });
});
