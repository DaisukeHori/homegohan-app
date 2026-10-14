/**
 * Supabase の認証セッション (access_token / refresh_token) を、端末の安全な保管庫
 * (iOS Keychain / Android Keystore) に保存する storage (#1038 F7-06)。
 *
 * 以前は AsyncStorage (平文) にセッションをそのまま保存していた。AsyncStorage は端末のバックアップや
 * ファイルシステムの読み取りで中身が見えるため、refresh_token (= 長期間有効なログイン権限) を置くのに向かない。
 *
 * ## 保存の仕方
 * expo-secure-store は 1 つの値を 2048 バイトまでに制限している (超えると警告。将来の SDK ではエラーになり得る)。
 * セッションは 3〜4KB あるので、値を小さく分けて (チャンク) 保管庫に置く。
 *   - `<key>`                  : 目次 "v1.<世代>.<チャンク数>"
 *   - `<key>.<世代>.<番号>`    : 値の断片
 * 書き込みは「新しい世代の断片 → 目次 → 古い世代の断片の削除」の順に行い、途中で失敗しても
 * 読み手が新旧の断片を混ぜて読むことがないようにする (目次を切り替えた瞬間に新しい世代へ移る)。
 *
 * Supabase 公式ドキュメントの「乱数鍵を SecureStore、暗号化したセッションを AsyncStorage」方式は、
 * 暗号ライブラリ (aes-js) と乱数のネイティブモジュールを追加し、自前の暗号処理 (認証タグ無しの AES-CTR) を持つことになる。
 * OS の保管庫に直接置くほうが部品が少なく、暗号処理の誤りを持ち込まないため、こちらにした。
 *
 * ## 移行と注意点
 * - 旧バージョンが AsyncStorage に保存した平文のセッションは、最初に読んだときに保管庫へ移して AsyncStorage から消す
 * - 保管庫に書けない端末 (Keystore の破損など) でログインできなくならないよう、書き込みに失敗したときだけ
 *   AsyncStorage に退避する。次に読んだときに保管庫への移行を再び試みる
 * - 保管庫に書けたのに平文の削除だけが失敗すると、平文には使用済み (ローテーション済み) の古いセッションが残る。
 *   AsyncStorage に値があるときは、セッションの有効期限 (expires_at) を保管庫の値と比べ、保管庫のほうが新しければ
 *   保管庫を採って平文を消す (古い平文で新しい値を上書きすると、使用済みの refresh_token でセッションごと失効し得る)
 * - iOS の Keychain はアプリを削除しても残る (AsyncStorage は消える)。再インストール後に前のセッションが
 *   復活しないよう、AsyncStorage に置いた印 (INSTALL_MARKER_KEY) が無いのに保管庫に値があるときは、
 *   再インストールの残りとみなして消す
 * - 値は読み取りのたびに保管庫へ問い合わせず、メモリにも持つ (getSession() は API 呼び出しごとに走るため)
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

/** supabase-js の auth.storage に渡せる形 (すべて Promise を返す) */
export type AuthStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

/** expo-secure-store のうち使う部分 (テストで差し替える) */
export type SecureStoreOptionsLike = { keychainAccessible?: number };

export type SecureStoreLike = {
  getItemAsync: (key: string, options?: SecureStoreOptionsLike) => Promise<string | null>;
  setItemAsync: (key: string, value: string, options?: SecureStoreOptionsLike) => Promise<void>;
  deleteItemAsync: (key: string, options?: SecureStoreOptionsLike) => Promise<void>;
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: number;
};

/** 旧来の保存先 (AsyncStorage) のうち使う部分 */
export type LegacyStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export type SecureSessionStorageDeps = {
  secureStore: SecureStoreLike;
  legacyStorage: LegacyStorageLike;
  /** 異常の通知先 (既定は console.warn だけ)。値そのものは渡さない */
  onIssue?: (event: SecureSessionStorageIssue, error?: unknown) => void;
  /** 世代名の元になる現在時刻 (テスト用) */
  now?: () => number;
};

export type SecureSessionStorageIssue =
  | "secure_write_failed"
  | "secure_read_failed"
  | "secure_delete_failed"
  | "migration_failed"
  | "corrupt_entry_removed"
  | "reinstall_leftover_removed"
  | "stale_legacy_removed";

/**
 * AsyncStorage に置く「この端末にこのアプリが入っている」印。
 * アプリを削除すると AsyncStorage は消えるので、印が無いのに Keychain に値があれば、再インストールの残りと分かる。
 */
export const INSTALL_MARKER_KEY = "homegohan_secure_session_installed_v1";

/** 1 つの断片の最大文字数。ASCII のみなら 1 文字 1 バイトなので 1500、日本語などを含むなら最大 3 バイトで 500 (どちらも 2048 バイト未満) */
const ASCII_CHUNK_CHARS = 1500;
const WIDE_CHUNK_CHARS = 500;

const MANIFEST_PATTERN = /^v1\.([0-9a-z]+)\.(\d{1,3})$/;
/** 異常に大きい目次 (壊れた値) で大量に読み込まないための上限。セッションは 10 断片に届かない */
const MAX_CHUNKS = 64;

/** SecureStore のキーは英数字と . - _ だけ使える。それ以外は _ にする */
function toSecureKey(key: string): string {
  return key.replace(/[^\w.-]/g, "_");
}

export function splitIntoChunks(value: string): string[] {
  // eslint-disable-next-line no-control-regex
  const isAscii = /^[\x00-\x7f]*$/.test(value);
  const size = isAscii ? ASCII_CHUNK_CHARS : WIDE_CHUNK_CHARS;
  if (value.length === 0) return [""];

  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + size, value.length);
    // サロゲートペアを断片の境目で割らない (割ると UTF-8 に直せず値が壊れる)
    if (end < value.length) {
      const last = value.charCodeAt(end - 1);
      if (last >= 0xd800 && last < 0xdc00) end -= 1;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * セッション (JSON) の有効期限 (expires_at。秒)。新しいセッションほど大きい。
 * セッションの JSON でない値 (PKCE の code-verifier など) や、expires_at が無い値は null。
 */
function sessionExpiresAt(value: string): number | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const expiresAt = (parsed as { expires_at?: unknown } | null)?.expires_at;
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

type Manifest = { generation: string; count: number };

function parseManifest(raw: string): Manifest | null {
  const match = MANIFEST_PATTERN.exec(raw);
  if (!match) return null;
  const count = Number(match[2]);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) return null;
  return { generation: match[1], count };
}

function formatManifest(manifest: Manifest): string {
  return `v1.${manifest.generation}.${manifest.count}`;
}

// 既定の通知先は端末のコンソールだけ。
//  - PostHog などの外部の計測サービスには送らない (#1166)。
//  - サーバーログ (POST /api/log) にも送らない。送るにはログイン中のアクセストークンが要り、それを取る
//    supabase.auth.getSession() がこの storage を読む。異常の通知から、この storage を呼び直す形になってしまう。
const defaultOnIssue = (event: SecureSessionStorageIssue, error?: unknown): void => {
  const e = error as { message?: unknown } | null | undefined;
  console.warn(`[secureSessionStorage] ${event}`, typeof e?.message === "string" ? e.message : "");
};

/**
 * セッション用の storage を作る。
 * 同時に呼ばれた操作は 1 つずつ順に実行する (移行や世代の切り替えが交互に走って壊れるのを防ぐ)。
 */
export function createSecureSessionStorage(deps: SecureSessionStorageDeps): AuthStorage {
  const { secureStore, legacyStorage } = deps;
  const onIssue = deps.onIssue ?? defaultOnIssue;
  const now = deps.now ?? Date.now;

  const writeOptions: SecureStoreOptionsLike | undefined =
    secureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY !== undefined
      ? // 端末の初回ロック解除後は読める (バックグラウンド起動でも読める) が、バックアップ復元で別の端末へは移らない
        { keychainAccessible: secureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
      : undefined;

  /** 読み出し済みの値。ここに無いときだけ保管庫に問い合わせる */
  const cache = new Map<string, string>();
  /**
   * removeItem 済みで、まだ setItem されていないキー。
   * 保管庫の削除に失敗しても、このプロセスの間は「消えた」ままにする (サインアウトした直後にセッションが復活しないように)
   */
  const removed = new Set<string>();
  let installMarker: boolean | undefined;
  let generationCounter = 0;

  // ── 直列化 ──────────────────────────────────────────────────────────────
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  // ── 保管庫の読み書き ─────────────────────────────────────────────────────
  const chunkKey = (secureKey: string, m: Manifest, index: number) => `${secureKey}.${m.generation}.${index}`;

  async function readManifest(secureKey: string): Promise<{ raw: string | null; manifest: Manifest | null }> {
    const raw = await secureStore.getItemAsync(secureKey);
    return { raw, manifest: raw === null ? null : parseManifest(raw) };
  }

  type SecureRead = { status: "ok"; value: string } | { status: "absent" } | { status: "corrupt" };

  async function readSecure(secureKey: string): Promise<SecureRead> {
    const { raw, manifest } = await readManifest(secureKey);
    if (raw === null) return { status: "absent" };
    if (!manifest) return { status: "corrupt" };
    const parts = await Promise.all(
      Array.from({ length: manifest.count }, (_, i) => secureStore.getItemAsync(chunkKey(secureKey, manifest, i))),
    );
    if (parts.some((part) => part === null)) return { status: "corrupt" };
    return { status: "ok", value: parts.join("") };
  }

  async function deleteGeneration(secureKey: string, manifest: Manifest): Promise<void> {
    await Promise.all(
      Array.from({ length: manifest.count }, (_, i) =>
        secureStore.deleteItemAsync(chunkKey(secureKey, manifest, i)).catch(() => undefined),
      ),
    );
  }

  /** 保管庫から消す (目次と、その世代の断片)。失敗しても例外は投げない */
  async function removeSecure(secureKey: string): Promise<void> {
    try {
      const { manifest } = await readManifest(secureKey);
      if (manifest) await deleteGeneration(secureKey, manifest);
      await secureStore.deleteItemAsync(secureKey);
    } catch (error) {
      onIssue("secure_delete_failed", error);
    }
  }

  function nextGeneration(): string {
    generationCounter += 1;
    return `${now().toString(36)}${generationCounter.toString(36)}`;
  }

  async function writeSecure(secureKey: string, value: string): Promise<void> {
    let previous: Manifest | null = null;
    try {
      previous = (await readManifest(secureKey)).manifest;
    } catch {
      previous = null; // 古い世代が分からなくても書き込みは続ける (断片が少し残るだけ)
    }

    const chunks = splitIntoChunks(value);
    const manifest: Manifest = { generation: nextGeneration(), count: chunks.length };
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        await secureStore.setItemAsync(chunkKey(secureKey, manifest, i), chunks[i], writeOptions);
      }
      // 目次を最後に切り替える。ここまでに失敗すれば、読み手には古い世代がそのまま見える
      await secureStore.setItemAsync(secureKey, formatManifest(manifest), writeOptions);
    } catch (error) {
      await deleteGeneration(secureKey, manifest);
      throw error;
    }
    if (previous) await deleteGeneration(secureKey, previous);
  }

  async function hasInstallMarker(): Promise<boolean> {
    if (installMarker === undefined) {
      try {
        installMarker = (await legacyStorage.getItem(INSTALL_MARKER_KEY)) === "1";
      } catch {
        // AsyncStorage が読めないときは、セッションを消さない側 (印あり) に倒す
        return true;
      }
    }
    return installMarker;
  }

  async function markInstalled(): Promise<void> {
    if (installMarker === true) return;
    try {
      await legacyStorage.setItem(INSTALL_MARKER_KEY, "1");
      installMarker = true;
    } catch {
      // 印を書けなくても動く (次回の読み取りで保管庫の値を消してしまう恐れがあるので、上のキャッシュは更新しない)
    }
  }

  /**
   * 旧来の AsyncStorage に値が残っているとき、保管庫のほうが新しければ、保管庫の値を返す (そうでなければ null)。
   *
   * 保管庫への書き込みは成功したのに、平文 (AsyncStorage) の削除が失敗すると、平文には使用済み (ローテーション済み) の
   * 古いセッションが残る。次の起動でそれを「最新」として保管庫へ移すと、新しい値を古い値で上書きしてしまい、
   * 使用済みの refresh_token をサーバーが再利用とみなして、セッションごと失効し得る (強制ログアウト)。
   * そこで、セッション (JSON) の有効期限 (expires_at) が新しいほうを採る。比べられないとき
   * (JSON でない・expires_at が無い) は、これまでどおり平文を最新とする (保管庫に書けなかったときの退避先は平文のほうが新しい)。
   */
  async function secureValueNewerThan(secureKey: string, legacyValue: string): Promise<string | null> {
    const legacyExpiresAt = sessionExpiresAt(legacyValue);
    if (legacyExpiresAt === null) return null;
    // このインストールが保管庫を使った印が無いときは、保管庫の値は再インストールの残りかもしれないので採らない
    if (!(await hasInstallMarker())) return null;

    let read: SecureRead;
    try {
      read = await readSecure(secureKey);
    } catch {
      return null;
    }
    if (read.status !== "ok") return null;
    const secureExpiresAt = sessionExpiresAt(read.value);
    return secureExpiresAt !== null && secureExpiresAt > legacyExpiresAt ? read.value : null;
  }

  // ── 公開する操作 ─────────────────────────────────────────────────────────
  async function loadFresh(key: string): Promise<string | null> {
    const secureKey = toSecureKey(key);

    // 1. 旧来の AsyncStorage。移行前の平文のセッションか、保管庫に書けなかったときの退避先。
    //    ここに値があるものを最新として扱い、保管庫へ移す (移せなければそのまま使い続ける)。
    //    ただし、保管庫のほうが新しいときは、平文は消し損ねた古い残りなので、保管庫の値を使って平文を消す
    let legacyValue: string | null = null;
    try {
      legacyValue = await legacyStorage.getItem(key);
    } catch {
      legacyValue = null;
    }
    if (legacyValue !== null) {
      const newerSecureValue = await secureValueNewerThan(secureKey, legacyValue);
      if (newerSecureValue !== null) {
        onIssue("stale_legacy_removed");
        try {
          await legacyStorage.removeItem(key);
        } catch (error) {
          onIssue("migration_failed", error); // 消せなくても、次の読み出しでまた同じ判断をする
        }
        return newerSecureValue;
      }
      try {
        await writeSecure(secureKey, legacyValue);
        await markInstalled();
        await legacyStorage.removeItem(key);
      } catch (error) {
        onIssue("migration_failed", error);
      }
      return legacyValue;
    }

    // 2. 保管庫
    let read: SecureRead;
    try {
      read = await readSecure(secureKey);
    } catch (error) {
      // 端末のロック中・一時的な失敗など。値は消さずに「今回は無い」ことにする
      onIssue("secure_read_failed", error);
      return null;
    }
    if (read.status === "absent") return null;
    if (read.status === "corrupt") {
      onIssue("corrupt_entry_removed");
      await removeSecure(secureKey);
      return null;
    }
    if (!(await hasInstallMarker())) {
      // 印が無いのに値がある = アプリを削除して入れ直した後の Keychain の残り。前のユーザーのセッションを復活させない
      onIssue("reinstall_leftover_removed");
      await removeSecure(secureKey);
      return null;
    }
    return read.value;
  }

  return {
    getItem: (key) =>
      serialized(async () => {
        if (removed.has(key)) return null;
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
        const value = await loadFresh(key);
        if (value !== null) cache.set(key, value);
        return value;
      }),

    setItem: (key, value) =>
      serialized(async () => {
        const secureKey = toSecureKey(key);
        try {
          await writeSecure(secureKey, value);
        } catch (error) {
          // 保管庫に書けない端末でもログインできなくならないよう、旧来の保存先へ退避する (次に読んだときに移行を再試行する)
          onIssue("secure_write_failed", error);
          await legacyStorage.setItem(key, value);
          removed.delete(key);
          cache.set(key, value);
          return;
        }
        removed.delete(key);
        cache.set(key, value);
        await markInstalled();
        try {
          // 平文の古い値を残さない
          await legacyStorage.removeItem(key);
        } catch {
          // ignore
        }
      }),

    removeItem: (key) =>
      serialized(async () => {
        cache.delete(key);
        removed.add(key);
        await removeSecure(toSecureKey(key));
        try {
          await legacyStorage.removeItem(key);
        } catch {
          // ignore
        }
      }),
  };
}

/** アプリで使う実体 (Keychain / Keystore + 移行元の AsyncStorage) */
export const secureSessionStorage: AuthStorage = createSecureSessionStorage({
  secureStore: SecureStore,
  legacyStorage: AsyncStorage,
});
