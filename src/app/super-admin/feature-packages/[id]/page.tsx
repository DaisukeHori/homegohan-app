"use client";

/**
 * /super-admin/feature-packages/[id] — 機能パッケージ詳細・編集
 *
 * 廃止の通信そのものが失敗した (fetch が reject した) ときは、サーバーが廃止を済ませてから応答が切れたこともあるので、
 * 機能パッケージを読み直して今の状態とボタンを見せ、「廃止の応答を受け取れませんでした」の文を出す (#2073)。
 * 読み直さないと、古い「廃止する」をもう一度押して 409 (遷移表に無い変更) になり、自分の操作なのに
 * 「別の操作で機能パッケージの状態が先に変わっていました」と出る。
 * 廃止のあとの読み直し (409 のあと・通信の reject のあと) が失敗したら、文と「再試行」を出し、読み直せるまで「廃止する」を止める
 * (クーポンの詳細・プランの詳細と同じ。#2064・#2073)
 * 読み直しが 404 (読み直しの間に機能パッケージが消えた)・403 (権限が外れた・二段階認証の確認が要る)・401 (ログインが切れた) で断られたら、
 * 読み込み直しても変わらないので、その理由の文を出し「再試行」は出さず、「廃止する」を戻す (プラン・A/B テストの詳細と同じ。#2080)
 *
 * 機能フラグの一覧を変える保存は、最後に読んだ・保存した行の updated_at (expected_updated_at) を一緒に送る (#2195 V4)。
 * route はその値のままのときだけ書き、読んだあとに別の操作 (機能フラグの作成が basic に足したキー・別の運営の保存) が入っていたら
 * 409 CONFLICT_STALE_DATA で断る (古い一覧で、あとから足されたキーを消さない)。画面は 409 を受けたら行を読み直し、
 * 書きかけの入力欄は残して手を付けていない欄だけ今の値に揃え、いま保存されている機能フラグを入力欄の下に出して見比べてもらう
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { isStaleDataConflict, isStatusChangeConflict, operationFailureMessage } from '@/lib/admin/api-error-message';
import { FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE } from '@/lib/super-admin/feature-packages-schemas';
import {
  NO_RESPONSE_STATE_RELOADED_GUIDE,
  NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE,
  statusChangeNoResponseMessage,
} from '@/lib/super-admin/status-change-no-response';
import { rereadDetailRow } from '@/lib/super-admin/detail-reread';
import {
  AdminScreenError,
  adminActionHttpFailedMessage,
  adminActionNoResponseMessage,
  adminLoadFailedFallback,
  adminLoadFailedMessage,
  displayableAdminError,
  fetchAdminJson,
  readFailureBody,
  savedRowOfResponse,
  screenFailureMessage,
} from '@/lib/admin/admin-screen-messages';

/** 読み込みの失敗の文の対象 (「機能パッケージを読み込めませんでした (HTTP 502)」。#2093 W7) */
const FEATURE_PACKAGE_SUBJECT = '機能パッケージ';
/** 保存の失敗の文の操作の名前 (「保存に失敗しました (HTTP 502)」「保存の応答を受け取れませんでした（通信エラー）」。#2093 W7) */
const SAVE_ACTION = '保存';

type FeaturePackage = {
  id: string;
  package_key: string;
  display_name: string;
  description: string | null;
  feature_flags: string[];
  display_order: number;
  status: string;
  created_at: string;
  updated_at: string;
};

/** 機能フラグの入力欄 (改行かカンマ区切り) を、フラグの並びにする */
function parseFeatureFlags(raw: string): string[] {
  return raw.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);
}

/** 入力欄 (表示名・説明・機能フラグ・表示順) の値。機能フラグは入力欄の文字 (改行かカンマ区切り) のまま */
type FeaturePackageInputs = { displayName: string; description: string; featureFlagsRaw: string; displayOrder: number };

/** 機能パッケージの行から作る入力欄の値 (機能フラグは 1 行に 1 つ) */
function featurePackageInputsOf(pkg: FeaturePackage): FeaturePackageInputs {
  return {
    displayName: pkg.display_name,
    description: pkg.description ?? '',
    featureFlagsRaw: pkg.feature_flags.join('\n'),
    displayOrder: pkg.display_order,
  };
}

/**
 * 保存に成功したあとの 1 つの入力欄の値 (#1917)。保存を押したときの値 (atSave) から応答を待つあいだに変えていなければ
 * 保存の応答の行の値 (saved) にし、変えていれば書きかけとして残す (次の保存で送る)
 */
function inputAfterSave<T extends string | number>(current: T, atSave: T, saved: T): T {
  return current === atSave ? saved : current;
}

/**
 * 保存で送る本文 (PATCH /api/super-admin/feature-packages/{id} の表示名・説明・機能フラグ・表示順)。
 * expected_updated_at は書く値でなく書く条件 (#2195 V4。機能フラグを送るときだけ、最後に読んだ・保存した行の updated_at)
 */
type FeaturePackageSaveBody = {
  display_name?: string;
  description?: string | null;
  feature_flags?: string[];
  display_order?: number;
  expected_updated_at?: string;
};

/** 2 つの機能フラグの並びが同じか (並びで比べる) */
function sameFeatureFlags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((flag, i) => flag === b[i]);
}

/**
 * 保存で送る本文。最後に読んだ・保存した機能パッケージ (pkg) から変えた欄だけを入れる (#1917)。
 * 手を付けていない欄を送ると、画面を開いたあとに別の運営が変えたその欄を、開いたときの古い値で上書きしてしまう
 * (route は送られた項目をそのまま書く)。機能フラグは並びで比べる。説明の空欄は null にする (これまでと同じ)。
 * 手を付けていない入力欄は、読み込み・保存の成功・廃止の成功・廃止の 409 と通信の reject のあとの読み直しのたびに pkg の値に揃える (handleSave・handleDeprecate・retryReread の applyLatestPackage) ので、ここで pkg と違う欄は運営が変えた欄
 */
function changedFeaturePackageFields(
  inputs: { displayName: string; description: string; flags: string[]; displayOrder: number },
  pkg: FeaturePackage,
): FeaturePackageSaveBody {
  const body: FeaturePackageSaveBody = {};
  if (inputs.displayName !== pkg.display_name) body.display_name = inputs.displayName;
  if (inputs.description !== (pkg.description ?? '')) body.description = inputs.description || null;
  if (!sameFeatureFlags(inputs.flags, pkg.feature_flags)) body.feature_flags = inputs.flags;
  if (inputs.displayOrder !== pkg.display_order) body.display_order = inputs.displayOrder;
  return body;
}

/**
 * 保存の本文に、機能フラグを送るときだけ最後に読んだ・保存した行の updated_at (expected_updated_at) を添える (#2195 V4)。
 * 機能フラグは配列全体を書き換えるので、route はこの値のままのときだけ書く。ほかの欄だけの保存には添えない
 * (送った欄だけを書くので、読んだあとに別の操作が機能フラグを足していても、その欄を古い値で上書きしない。添えると無関係な変更で 409 になる)
 */
function withExpectedUpdatedAt(changes: FeaturePackageSaveBody, pkg: FeaturePackage): FeaturePackageSaveBody {
  return changes.feature_flags === undefined ? changes : { ...changes, expected_updated_at: pkg.updated_at };
}

/**
 * 読み直した行 (row) に、保存で送った欄 (changes) の値がもう全部入っているか (#2195 V4)。
 * 保存の応答を受け取れずに押し直した (1 回目がもう書いていた)・二度押しのときは、自分の操作で updated_at が変わって 409 になる。
 * このときは「別の操作で」と言わず、保存できた扱いにする
 */
function savedChangesAlreadyIn(changes: FeaturePackageSaveBody, row: FeaturePackage): boolean {
  if (changes.display_name !== undefined && changes.display_name !== row.display_name) return false;
  if (changes.description !== undefined && changes.description !== row.description) return false;
  if (changes.feature_flags !== undefined && !sameFeatureFlags(changes.feature_flags, row.feature_flags)) return false;
  if (changes.display_order !== undefined && changes.display_order !== row.display_order) return false;
  return true;
}

/** 保存を押したが、どの入力欄も最後に読んだ・保存した値から変えていなかったときの文 (送らない。#1917) */
const NO_FEATURE_PACKAGE_CHANGES_MESSAGE = '変更した項目がないので、保存していません';

/** 廃止が失敗したときの文の頭 (後ろに理由を添える) */
const DEPRECATE_FAILURE_SUMMARY = '廃止できませんでした';

/** 保存が 409 CONFLICT_STALE_DATA (読んだあとに別の操作が機能パッケージを変えていた) で断られたときの文の頭 (#2195 V4) */
const SAVE_CONFLICT_SUMMARY = '保存できませんでした';

/** 保存が 409 で断られたときの理由の文の頭 (#2195 V4) */
const SAVE_CONFLICT_REASON_HEAD = '別の操作で機能パッケージが先に変わっていました';

/** 保存が 409 で断られ、機能パッケージを読み直せたときの文 (#2195 V4。書きかけの入力欄は残す) */
const SAVE_CONFLICT_RELOADED_MESSAGE = `${SAVE_CONFLICT_SUMMARY}（${SAVE_CONFLICT_REASON_HEAD}。今の値を読み込み直しました。入力中の欄は残しているので、見比べてから、もう一度保存してください）`;

/**
 * 保存が 409 で断られ、読み直しも失敗したときの文 (#2195 V4)。画面の updated_at は古いままなので、もう一度保存すると
 * また 409 になって読み直す (読み直せるまで古い一覧で書くことはない)
 */
const SAVE_CONFLICT_RELOAD_FAILED_MESSAGE = `${SAVE_CONFLICT_SUMMARY}（${SAVE_CONFLICT_REASON_HEAD}。今の値を読み込めませんでした。もう一度保存すると、今の値を読み込み直します）`;

/** 保存が 409 で断られ、読み直しが 404 / 403 / 401 で断られたときの文 (#2195 V4。message は理由の文) */
function saveConflictUnavailableMessage(message: string): string {
  return `${SAVE_CONFLICT_SUMMARY}（${SAVE_CONFLICT_REASON_HEAD}。${message}）`;
}

/** 保存の 409 のあとに出す、いま保存されている機能フラグの見出し (#2195 V4) */
const SAVED_FEATURE_FLAGS_LABEL = 'いま保存されている機能フラグ';

/** 保存の 409 のあとに出す、いま保存されているのに入力中の一覧に無い機能フラグの見出し (#2195 V4) */
const SAVED_FEATURE_FLAGS_MISSING_LABEL = '入力中の一覧に無いもの';

/** 機能フラグを並べるときの区切り */
const FEATURE_FLAGS_SEPARATOR = ', ';

/**
 * 廃止が 409 (遷移表に無い変更・同時の変更) で断られたときの理由の文の頭 (#2064)。
 * 画面の status が古かった (別の操作で廃止されていた)。英字の状態の値は出さない
 */
const STATUS_CONFLICT_REASON_HEAD = '別の操作で機能パッケージの状態が先に変わっていました';

/** 廃止が 409 で断られ、機能パッケージを読み直せたときの理由の文 (#2064) */
const STATUS_CONFLICT_RELOADED_REASON = `${STATUS_CONFLICT_REASON_HEAD}。今の状態を読み込み直しました`;

/** 廃止が 409 で断られ、読み直しも失敗したときの理由の文 (「再試行」を出す。#2064・#2073) */
const STATUS_CONFLICT_RELOAD_FAILED_REASON = `${STATUS_CONFLICT_REASON_HEAD}。今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください`;

/** 読み直しが 404 (読み直しの間に機能パッケージが消えた) で断られたときの文。読み込み直しても変わらないので「再試行」は出さない (#2080) */
const FEATURE_PACKAGE_NOT_FOUND_ON_RELOAD_MESSAGE = '機能パッケージが見つかりません。一覧に戻って確かめてください';

/** 廃止の通信が reject されたときの文の操作の名前 (#2073) */
const DEPRECATE_OPERATION_NAME = '廃止';

/**
 * 廃止のあとに読み直す理由 (#2073)。
 *   - conflict   : 409 (遷移表に無い変更・同時の変更) で断られた (画面の status が古かった)
 *   - no-response: 通信が reject された (応答を受け取れず、廃止が済んだか分からない)
 */
type DeprecateRereadCause = 'conflict' | 'no-response';

/**
 * 廃止のあとの読み直しの結果 (#2064・#2073・#2080)。
 *   - reloaded   : 読み直せた
 *   - failed     : 読み直せなかった (「再試行」を出し、「廃止する」を止める)
 *   - unavailable: 404 / 403 / 401 で断られた (message は理由の文。読み込み直しても変わらないので「再試行」は出さない)
 */
type DeprecateRereadResult = { kind: 'reloaded' } | { kind: 'failed' } | { kind: 'unavailable'; message: string };

/** 廃止のあとに読み直した・読み直せなかった・読み直しが断られたときの文 (#2064・#2073・#2080) */
function deprecateRereadMessage(cause: DeprecateRereadCause, result: DeprecateRereadResult): string {
  if (cause === 'conflict') {
    const reason =
      result.kind === 'reloaded'
        ? STATUS_CONFLICT_RELOADED_REASON
        : result.kind === 'failed'
          ? STATUS_CONFLICT_RELOAD_FAILED_REASON
          : `${STATUS_CONFLICT_REASON_HEAD}。${result.message}`;
    return `${DEPRECATE_FAILURE_SUMMARY}（${reason}）`;
  }
  // 応答を受け取れなかった: 廃止が済んでいた (自分の操作) ときにも合うよう「できませんでした」「別の操作で」とは言わない
  const guide =
    result.kind === 'reloaded'
      ? NO_RESPONSE_STATE_RELOADED_GUIDE
      : result.kind === 'failed'
        ? NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE
        : result.message;
  return statusChangeNoResponseMessage(DEPRECATE_OPERATION_NAME, guide);
}

export default function FeaturePackageDetailPage() {
  const params = useParams();
  const pkgId = params.id as string;

  const [pkg, setPkg] = useState<FeaturePackage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // 編集フィールド
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [featureFlagsRaw, setFeatureFlagsRaw] = useState('');
  const [displayOrder, setDisplayOrder] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  // 保存を押したが送らなかったときの文 (変えた欄が無い。#1917)
  const [saveInfo, setSaveInfo] = useState('');
  // 廃止の応答を待っているか・失敗したときの文
  const [isDeprecating, setIsDeprecating] = useState(false);
  const [deprecateError, setDeprecateError] = useState('');
  // 保存か廃止のどちらかの応答を待っているか (#2050)。どちらの応答も、その行 (書いたあとの行) をそのまま画面の行にするので、
  // 2 つを重ねると、応答が送った順と逆に届いたとき、後に届いた古い方の行 (例: 廃止の前の status) が画面に残る。
  // 待つあいだは両方のボタンを止め、押されても送らない。ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  // 廃止のあとの読み直しが失敗し、まだ読み直せていないときの理由 (#2073)。あるあいだは文と「再試行」を出し、「廃止する」を止める。
  // ref は描画を待たずに handler で読むための写し
  const [pendingReread, setPendingReread] = useState<DeprecateRereadCause | null>(null);
  const pendingRereadRef = useRef<DeprecateRereadCause | null>(null);
  // 「再試行」の読み直しを待っているか
  const [isRereading, setIsRereading] = useState(false);
  const isWriting = isSaving || isDeprecating || isRereading;
  // 保存が 409 で断られて読み直したあと、次の保存に成功するまで true (#2195 V4)。あいだは、機能フラグの入力欄が
  // いま保存されている一覧 (pkg.feature_flags) と違えば、入力欄の下にその一覧と、入力中の一覧に無いものを出す (同じなら出さない)
  const [showSavedFlags, setShowSavedFlags] = useState(false);

  const fetchPkg = useCallback(async () => {
    setIsLoading(true);
    try {
      // 失敗の応答は ok を先に確かめて本文の日本語の文か「機能パッケージを読み込めませんでした (HTTP 502)」にし、通信そのものの失敗と
      // 200 の読めない本文だけを「（通信エラー）」にする (JSON でない 502 を「ネットワークエラー」と見せない。#2093 W7)
      const body = await fetchAdminJson(`/api/super-admin/feature-packages/${pkgId}`, FEATURE_PACKAGE_SUBJECT);
      const loaded = (body as { data?: FeaturePackage | null }).data;
      if (!loaded) throw new AdminScreenError(adminLoadFailedMessage(FEATURE_PACKAGE_SUBJECT, null));
      const inputs = featurePackageInputsOf(loaded);
      setPkg(loaded);
      setDisplayName(inputs.displayName);
      setDescription(inputs.description);
      setFeatureFlagsRaw(inputs.featureFlagsRaw);
      setDisplayOrder(inputs.displayOrder);
    } catch (err) {
      setError(displayableAdminError(err, adminLoadFailedFallback(FEATURE_PACKAGE_SUBJECT)));
    } finally {
      setIsLoading(false);
    }
  }, [pkgId]);

  useEffect(() => {
    fetchPkg();
  }, [fetchPkg]);

  /**
   * 書いたあと・読み直したあとの最新の行 (latest) を画面の行にする。入力欄は、inputsBefore (押したときの最後に読んだ・保存した行の値)
   * から変えていない欄だけ latest の値に揃え、書きかけは残す (inputAfterSave。#1917)
   */
  const applyLatestPackage = (latest: FeaturePackage, inputsBefore: FeaturePackageInputs) => {
    const latestInputs = featurePackageInputsOf(latest);
    setPkg(latest);
    setDisplayName((current) => inputAfterSave(current, inputsBefore.displayName, latestInputs.displayName));
    setDescription((current) => inputAfterSave(current, inputsBefore.description, latestInputs.description));
    setFeatureFlagsRaw((current) => inputAfterSave(current, inputsBefore.featureFlagsRaw, latestInputs.featureFlagsRaw));
    setDisplayOrder((current) => inputAfterSave(current, inputsBefore.displayOrder, latestInputs.displayOrder));
  };

  /** 廃止のあとの読み直しを待っている理由を記録する (null で外す。#2073) */
  const markPendingReread = (pending: DeprecateRereadCause | null) => {
    pendingRereadRef.current = pending;
    setPendingReread(pending);
  };

  /**
   * 409 のあと・通信の reject のあとに機能パッケージを読み直す (全体を「読み込み中」にしない。#2064・#2073)。
   * 404 / 403 / 401 は unavailable (理由の文つき。401 は「ログインし直してください」。src/lib/super-admin/detail-reread.ts の
   * rereadUnavailableMessage。#2080)、それ以外の失敗は failed
   */
  const rereadPackage = () =>
    rereadDetailRow<FeaturePackage>(`/api/super-admin/feature-packages/${pkgId}`, FEATURE_PACKAGE_NOT_FOUND_ON_RELOAD_MESSAGE);

  const handleSave = async () => {
    // 廃止の応答を待つあいだは送らない (#2050。writeInFlightRef)
    if (!pkg || writeInFlightRef.current) return;
    setSaveInfo('');
    const flags = parseFeatureFlags(featureFlagsRaw);
    if (flags.length === 0) {
      setSaveError('機能フラグを少なくとも1つ入力してください');
      return;
    }
    setSaveError('');
    setSaveSuccess(false);
    // 送るのは、最後に読んだ・保存した値から変えた欄だけ (手を付けていない欄を古い値で上書きしない。#1917)。
    // 押したときの入力欄の値は写しておく (応答を待つあいだに変えた欄を、保存の成功のあとに見分けるため)
    const inputsAtSave: FeaturePackageInputs = { displayName, description, featureFlagsRaw, displayOrder };
    const changes = changedFeaturePackageFields({ displayName, description, flags, displayOrder }, pkg);
    if (Object.keys(changes).length === 0) {
      setSaveInfo(NO_FEATURE_PACKAGE_CHANGES_MESSAGE);
      return;
    }
    // 押したときの最後に読んだ・保存した行から作る入力欄の値 (409 のあとの読み直しで、これと違う欄を書きかけとして残す。#2195 V4)
    const loadedInputs = featurePackageInputsOf(pkg);
    writeInFlightRef.current = true;
    setIsSaving(true);

    try {
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/feature-packages/${pkgId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withExpectedUpdatedAt(changes, pkg)),
        });
      } catch {
        throw new AdminScreenError(adminActionNoResponseMessage(SAVE_ACTION));
      }
      // ok を先に確かめる (JSON でない 502 を「ネットワークエラー」と見せない。本文に日本語の文が無ければ「保存に失敗しました (HTTP 502)」。#2093 W7)
      if (!res.ok) {
        const failureBody = await readFailureBody(res);
        // 読んだあとに別の操作が機能パッケージを変えていた (#2195 V4): 行を読み直し、書きかけは残して今の値を見せる
        if (isStaleDataConflict(res.status, failureBody)) {
          await rereadAfterSaveConflict(changes, loadedInputs, inputsAtSave);
          return;
        }
        throw new AdminScreenError(
          screenFailureMessage(res.status, failureBody) ?? adminActionHttpFailedMessage(SAVE_ACTION, res.status),
        );
      }
      // 成功の応答の本文が読めない: 保存は済んでいるかもしれないので、失敗とは言わず応答を受け取れなかった文にする (#2093 W7)
      const saved = await savedRowOfResponse<FeaturePackage>(res);
      if (!saved) throw new AdminScreenError(adminActionNoResponseMessage(SAVE_ACTION));
      // 保存の応答の行 (書いたあとの最新の行) を新しい比べる元にし、手を付けていない入力欄もその行の値に揃える (#1917)。
      // 送らなかった欄には、画面を開いたあとに別の運営が変えた値が入っていることがある。比べる元だけを新しくして入力欄を
      // 古い値のままにすると、その欄が変えた欄に見え、次の保存 (何も変えずに押しても) で開いたときの古い値を送って、
      // 別の運営の変更を上書きしてしまう。応答を待つあいだに変えた欄は書きかけとして残す (次の保存で送る)
      applyLatestPackage(saved, inputsAtSave);
      setSaveSuccess(true);
      setShowSavedFlags(false);
      // 保存の応答の行は書いたあとの最新の行 (status も今の値) なので、廃止のあとの読み直しの失敗は解ける (#2073)
      const pending = pendingRereadRef.current;
      if (pending) {
        setDeprecateError(deprecateRereadMessage(pending, { kind: 'reloaded' }));
        markPendingReread(null);
      }
    } catch (err) {
      setSaveError(displayableAdminError(err, `${SAVE_ACTION}に失敗しました`));
    } finally {
      writeInFlightRef.current = false;
      setIsSaving(false);
    }
  };

  /**
   * 保存が 409 CONFLICT_STALE_DATA で断られたあとに読み直し、結果に合わせて文を出す (#2195 V4)。
   * changes は送った欄、loadedInputs は押したときの最後に読んだ・保存した行の入力欄の値 (これと違う欄は書きかけとして残す。
   * 押したときに送った欄も残る)、inputsAtSave は押したときの入力欄の値。
   * 読み直した行に送った値がもう全部入っていれば (自分の 1 回目の保存がもう書いていた)、保存の成功と同じにする。
   * そうでなければ、次の保存に成功するまで、機能フラグの入力欄がいま保存されている一覧と違えば入力欄の下にその一覧を出す。
   * 読み直せなかったら画面の行 (updated_at) は古いままなので、もう一度保存するとまた 409 で読み直す (古い一覧では書かない)
   */
  const rereadAfterSaveConflict = async (
    changes: FeaturePackageSaveBody,
    loadedInputs: FeaturePackageInputs,
    inputsAtSave: FeaturePackageInputs,
  ) => {
    const outcome = await rereadPackage();
    if (outcome.kind === 'loaded') {
      const alreadySaved = savedChangesAlreadyIn(changes, outcome.row);
      if (alreadySaved) {
        // 保存の成功と同じ: 送った欄も含めて、押したときから変えていない欄を読み直した行の値に揃える
        applyLatestPackage(outcome.row, inputsAtSave);
        setSaveSuccess(true);
        setShowSavedFlags(false);
      } else {
        applyLatestPackage(outcome.row, loadedInputs);
        setShowSavedFlags(true);
        setSaveError(SAVE_CONFLICT_RELOADED_MESSAGE);
      }
      // 読み直した行は最新の行 (status も今の値) なので、廃止のあとの読み直しの失敗は解ける (#2073。保存の成功と同じ)
      const pending = pendingRereadRef.current;
      if (pending) {
        setDeprecateError(deprecateRereadMessage(pending, { kind: 'reloaded' }));
        markPendingReread(null);
      }
      return;
    }
    setSaveError(outcome.kind === 'failed' ? SAVE_CONFLICT_RELOAD_FAILED_MESSAGE : saveConflictUnavailableMessage(outcome.message));
  };

  /**
   * 廃止のあとに読み直し、結果に合わせて文を出す (#2064・#2073)。inputsBefore は押したときの最後に読んだ・保存した行の
   * 入力欄の値 (書きかけを残すため)。読み直せなかったら「再試行」を待つ理由として記録し、「廃止する」を止める。
   * 404 / 403 / 401 で断られたら、理由の文を出し、「再試行」は待たない (読み込み直しても変わらないので、ボタンを止め続けない。#2080)
   */
  const rereadAfterDeprecate = async (cause: DeprecateRereadCause, inputsBefore: FeaturePackageInputs) => {
    const outcome = await rereadPackage();
    if (outcome.kind === 'loaded') applyLatestPackage(outcome.row, inputsBefore);
    const result: DeprecateRereadResult =
      outcome.kind === 'loaded' ? { kind: 'reloaded' } : outcome.kind === 'failed' ? { kind: 'failed' } : outcome;
    setDeprecateError(deprecateRereadMessage(cause, result));
    markPendingReread(outcome.kind === 'failed' ? cause : null);
  };

  /** 「再試行」: 廃止のあとの失敗した読み直しをやり直す (#2073) */
  const retryReread = async () => {
    const pending = pendingRereadRef.current;
    if (!pkg || !pending || writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setIsRereading(true);
    try {
      await rereadAfterDeprecate(pending, featurePackageInputsOf(pkg));
    } finally {
      writeInFlightRef.current = false;
      setIsRereading(false);
    }
  };

  /**
   * 廃止。失敗の応答を黙って捨てず、理由を画面に出す (403 は理由の文 (二段階認証の確認が要る など) だけを通す。operationFailureMessage)。
   * 成功したら PATCH の応答の行 (書いたあとの最新の行) で表示を新しくする。全体を「読み込み中」にして読み直さない。
   * 入力欄は保存の経路と同じく、手を付けていない欄だけ応答の行の値に揃え、書きかけは残す (inputAfterSave。#1917)。
   * 保存の応答を待つあいだは送らない (#2050。writeInFlightRef)。
   * 409 で、画面の status が古かった (遷移表に無い変更 OP_FEATURE_PACKAGE_INVALID_TRANSITION・同時の変更 CONFLICT_STALE_DATA) ときは、
   * 機能パッケージを読み直して状態の表示とボタンを今の状態にし、日本語の文を出す (書きかけは残す。#2064)。
   * 通信が reject されたときも読み直す (サーバーが廃止を済ませてから応答が切れたことがあるため。#2073)。
   * 読み直しが失敗して、まだ読み直せていないあいだは送らない (#2073。画面の status が古いかもしれない)
   */
  const handleDeprecate = async () => {
    if (!pkg || writeInFlightRef.current || pendingRereadRef.current) return;
    if (!confirm('この機能パッケージを廃止しますか？')) return;
    // 押したときの最後に読んだ・保存した行から作る入力欄の値 (入力欄がこれと同じなら手を付けていない欄)
    const loadedInputs = featurePackageInputsOf(pkg);
    setDeprecateError('');
    writeInFlightRef.current = true;
    setIsDeprecating(true);
    try {
      const res = await fetch(`/api/super-admin/feature-packages/${pkgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'deprecated' }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (isStatusChangeConflict(res.status, body, FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE)) {
          await rereadAfterDeprecate('conflict', loadedInputs);
          return;
        }
        setDeprecateError(operationFailureMessage(DEPRECATE_FAILURE_SUMMARY, res.status, body));
        return;
      }
      // 応答は { data: 書いたあとの行 } (保存の経路と同じ形。route は .update().select() の行を返す)
      applyLatestPackage((await res.json() as { data: FeaturePackage }).data, loadedInputs);
    } catch {
      // 応答を受け取れなかった (通信が reject した: オフライン・接続が切れたなど。成功の応答の本文を読み切れなかったときも)。
      // 廃止が済んだかは分からないので、読み直して今の状態を見せる (#2073。rereadAfterDeprecate は投げない)
      await rereadAfterDeprecate('no-response', loadedInputs);
    } finally {
      writeInFlightRef.current = false;
      setIsDeprecating(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-slate-400">読み込み中...</div>;
  }

  if (error || !pkg) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        {error || '機能パッケージが見つかりません'}
      </div>
    );
  }

  const flags = parseFeatureFlags(featureFlagsRaw);
  // 保存の 409 のあと、機能フラグの入力欄がいま保存されている一覧と違うときだけ、その一覧を見せる (#2195 V4)
  const savedFlagsToCompare = showSavedFlags && !sameFeatureFlags(flags, pkg.feature_flags) ? pkg.feature_flags : null;
  const savedFlagsMissingFromInput = savedFlagsToCompare ? savedFlagsToCompare.filter((flag) => !flags.includes(flag)) : [];

  return (
    <div className="max-w-2xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/super-admin/feature-packages" className="text-slate-400 hover:text-slate-600 text-sm">
            ← 一覧
          </Link>
          <span className="text-slate-300">/</span>
          <h1 className="text-xl font-bold text-slate-900">{pkg.display_name}</h1>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            pkg.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
          }`}>
            {pkg.status === 'active' ? '有効' : '廃止'}
          </span>
        </div>
        {pkg.status === 'active' && (
          <button
            onClick={handleDeprecate}
            // 応答を待つあいだ・廃止のあとの読み直しが失敗してまだ読み直せていないあいだは止める (#2050・#2073)
            disabled={isWriting || pendingReread !== null}
            className="px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-xs font-medium hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            廃止する
          </button>
        )}
      </div>

      {deprecateError && (
        <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-center justify-between gap-4">
          <p role="alert" data-testid="status-change-error">
            {deprecateError}
          </p>
          {pendingReread && (
            <button
              type="button"
              onClick={() => void retryReread()}
              disabled={isWriting}
              className="shrink-0 underline whitespace-nowrap hover:text-red-900 disabled:opacity-50"
            >
              {isRereading ? '読み込み中...' : '再試行'}
            </button>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">パッケージの鍵</label>
          <code className="font-mono text-sm bg-slate-100 px-2 py-1 rounded">{pkg.package_key}</code>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">表示名 *</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => { setDisplayName(e.target.value); setSaveInfo(''); }}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
          <textarea
            value={description}
            onChange={(e) => { setDescription(e.target.value); setSaveInfo(''); }}
            rows={2}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">機能フラグ</label>
          <textarea
            value={featureFlagsRaw}
            onChange={(e) => { setFeatureFlagsRaw(e.target.value); setSaveInfo(''); }}
            rows={5}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {flags.map((flag) => (
              <span key={flag} className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded font-mono">
                {flag}
              </span>
            ))}
          </div>
          {savedFlagsToCompare && (
            <div
              data-testid="saved-feature-flags"
              className="mt-2 bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg text-xs space-y-1"
            >
              <p>
                {SAVED_FEATURE_FLAGS_LABEL}: <span className="font-mono">{savedFlagsToCompare.join(FEATURE_FLAGS_SEPARATOR)}</span>
              </p>
              {savedFlagsMissingFromInput.length > 0 && (
                <p data-testid="saved-feature-flags-missing">
                  {SAVED_FEATURE_FLAGS_MISSING_LABEL}: <span className="font-mono">{savedFlagsMissingFromInput.join(FEATURE_FLAGS_SEPARATOR)}</span>
                </p>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">表示順</label>
          <input
            type="number"
            value={displayOrder}
            onChange={(e) => { setDisplayOrder(Number(e.target.value)); setSaveInfo(''); }}
            min="0"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        {saveError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {saveError}
          </div>
        )}
        {saveInfo && (
          <div
            data-testid="save-info"
            className="bg-slate-50 border border-slate-200 text-slate-600 px-4 py-3 rounded-lg text-sm"
          >
            {saveInfo}
          </div>
        )}
        {saveSuccess && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
            保存しました
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            onClick={handleSave}
            disabled={isWriting}
            className="px-5 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
          >
            {isSaving ? '保存中...' : '保存する'}
          </button>
        </div>
      </div>
    </div>
  );
}
