/**
 * #2201 U2: 書き込みの印を渡す受け手は、取り直しの応答を置く時点の番兵 (札の deferIfHeld) を見ることをソースで数える。
 *
 * 受け手の共通の hook (src/hooks/useAiConsultationDataRefetch.ts) は「取り直しを始めたあとに書き込みが始まったら、その取り直しの応答は
 * 置かない」を札の deferIfHeld で受け持つが、応答を置くのはページなので、置く場所で deferIfHeld を呼ばないと効かない。
 * 問題 (直す前): /pantry と /menus/weekly は書き込みの印 (useAiConsultationPendingWrites) を hook に渡していたのに、取り直しの応答を
 * 置く前に deferIfHeld を見ていなかった (献立表は取り直しの関数が札を受け取りもしなかった)。取り直しの応答を待つあいだに食材を削除する・
 * 買い物リストの品目をチェックすると、削除・チェックの前に読んだ応答が、削除した食材・外したチェックを画面に戻した。
 * /health/goals と栄養目標の再設定は真偽の ref の印を渡していて、取り直しの応答を待つあいだに始めて終えた書き込みを見分けられなかった。
 *
 * 忘れたら赤になるように、受け手 (useAiConsultationDataRefetch / useAiConsultationRefetchKey を呼ぶ src のファイル) の構文木で数える:
 *   1. hook に渡す書き込みの印 (options の writeInFlightRef) は、useAiConsultationPendingWrites で作った印 (始めた回数を数える) か、
 *      取り直しそのものが印を立てて書き込みを止めるページ (SELF_HELD_RECEIVERS) の真偽の ref のどちらか
 *   2. 数える印を渡す受け手は、取り直しの関数 (useAiConsultationDataRefetch の第 1 引数) が札 (第 1 引数) を受け取って使い
 *      (useAiConsultationRefetchKey なら戻り値の refetchTicket を受け取り)、取り直しの経路を書いたファイルで deferIfHeld を呼ぶ
 *      (または取得の流れ useAiConsultationFetchStream の begin に札を渡す。流れの place が deferIfHeld を見る)
 *   3. SELF_HELD_RECEIVERS の取り直しの関数は、その真偽の ref を true にする (取り直しの応答を待つあいだに書き込みが始まらない)
 * 取り直しの関数を別の hook が作る受け手 (ホームの useHomeData) は DELEGATED_RECEIVERS に書き、その hook のファイルで 1・2 を数える。
 *   4. 受け手 (書き込みの印を渡さない受け手も) と DELEGATED_RECEIVERS の hook のファイルで、札の deferIfHeld を直に呼ぶところは、
 *      同じ関数の中のそれより前で順序 (最後に始めた取得か) を見る: isLatest の呼び出しか、useEffect の後片付けの印 (cancelled)。
 *      別々の取得を何本も持つページは、受け手の hook の useAiConsultationFetchStream の place で順序と番兵をまとめて見る
 *      (ページに deferIfHeld も世代番号も書かない)
 *   問題 (直す前・R4): 献立表の冷蔵庫 (fetchPantry) と人数の設定 (fetchUserSettings) の取り直しは、応答を置く前に deferIfHeld だけを
 *   見て順序を見ていなかった。続けて来た 2 回の通知の取り直しや、開いたときの読み込みと取り直しの応答が逆の順に届くと、古い応答が
 *   新しい一覧・人数を上書きした (献立表は流れごとにページの世代番号の数を書き分けていて、この 2 つで書き忘れた)。
 *   5. 受け手 (書き込みの印を渡さない受け手も) と DELEGATED_RECEIVERS の hook のファイルで、取り直しの経路の関数 (取り直しの入口から
 *      名前で呼ぶ関数をたどった全部と、その中の関数) のうち、await (または .then / .catch に渡した関数) のあとに応答を置く setter
 *      (set で始まる名前の関数・store の getState().setX) を呼ぶ関数は、順序の見方 (isLatest・取得の流れの place・後片付けの印 cancelled・
 *      中断の signal.aborted) を関数の中に 1 つは持つ。取り直しの入口は、useAiConsultationDataRefetch の第 1 引数・
 *      useAiConsultationRefetchKey の refetchKey を依存に持つ useEffect の関数・DELEGATED_RECEIVERS の hook が返す取り直しの関数。
 *      取り直しそのものが await の前に立てた印 (同じ setter) を finally で下ろすところは応答ではないので数えない (家族・譲渡の承諾の画面)
 *   問題 (直す前・R5): ホームの栄養の分析 (useHomeData の fetchNutritionAnalysis) は、取り直しの経路 (readHomeData) から呼ばれるのに
 *   順序を 1 つも見ずに点数・課題・アドバイスと今日のアドバイスの帯を置いていた。続けて来た 2 回の通知の取り直しの応答が逆の順に届くと、
 *   古い分析とアドバイスが新しい表示を上書きし、古い応答が新しい読み取りの途中で読み込み中の印を下ろした (R4 の献立表と同じ型の残り)。
 *   6. 受け手と DELEGATED_RECEIVERS の hook のファイルで、取り直しの経路の関数 (5 と同じたどり方) が Supabase の読み取り
 *      (await した式の中の X.from(...) / X.rpc(...)。問い合わせを入れた const も見る) の結果を分割代入で受け取るところは、
 *      data / count を受け取るなら error も受け取る (読み取りの失敗を見分ける。supabase-js は通信の失敗でも投げずに
 *      { data: null, error } を返すので、error を見ないと失敗を「無い」と同じに扱い、取り直しで今の表示を空・0 で上書きする)。
 *      ただし受け取った data / count を読むところが全部、その名前を条件で見る if の中 (条件の中、または応答を置く setter・place を
 *      持つ then の中) なら数えない (読めなかったとき (null) は何も置かない)
 *   問題 (直す前・R7): ホームの今週のベストごはん・バッジの数・健康記録のまとめ・買い物リストの残り・今日のチェックインの読み取りは
 *   error を受け取らず、取り直しの読み取りの失敗で「0個獲得」・「今日の記録をつけよう」の帯・体重の「-」を出した。
 *   メンバーの詳細 (/family/members/[id]) の保護者の同意の記録も同じで、取り直しの失敗で同意カードを消した (U1 の同じ型の残り)。
 *   7. 数える印を渡す受け手と DELEGATED_RECEIVERS の hook のファイルで、取り直しが応答を置く setter (取り直しの経路の関数が呼ぶ setter) を
 *      呼んでから書き込み (Supabase の X.from(...).upsert / insert / update / delete・X.rpc(...)、method が GET でない fetch など) を
 *      await する関数 (楽観的な更新) は、その関数か、それを囲む関数の中で書き込みの印の begin を呼ぶ (書き込みの間に来た通知で取り直さず、
 *      応答を待つあいだに始めた書き込みを札の deferIfHeld が見分ける)。書き込みの前に呼ぶ setter が楽観的な更新でない関数は
 *      OPTIMISTIC_WRITE_EXEMPTIONS に理由を書く
 *   問題 (直す前・パネル審査 P2): ホームの今日の気分・活動量 (useHomeData の updateActivityLevel) は、楽観的に setActivityLevel してから
 *   daily_activity_logs を upsert するのに印を立てず、取り直しの経路 (readHomeData) も気分・活動量を順序 (isLatest) だけで置いていた。
 *   upsert の応答を待つあいだに来た成功の取り直しが、押す前の値を読んで押した値を戻した (食事の完了の切り替えだけを守っていた)。
 *   8. 受け手と DELEGATED_RECEIVERS の hook のファイルで、取り直しの経路の関数が X.current.clear() で捨てる入れ物 (キャッシュ) に、
 *      応答が届いたあと (await のあと・then / catch に渡した関数の中) で X.current.set / X.current.add で書く関数は無い
 *      (捨てる前に読み始めた応答が、捨てたあとに古い値を書き戻す。読み始める前に取った書き込み口で書く。献立表の createWeekDataCache)
 *   問題 (直す前・パネル審査 P2): 献立表 (/menus/weekly) の週のキャッシュ (weekDataCache) は、取り直しが clear() したあとに、それより
 *   前に始めた週の読み込み (画面には置かない 'superseded' の応答でも)・前後の週の先読みの応答が set で書き戻し、その週へ戻ったときに
 *   キャッシュから AI 相談の前の献立を出した。
 *
 * 検査の限界: 取り直しの経路の「置く場所の全部」で deferIfHeld・順序を見ているかまでは数えない (4 は deferIfHeld を直に呼ぶところの
 * 前に順序の見方があるかを、関数の中の書いた位置で見るだけで、その見方がその置く場所を守る分岐かは見ない。5 は順序の見方を関数の中に
 * 1 つでも持つ関数を、置く場所ごとには数えない。ページごとの描画のテスト
 * tests/ai-consultation-refetch-reads-2195.test.tsx・tests/ai-consultation-weekly-refetch-2195.test.tsx・
 * tests/ai-consultation-home-refetch-2195.test.tsx が、書き込み・モーダルの途中に届いた応答・古い応答を置かないことを確かめる)。
 * 1〜3 は書き込みの印を渡さない受け手 (読むだけのページ) を数えない。
 * 5 は、取り直しの関数が state を変えて走らせる useEffect (献立表の aiConsultationRefetchRound で走る月のカレンダー・生成中の依頼の確認) と、
 * 取り直しの経路でない取得 (日を選んだとき・週を移ったとき) が取り直しと同じ値を置くかは見ない (取り直しと同じ値を置く別の取得は、
 * 取り直しと同じ取得の流れで始める。/health の選んだ日のパネル・献立表の表示中の週の献立。描画のテストが確かめる)。
 * 名前の同じ関数がファイルの中に何個かあれば、全部をたどる (多めに数える)。
 * 6 は error を受け取るかだけを数え、受け取った error で取り直しの失敗を分けているか (今の表示を残すか) は見ない (描画のテストが確かめる)。
 * 条件の読み方 (否定など) も見ない。fetch の応答 (res.ok) と、投げる読み取り (try / catch) は見ない (規則の外。描画のテストが確かめる)。
 * 7 は書き込みを await する関数だけを見る (then でつないだ書き込み・書き込みを別の名前の関数に任せる楽観的な更新は見ない)。setter の名前で
 * 楽観的な更新を見分ける (set で始まらない更新 (献立表の updatePlanMeal・dispatch) は見ない)。begin は関数の中か囲む関数の中にあるかだけを見て、
 * 書き込みを囲むか (finally で終えるか) は見ない (描画のテストが確かめる)。書き込みの印を渡さない受け手と、真偽の ref の印の受け手は数えない。
 * 8 は X.current.clear() で捨てる ref の入れ物だけを見る (捨て方・書き方を別の名前の関数に包んだ入れ物は見ない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = 'src';
const RECEIVER_HOOK_FILE = 'src/hooks/useAiConsultationDataRefetch.ts';
const DATA_REFETCH_HOOK = 'useAiConsultationDataRefetch';
const REFETCH_KEY_HOOK = 'useAiConsultationRefetchKey';
const PENDING_WRITES_HOOK = 'useAiConsultationPendingWrites';
const FETCH_STREAM_HOOK = 'useAiConsultationFetchStream';
/** 取得の流れの、取得を始める関数 (札を渡すと、流れの place が応答を置く時点の番兵を見る) */
const STREAM_BEGIN = 'begin';
const WRITE_MARKER_OPTION = 'writeInFlightRef';
const REFETCH_TICKET_RESULT = 'refetchTicket';
const DEFER_IF_HELD = 'deferIfHeld';
/** 札の順序の見方 (最後に始めた取得か。札・流れの札の isLatest、ページが受け取った isLatest の関数) */
const ORDER_CHECK_CALL = 'isLatest';
/** useEffect の後片付けで前の回の応答を捨てる印 (useAiConsultationRefetchKey の受け手) */
const CLEANUP_FLAG = 'cancelled';
/** 取得の流れの札の、順序と番兵を見て応答を置く関数 */
const STREAM_PLACE = 'place';
/** 中断した読み取りの応答を捨てる印 (AbortController の signal.aborted。/comparison) */
const ABORT_FLAG = 'aborted';
/** 規則 5 の順序の見方 (関数の中にどれか 1 つでもあれば、その関数は応答を置く前に順序を見ている) */
const ORDER_TOKENS: ReadonlySet<string> = new Set([ORDER_CHECK_CALL, STREAM_PLACE, CLEANUP_FLAG, ABORT_FLAG]);
/** useAiConsultationRefetchKey の戻り値の、取り直すときに増える数 */
const REFETCH_KEY_RESULT = 'refetchKey';
/** 応答を画面に置く setter の名前 (React の state の setter・store の setter) */
const SETTER_NAME = /^set[A-Z]/;
/** store の今の状態を取る関数 (usePantryStore.getState().setFridgeItems の getState) */
const STORE_STATE_ACCESS = 'getState';
/** 応答を受け取る関数を渡す Promise のメソッド (渡した関数の中は await のあと) */
const PROMISE_CALLBACK_METHODS: ReadonlySet<string> = new Set(['then', 'catch']);
const SOURCE_FILE = /\.(ts|tsx)$/;

/**
 * 取り直しそのものが真偽の ref の印を立て、印が立っている間は書き込みを始めないページ (取り直しの応答を待つあいだに書き込みが始まらない
 * ので、応答を置く時点で書き込みを見分けなくてよい。印は書き込みと取り直しの両方を止める鍵で、数える印に置き換えると鍵でなくなる)
 */
const SELF_HELD_RECEIVERS: ReadonlyArray<{ file: string; marker: string }> = [
  { file: 'src/app/(main)/family/members/page.tsx', marker: 'writeInFlightRef' },
  { file: 'src/app/(main)/family/members/[id]/page.tsx', marker: 'busyRef' },
  { file: 'src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx', marker: 'busyRef' },
  { file: 'src/app/(main)/org/transfer-accept/[proposal_id]/page.tsx', marker: 'busyRef' },
];

/** 取り直しの関数と書き込みの印を別の hook が作る受け手 (その hook のファイルで数える) */
const DELEGATED_RECEIVERS: ReadonlyArray<{ file: string; marker: string; refetch: string; definedIn: string }> = [
  { file: 'src/app/(main)/home/page.tsx', marker: 'aiConsultationWrites', refetch: 'refetch', definedIn: 'src/hooks/useHomeData.ts' },
];

/**
 * 検査が何も数えずに緑になるのを防ぐ下限 (2026-11-04 の実数: 数える印を渡す受け手 6 (/pantry・/menus/weekly・/home・/meals/[id]・
 * /health/goals・栄養目標の再設定)・取り直しが印を立てる受け手 4。受け手を減らしてこれを割ったら、実数を数え直して下げる)。
 * #2206 G1 段 A で 0 にした (§17 G-1): 受け手を段 B〜E で新しい hook (useAiConsultationReceiver) へ並行して移す間に、枝ごとに
 * 違う実数を書いて取り込みで衝突しないよう、ヘッダの「受け手を減らしてこれを割ったら下げる」を先取りした。移した受け手の空振りは
 * 新しい番兵 tests/ai-consultation-receiver-placement-guard-2206.test.ts の P6 (RECEIVER_EXPECTATIONS) が受け持つ。段 F でファイルごと消す
 */
const MIN_COUNTED_MARKER_RECEIVERS = 0;

/**
 * 規則 5 が見た取り直しの経路の取得 (await のあとに何かをする関数) の数の下限 (検査が何もたどらずに緑になるのを防ぐ。
 * 2026-11-04 の実数 46。取り直しの経路を減らしてこれを割ったら、実数を数え直して下げる)。
 * #2206 G1 段 A で 0 にした (§17 G-1): 受け手を段 B〜E で新しい hook (useAiConsultationReceiver) へ並行して移す間に、枝ごとに
 * 違う実数を書いて取り込みで衝突しないよう、ヘッダの「受け手を減らしてこれを割ったら下げる」を先取りした。移した受け手の空振りは
 * 新しい番兵 tests/ai-consultation-receiver-placement-guard-2206.test.ts の P6 (RECEIVER_EXPECTATIONS) が受け持つ。段 F でファイルごと消す
 */
const MIN_REFETCH_PATH_FETCHERS = 0;

/**
 * 規則 6 が見た取り直しの経路の Supabase の読み取り (data / count を分割代入で受け取るところ) の数の下限 (検査が空振りして緑になるのを
 * 防ぐ。2026-11-04 の実数 38。取り直しの経路を減らしてこれを割ったら、実数を数え直して下げる)。
 * #2206 G1 段 A で 0 にした (§17 G-1): 受け手を段 B〜E で新しい hook (useAiConsultationReceiver) へ並行して移す間に、枝ごとに
 * 違う実数を書いて取り込みで衝突しないよう、ヘッダの「受け手を減らしてこれを割ったら下げる」を先取りした。移した受け手の空振りは
 * 新しい番兵 tests/ai-consultation-receiver-placement-guard-2206.test.ts の P6 (RECEIVER_EXPECTATIONS) が受け持つ。段 F でファイルごと消す
 */
const MIN_REFETCH_PATH_SUPABASE_READS = 0;
/** Supabase の問い合わせを始めるメソッド (supabase.from(...)・supabase.rpc(...)) */
const SUPABASE_QUERY_METHODS: ReadonlySet<string> = new Set(['from', 'rpc']);
/** X.from(...) のうち Supabase の問い合わせでないもの (Array.from) の X */
const NON_SUPABASE_FROM_RECEIVERS: ReadonlySet<string> = new Set(['Array']);
/** Supabase の読み取りの結果のうち、読めた値の項目 (分割代入で受け取る名前) */
const SUPABASE_RESULT_VALUE_FIELDS: ReadonlySet<string> = new Set(['data', 'count']);
/** Supabase の読み取りの結果の、失敗の項目 */
const SUPABASE_RESULT_ERROR_FIELD = 'error';
/** Supabase の表への書き込みのメソッド (X.from(...).upsert(...) など。規則 7) */
const SUPABASE_WRITE_METHODS: ReadonlySet<string> = new Set(['upsert', 'insert', 'update', 'delete']);
/** Supabase の DB の関数の呼び出し (X.rpc(...)。規則 7 は書き込みとして数える) */
const SUPABASE_RPC_METHOD = 'rpc';
/** fetch などの options の、HTTP の method の項目と、読み取りの method (規則 7 は、それ以外の method を書き込みとして数える) */
const HTTP_METHOD_OPTION = 'method';
const HTTP_READ_METHOD = 'GET';
/** 書き込みの印 (useAiConsultationPendingWrites) の、書き込みを 1 つ始める関数 */
const PENDING_WRITES_BEGIN = 'begin';
/** set で始まるが、応答を置く setter でない関数 (タイマー。規則 7) */
const NON_SETTER_SET_FUNCTIONS: ReadonlySet<string> = new Set(['setTimeout', 'setInterval']);
/** 取り直しが捨てる入れ物を捨てるメソッドと、入れ物に書くメソッド (X.current.clear()・X.current.set / add。規則 8) */
const CONTAINER_DISCARD_METHOD = 'clear';
const CONTAINER_DISCARD_METHODS: ReadonlySet<string> = new Set([CONTAINER_DISCARD_METHOD]);
const CONTAINER_WRITE_METHODS: ReadonlySet<string> = new Set(['set', 'add']);
/** ref の今の値 (X.current) */
const REF_CURRENT = 'current';

/**
 * 規則 7 の例外: 取り直しが応答を置く setter を書き込みの前に呼ぶが、それが書き込みが変える値の楽観的な更新でない関数 (理由を書く)
 */
const OPTIMISTIC_WRITE_EXEMPTIONS: ReadonlyArray<{ file: string; fn: string; reason: string }> = [
  {
    file: 'src/hooks/useHomeData.ts',
    fn: 'executeNutritionSuggestion',
    reason:
      '書き込み (献立の変更の POST) の前に置くのは今日のアドバイスの帯の進み具合の文 (「献立を変更中...」) で、書き込みが変える値ではない。' +
      '書き込みのあとに自分で読み直す (fetchHomeData。書き込みのあとに始めた取得なので、それより前に始めた取り直しの応答より後に置く)',
  },
];

/**
 * 規則 7 が見た楽観的な更新 (取り直しが応答を置く setter を呼んでから書き込みを await する関数) の数の下限 (検査が空振りして緑になるのを防ぐ。
 * 2026-11-04 の実数 8。楽観的な更新を減らしてこれを割ったら、実数を数え直して下げる)。
 * #2206 G1 段 A で 0 にした (§17 G-1): 受け手を段 B〜E で新しい hook (useAiConsultationReceiver) へ並行して移す間に、枝ごとに
 * 違う実数を書いて取り込みで衝突しないよう、ヘッダの「受け手を減らしてこれを割ったら下げる」を先取りした。移した受け手の空振りは
 * 新しい番兵 tests/ai-consultation-receiver-placement-guard-2206.test.ts の P6 (RECEIVER_EXPECTATIONS) が受け持つ。段 F でファイルごと消す
 */
const MIN_OPTIMISTIC_WRITE_FUNCTIONS = 0;

/**
 * 規則 8 が見た、取り直しが捨てる入れ物の数の下限 (検査が空振りして緑になるのを防ぐ。2026-11-04 の実数: 献立表の月のカレンダーの
 * 取得済みの範囲 fetchedRangesRef。入れ物を減らしてこれを割ったら、実数を数え直して下げる)。
 * #2206 G1 段 A で 0 にした (§17 G-1): 受け手を段 B〜E で新しい hook (useAiConsultationReceiver) へ並行して移す間に、枝ごとに
 * 違う実数を書いて取り込みで衝突しないよう、ヘッダの「受け手を減らしてこれを割ったら下げる」を先取りした。移した受け手の空振りは
 * 新しい番兵 tests/ai-consultation-receiver-placement-guard-2206.test.ts の P6 (RECEIVER_EXPECTATIONS) が受け持つ。段 F でファイルごと消す
 */
const MIN_REFETCH_DISCARDED_CONTAINERS = 0;

interface ReceiverSource {
  file: string;
  source: string;
}

/** 受け手の検査の結果 */
interface PlacementGuardReport {
  violations: string[];
  countedMarkerReceivers: string[];
  selfHeldReceivers: string[];
  /** 規則 5 が見た取り直しの経路の取得 ('<ファイル>:<行>') */
  refetchPathFetchers: string[];
  /** 規則 6 が見た取り直しの経路の Supabase の読み取り ('<ファイル>:<行>') */
  refetchPathSupabaseReads: string[];
  /** 規則 7 が見た楽観的な更新 ('<ファイル>:<行>'。例外も含む) */
  optimisticWriteFunctions: string[];
  /** 規則 8 が見た、取り直しが捨てる入れ物 ('<ファイル>:<名前>') */
  refetchDiscardedContainers: string[];
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function calleeName(call: ts.CallExpression): string | null {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

function callsTo(root: ts.Node, names: readonly string[]): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(root, (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== null && names.includes(name)) calls.push(node);
    }
  });
  return calls;
}

/** useAiConsultationFetchStream で作った取得の流れの名前 */
function fetchStreamNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      calleeName(node.initializer) === FETCH_STREAM_HOOK
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

/**
 * 取り直しの応答を置く時点の番兵を見ているか: X.deferIfHeld() / X?.deferIfHeld() を呼ぶか、取得の流れの begin に札 (第 1 引数) を渡す
 * (流れの place が deferIfHeld を見る)。begin(null, 対象の鍵) は札を渡していない (対象ごとに順序を持つ流れの、開いたとき・週の移動・
 * 日を選んだときの取得。#2201 U1) ので数えない
 */
function seesHeldAtPlacement(sf: ts.SourceFile): boolean {
  const streams = fetchStreamNames(sf);
  let found = false;
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const { name, expression } = node.expression;
    if (name.text === DEFER_IF_HELD) found = true;
    const ticketArgument = node.arguments[0];
    if (
      name.text === STREAM_BEGIN &&
      ts.isIdentifier(expression) &&
      streams.has(expression.text) &&
      ticketArgument !== undefined &&
      ticketArgument.kind !== ts.SyntaxKind.NullKeyword
    ) {
      found = true;
    }
  });
  return found;
}

/** node を囲む一番内側の関数 (無ければ null) */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current) && 'body' in current) return current as ts.FunctionLikeDeclaration;
  }
  return null;
}

/** 順序の見方か (isLatest の呼び出し・後片付けの印 cancelled を読むところ) */
function isOrderCheck(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text === ORDER_CHECK_CALL;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text === ORDER_CHECK_CALL;
    return false;
  }
  return ts.isIdentifier(node) && node.text === CLEANUP_FLAG && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node);
}

/** 札の deferIfHeld を直に呼ぶところのうち、同じ関数の中のそれより前で順序を見ていないところ (行番号) */
function deferIfHeldWithoutOrderCheck(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== DEFER_IF_HELD) return;
    const fn = enclosingFunction(node);
    const callStart = node.getStart(sf);
    let ordered = false;
    if (fn?.body !== undefined) {
      walk(fn.body, (inner) => {
        if (!ordered && inner.getStart(sf) < callStart && isOrderCheck(inner)) ordered = true;
      });
    }
    if (!ordered) lines.push(sf.getLineAndCharacterOfPosition(callStart).line + 1);
  });
  return lines;
}

/** options のオブジェクトの writeInFlightRef に渡した識別子の名前 (渡していなければ null) */
function writeMarkerName(options: ts.Expression | undefined): string | null {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === WRITE_MARKER_OPTION) return property.name.text;
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === WRITE_MARKER_OPTION) {
      return ts.isIdentifier(property.initializer) ? property.initializer.text : property.initializer.getText();
    }
  }
  return null;
}

/** 名前の変数の宣言の初期値 (分割代入で受け取った名前は、分割代入の元の式) */
function declarationOf(sf: ts.SourceFile, name: string): { init: ts.Expression | undefined; destructured: boolean } | null {
  let result: { init: ts.Expression | undefined; destructured: boolean } | null = null;
  walk(sf, (node) => {
    if (result !== null) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      result = { init: node.initializer, destructured: false };
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const declaration = node.parent.parent;
      result = { init: ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined, destructured: true };
    }
  });
  return result;
}

type MarkerKind = 'counted' | 'boolean' | 'unknown';

function markerKind(init: ts.Expression | undefined): MarkerKind {
  if (init === undefined || !ts.isCallExpression(init)) return 'unknown';
  const name = calleeName(init);
  if (name === PENDING_WRITES_HOOK) return 'counted';
  if (name === 'useRef' && init.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  return 'unknown';
}

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function asFunction(node: ts.Node | undefined): FunctionNode | null {
  if (node === undefined) return null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return node;
  if (ts.isParenthesizedExpression(node)) return asFunction(node.expression);
  // useCallback(fn, deps) の fn
  if (ts.isCallExpression(node) && calleeName(node) === 'useCallback') return asFunction(node.arguments[0]);
  return null;
}

/** 取り直しの関数 (hook の第 1 引数。識別子ならその宣言の関数) */
function resolveFunction(sf: ts.SourceFile, expression: ts.Expression | undefined): FunctionNode | null {
  if (expression === undefined) return null;
  const direct = asFunction(expression);
  if (direct !== null) return direct;
  if (!ts.isIdentifier(expression)) return null;
  let declared: FunctionNode | null = null;
  walk(sf, (node) => {
    if (declared !== null) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === expression.text) declared = node;
  });
  if (declared !== null) return declared;
  const declaration = declarationOf(sf, expression.text);
  return declaration && !declaration.destructured ? asFunction(declaration.init) : null;
}

/** 関数が第 1 引数 (札) を受け取り、本体で使うか */
function usesFirstParameter(fn: FunctionNode): boolean {
  const first = fn.parameters[0];
  if (first === undefined || !ts.isIdentifier(first.name) || fn.body === undefined) return false;
  const name = first.name.text;
  let used = false;
  walk(fn.body, (node) => {
    if (ts.isIdentifier(node) && node.text === name) used = true;
  });
  return used;
}

/** 関数の中で <marker>.current = true にするか */
function setsMarkerTrue(fn: FunctionNode, marker: string): boolean {
  let found = false;
  if (fn.body === undefined) return false;
  walk(fn.body, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.right.kind === ts.SyntaxKind.TrueKeyword &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'current' &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === marker
    ) {
      found = true;
    }
  });
  return found;
}

/** useAiConsultationRefetchKey の戻り値の分割代入で refetchTicket を受け取るか */
function receivesRefetchTicket(call: ts.CallExpression): boolean {
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(declaration.name)) return false;
  return declaration.name.elements.some((element) => {
    const property = element.propertyName ?? element.name;
    return ts.isIdentifier(property) && property.text === REFETCH_TICKET_RESULT;
  });
}

/** 返すオブジェクトの property (name) の関数 (取り直しの関数を作る hook の戻り値) */
function returnedPropertyFunction(sf: ts.SourceFile, name: string): FunctionNode | null {
  let found: FunctionNode | null = null;
  walk(sf, (node) => {
    if (found !== null) return;
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name) found = asFunction(node.initializer);
  });
  return found;
}

/** 関数のノード (矢印関数・関数式・関数の宣言) か */
function isFunctionNode(node: ts.Node): node is FunctionNode {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
}

/** 名前で呼べる関数 (関数の宣言・関数を入れた const・useCallback(fn) を入れた const)。同じ名前が何個かあれば全部 */
function namedFunctions(sf: ts.SourceFile): Map<string, FunctionNode[]> {
  const named = new Map<string, FunctionNode[]>();
  const add = (name: string, fn: FunctionNode) => named.set(name, [...(named.get(name) ?? []), fn]);
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) add(node.name.text, node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const fn = asFunction(node.initializer);
      if (fn !== null) add(node.name.text, fn);
    }
  });
  return named;
}

/** useAiConsultationRefetchKey の戻り値の refetchKey を受け取った名前 */
function refetchKeyNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const call of callsTo(sf, [REFETCH_KEY_HOOK])) {
    const declaration = call.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(declaration.name)) continue;
    for (const element of declaration.name.elements) {
      const property = element.propertyName ?? element.name;
      if (ts.isIdentifier(property) && property.text === REFETCH_KEY_RESULT && ts.isIdentifier(element.name)) names.add(element.name.text);
    }
  }
  return names;
}

/**
 * 取り直しの経路の入口の関数 (規則 5): useAiConsultationDataRefetch の第 1 引数・useAiConsultationRefetchKey の refetchKey を
 * 依存に持つ useEffect の関数・delegatedRefetch (DELEGATED_RECEIVERS の hook が返す取り直しの関数の名前) の関数
 */
function refetchEntryFunctions(sf: ts.SourceFile, delegatedRefetch: string | null): FunctionNode[] {
  const entries: FunctionNode[] = [];
  for (const call of callsTo(sf, [DATA_REFETCH_HOOK])) {
    const fn = resolveFunction(sf, call.arguments[0]);
    if (fn !== null) entries.push(fn);
  }
  const keyNames = refetchKeyNames(sf);
  for (const call of callsTo(sf, ['useEffect'])) {
    const deps = call.arguments[1];
    if (deps === undefined || !ts.isArrayLiteralExpression(deps)) continue;
    if (!deps.elements.some((dep) => ts.isIdentifier(dep) && keyNames.has(dep.text))) continue;
    const fn = asFunction(call.arguments[0]);
    if (fn !== null) entries.push(fn);
  }
  if (delegatedRefetch !== null) {
    const fn = returnedPropertyFunction(sf, delegatedRefetch);
    if (fn !== null) entries.push(fn);
  }
  return entries;
}

/** 入口から、名前で呼ぶ関数をたどった全部の関数 (たどった関数の中の関数も含む) */
function refetchPathFunctions(sf: ts.SourceFile, entries: readonly FunctionNode[]): Set<FunctionNode> {
  const named = namedFunctions(sf);
  const reached = new Set<FunctionNode>();
  const queue: FunctionNode[] = [];
  const reach = (fn: FunctionNode) => {
    if (reached.has(fn)) return;
    reached.add(fn);
    queue.push(fn);
  };
  entries.forEach(reach);
  while (queue.length > 0) {
    const fn = queue.pop();
    if (fn?.body === undefined) continue;
    walk(fn.body, (node) => {
      if (isFunctionNode(node)) reach(node);
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name !== null) (named.get(name) ?? []).forEach(reach);
      }
    });
  }
  return reached;
}

/** 関数の本体を、中の関数に入らずに歩く */
function walkOwnBody(fn: FunctionNode, visit: (node: ts.Node) => void) {
  const go = (node: ts.Node) => {
    if (node !== fn && isFunctionNode(node)) return;
    visit(node);
    node.forEachChild(go);
  };
  if (fn.body !== undefined) go(fn.body);
}

/** Promise の then / catch に渡した関数か (中は応答が届いたあと) */
function isPromiseCallback(fn: FunctionNode): boolean {
  const call = fn.parent;
  return (
    call !== undefined &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    PROMISE_CALLBACK_METHODS.has(call.expression.name.text) &&
    call.arguments.some((argument) => argument === fn)
  );
}

/** 応答を置く setter の呼び出しなら、その名前 (setX(...)・X.getState().setY(...)) */
function setterCallName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return SETTER_NAME.test(callee.text) ? callee.text : null;
  if (
    ts.isPropertyAccessExpression(callee) &&
    SETTER_NAME.test(callee.name.text) &&
    ts.isCallExpression(callee.expression) &&
    ts.isPropertyAccessExpression(callee.expression.expression) &&
    callee.expression.expression.name.text === STORE_STATE_ACCESS
  ) {
    return callee.name.text;
  }
  return null;
}

/** node が fn の中の try の finally の中か */
function inFinallyOf(node: ts.Node, fn: FunctionNode): boolean {
  for (let current: ts.Node = node; current !== fn && current.parent !== undefined; current = current.parent) {
    if (ts.isTryStatement(current.parent) && current.parent.finallyBlock === current) return true;
  }
  return false;
}

/** 関数の名前 (const の名前・関数の宣言の名前。無ければ「無名の関数」) */
function functionLabel(fn: FunctionNode): string {
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return fn.name.text;
  for (let current: ts.Node | undefined = fn.parent; current !== undefined; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (isFunctionNode(current) || ts.isSourceFile(current)) break;
  }
  return '無名の関数';
}

/**
 * 規則 5: 取り直しの経路の関数のうち、応答が届いたあと (最初の await のあと・then / catch に渡した関数の中) に setter を呼ぶのに、
 * 順序の見方 (ORDER_TOKENS) を関数の中に 1 つも持たない関数。fetchers に、見た取得 (応答が届いたあとに何かをする関数) を足す
 */
function placementsWithoutOrder(file: string, sf: ts.SourceFile, delegatedRefetch: string | null, fetchers: string[]): string[] {
  const violations: string[] = [];
  for (const fn of refetchPathFunctions(sf, refetchEntryFunctions(sf, delegatedRefetch))) {
    const settledFrom = settledFromOf(sf, fn);
    if (settledFrom < 0) continue;
    const line = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
    fetchers.push(`${file}:${line}`);
    let ordered = false;
    if (fn.body !== undefined) {
      walk(fn.body, (node) => {
        if (ts.isIdentifier(node) && ORDER_TOKENS.has(node.text)) ordered = true;
      });
    }
    if (ordered) continue;
    // 取り直しそのものが応答を待つ前に立てた印 (同じ setter) を finally で下ろすところは、応答を置くところではない
    const raisedBeforeSettled = new Set<string>();
    const placedSetters: string[] = [];
    walkOwnBody(fn, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = setterCallName(node);
      if (name === null) return;
      const start = node.getStart(sf);
      if (start < settledFrom) raisedBeforeSettled.add(name);
      else if (!(raisedBeforeSettled.has(name) && inFinallyOf(node, fn))) {
        placedSetters.push(`${name} (${sf.getLineAndCharacterOfPosition(start).line + 1} 行)`);
      }
    });
    if (placedSetters.length > 0) {
      violations.push(
        `${file}:${line}: 取り直しの経路の取得 ${functionLabel(fn)} が、応答が届いたあとに ${placedSetters.join('・')} で応答を置くのに、順序 (${[...ORDER_TOKENS].join('・')}) を 1 つも見ていない (最後に始めた取得の応答だけを置く。useAiConsultationFetchStream の place か isLatest で見る)`,
      );
    }
  }
  return violations;
}

/** 式の中に Supabase の問い合わせ (X.from(...)・X.rpc(...)) があるか。式の中の名前が問い合わせを入れた const なら、その初期値も見る */
function containsSupabaseQuery(sf: ts.SourceFile, expression: ts.Node, seen: Set<string> = new Set()): boolean {
  let found = false;
  walk(expression, (node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { name, expression: receiver } = node.expression;
      if (SUPABASE_QUERY_METHODS.has(name.text) && !(ts.isIdentifier(receiver) && NON_SUPABASE_FROM_RECEIVERS.has(receiver.text))) found = true;
    } else if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text);
      const declaration = declarationOf(sf, node.text);
      if (declaration && !declaration.destructured && declaration.init !== undefined && containsSupabaseQuery(sf, declaration.init, seen)) {
        found = true;
      }
    }
  });
  return found;
}

/** 分割代入の形の中のオブジェクトの形 ({ data, error } と、配列の形 [{ data }, …] の中のもの) */
function objectBindingPatternsOf(name: ts.BindingName): ts.ObjectBindingPattern[] {
  if (ts.isObjectBindingPattern(name)) return [name];
  if (ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => (ts.isBindingElement(element) ? objectBindingPatternsOf(element.name) : []));
  }
  return [];
}

/** 分割代入の要素の、元のオブジェクトの項目の名前 */
function bindingPropertyName(element: ts.BindingElement): string | null {
  const property = element.propertyName ?? element.name;
  return ts.isIdentifier(property) ? property.text : null;
}

/** node の中に、応答を置くところ (setter の呼び出し・取得の流れの place) があるか */
function containsPlacement(node: ts.Node): boolean {
  let found = false;
  walk(node, (inner) => {
    if (found || !ts.isCallExpression(inner)) return;
    if (setterCallName(inner) !== null) found = true;
    else if (ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === STREAM_PLACE) found = true;
  });
  return found;
}

/** node の中で name (の識別子) を読むか */
function mentions(node: ts.Node, name: string): boolean {
  let found = false;
  walk(node, (inner) => {
    if (ts.isIdentifier(inner) && inner.text === name) found = true;
  });
  return found;
}

/**
 * name を読むところ (ref) が、name を条件で見る if で守られているか: if の条件の中か、条件が name を読み、応答を置くところを持つ
 * then の中 (読めなかったとき (null) は、その応答を置かない)。fn の外へは上がらない
 */
function guardedByNameCondition(ref: ts.Node, fn: FunctionNode, name: string): boolean {
  for (let child: ts.Node = ref, current = ref.parent; current !== undefined && child !== fn; child = current, current = current.parent) {
    if (!ts.isIfStatement(current)) continue;
    if (child === current.expression) return true;
    if (child === current.thenStatement && mentions(current.expression, name) && containsPlacement(current.thenStatement)) return true;
  }
  return false;
}

/** fn の中で name を読むところが全部 (分割代入そのものを除く)、name を条件で見る if で守られているか */
function readsOnlyUnderNameCondition(fn: FunctionNode, name: string, binding: ts.Node): boolean {
  let guarded = true;
  if (fn.body === undefined) return true;
  walk(fn.body, (node) => {
    if (!guarded || !ts.isIdentifier(node) || node.text !== name || node === binding) return;
    // obj.name・{ name: … } の name は、その変数を読むところではない
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
    if ((ts.isPropertyAssignment(node.parent) || ts.isBindingElement(node.parent)) && node.parent.propertyName === node) return;
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
    if (!guardedByNameCondition(node, fn, name)) guarded = false;
  });
  return guarded;
}

/**
 * 規則 6: 取り直しの経路の関数が Supabase の読み取りの結果を分割代入で受け取り、data / count を受け取るのに error を受け取らず、
 * 受け取った値を条件で守らずに読むところ。reads に、見た読み取り ('<ファイル>:<行>') を足す
 */
function supabaseReadsWithoutError(file: string, sf: ts.SourceFile, delegatedRefetch: string | null, reads: string[]): string[] {
  const violations: string[] = [];
  for (const fn of refetchPathFunctions(sf, refetchEntryFunctions(sf, delegatedRefetch))) {
    walkOwnBody(fn, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
      let initializer: ts.Expression = node.initializer;
      while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
      if (!ts.isAwaitExpression(initializer) || !containsSupabaseQuery(sf, initializer.expression)) return;
      for (const pattern of objectBindingPatternsOf(node.name)) {
        const values = pattern.elements.filter((element) => {
          const property = bindingPropertyName(element);
          return property !== null && SUPABASE_RESULT_VALUE_FIELDS.has(property) && ts.isIdentifier(element.name);
        });
        if (values.length === 0) continue;
        const line = sf.getLineAndCharacterOfPosition(pattern.getStart(sf)).line + 1;
        reads.push(`${file}:${line}`);
        if (pattern.elements.some((element) => bindingPropertyName(element) === SUPABASE_RESULT_ERROR_FIELD)) continue;
        const unguarded = values
          .map((element) => element.name)
          .filter((name): name is ts.Identifier => ts.isIdentifier(name))
          .filter((name) => !readsOnlyUnderNameCondition(fn, name.text, name))
          .map((name) => name.text);
        if (unguarded.length > 0) {
          violations.push(
            `${file}:${line}: 取り直しの経路の取得 ${functionLabel(fn)} が Supabase の読み取りの ${unguarded.join('・')} を受け取るのに ${SUPABASE_RESULT_ERROR_FIELD} を受け取らない (読み取りの失敗を「無い」と同じに扱い、取り直しで今の表示を空・0 で上書きする。${SUPABASE_RESULT_ERROR_FIELD} を受け取り、取り直しの失敗では置かない)`,
          );
        }
      }
    });
  }
  return violations;
}

/** 取り直しの経路の関数が呼ぶ setter の名前 (取り直しが応答を置く値。規則 7) */
function refetchPlacedSetters(sf: ts.SourceFile, delegatedRefetch: string | null): Set<string> {
  const names = new Set<string>();
  for (const fn of refetchPathFunctions(sf, refetchEntryFunctions(sf, delegatedRefetch))) {
    walkOwnBody(fn, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = setterCallName(node);
      if (name !== null && !NON_SETTER_SET_FUNCTIONS.has(name)) names.add(name);
    });
  }
  return names;
}

/** 式の中に書き込み (Supabase の X.from(...).upsert(...) など・X.rpc(...)・options の method が GET でない呼び出し) があるか (規則 7) */
function containsWrite(sf: ts.SourceFile, expression: ts.Node): boolean {
  let found = false;
  walk(expression, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    if (ts.isPropertyAccessExpression(node.expression)) {
      const { name, expression: receiver } = node.expression;
      if (name.text === SUPABASE_RPC_METHOD) found = true;
      if (SUPABASE_WRITE_METHODS.has(name.text) && containsSupabaseQuery(sf, receiver)) found = true;
    }
    for (const argument of node.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      for (const property of argument.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === HTTP_METHOD_OPTION &&
          ts.isStringLiteralLike(property.initializer) &&
          property.initializer.text.toUpperCase() !== HTTP_READ_METHOD
        ) {
          found = true;
        }
      }
    }
  });
  return found;
}

/** fn か、それを囲む関数の中 (中の別の関数の中は除く) で <marker>.begin() を呼ぶか */
function beginsWriteMarker(fn: FunctionNode, marker: string): boolean {
  for (let current: ts.Node | undefined = fn; current !== undefined; current = current.parent) {
    if (!isFunctionNode(current)) continue;
    let found = false;
    walkOwnBody(current, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === PENDING_WRITES_BEGIN &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === marker
      ) {
        found = true;
      }
    });
    if (found) return true;
  }
  return false;
}

/**
 * 規則 7: 取り直しが応答を置く setter を呼んでから書き込みを await する関数 (楽観的な更新) のうち、その関数か囲む関数の中で
 * 書き込みの印 (marker) の begin を呼ばない関数。functions に、見た楽観的な更新 ('<ファイル>:<行>') を足す。
 * usedExemptions に、当てはまった例外 ('<ファイル>:<関数の名前>') を足す
 */
function optimisticWritesWithoutMarker(
  file: string,
  sf: ts.SourceFile,
  delegatedRefetch: string | null,
  marker: string,
  exemptions: typeof OPTIMISTIC_WRITE_EXEMPTIONS,
  functions: string[],
  usedExemptions: Set<string>,
): string[] {
  const placedSetters = refetchPlacedSetters(sf, delegatedRefetch);
  const violations: string[] = [];
  walk(sf, (node) => {
    if (!isFunctionNode(node)) return;
    let firstWrite = -1;
    const setterCalls: { name: string; start: number }[] = [];
    walkOwnBody(node, (inner) => {
      if (ts.isCallExpression(inner)) {
        const name = setterCallName(inner);
        if (name !== null && placedSetters.has(name)) setterCalls.push({ name, start: inner.getStart(sf) });
      }
      if (firstWrite < 0 && ts.isAwaitExpression(inner) && containsWrite(sf, inner.expression)) firstWrite = inner.getStart(sf);
    });
    if (firstWrite < 0) return;
    const optimistic = setterCalls.filter((call) => call.start < firstWrite);
    if (optimistic.length === 0) return;
    const label = functionLabel(node);
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    functions.push(`${file}:${line}`);
    if (exemptions.some((exemption) => exemption.file === file && exemption.fn === label)) {
      usedExemptions.add(`${file}:${label}`);
      return;
    }
    if (beginsWriteMarker(node, marker)) return;
    const setters = optimistic.map((call) => `${call.name} (${sf.getLineAndCharacterOfPosition(call.start).line + 1} 行)`).join('・');
    violations.push(
      `${file}:${line}: ${label} が ${setters} で楽観的に置いてから書き込みを await するのに、書き込みの印 (${marker}) の ${PENDING_WRITES_BEGIN} を呼ばない (書き込みの間に来た AI 相談の成功の取り直しが、書き込みの前の値を読んで楽観的な表示を戻す)`,
    );
  });
  return violations;
}

/** 関数の中で、応答が届いたあと (then / catch に渡した関数なら全部・それ以外は最初の await から) の位置 (無ければ -1) */
function settledFromOf(sf: ts.SourceFile, fn: FunctionNode): number {
  let settledFrom = isPromiseCallback(fn) ? fn.getStart(sf) : -1;
  walkOwnBody(fn, (node) => {
    if (settledFrom < 0 && ts.isAwaitExpression(node)) settledFrom = node.getStart(sf);
  });
  return settledFrom;
}

/** call が X.current.<method>(...) なら X の名前 (そうでなければ null) */
function refContainerCall(call: ts.CallExpression, methods: ReadonlySet<string>): string | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !methods.has(callee.name.text)) return null;
  const current = callee.expression;
  if (!ts.isPropertyAccessExpression(current) || current.name.text !== REF_CURRENT || !ts.isIdentifier(current.expression)) return null;
  return current.expression.text;
}

/**
 * 規則 8: 取り直しの経路の関数が X.current.clear() で捨てる入れ物に、応答が届いたあとで X.current.set / add で書くところ。
 * containers に、見た入れ物 ('<ファイル>:<名前>') を足す
 */
function writesAfterRefetchDiscard(file: string, sf: ts.SourceFile, delegatedRefetch: string | null, containers: string[]): string[] {
  const discarded = new Set<string>();
  for (const fn of refetchPathFunctions(sf, refetchEntryFunctions(sf, delegatedRefetch))) {
    walkOwnBody(fn, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = refContainerCall(node, CONTAINER_DISCARD_METHODS);
      if (name !== null) discarded.add(name);
    });
  }
  containers.push(...[...discarded].map((name) => `${file}:${name}`));
  if (discarded.size === 0) return [];
  const violations: string[] = [];
  walk(sf, (node) => {
    if (!isFunctionNode(node)) return;
    const settledFrom = settledFromOf(sf, node);
    if (settledFrom < 0) return;
    walkOwnBody(node, (inner) => {
      if (!ts.isCallExpression(inner) || inner.getStart(sf) < settledFrom) return;
      const name = refContainerCall(inner, CONTAINER_WRITE_METHODS);
      if (name === null || !discarded.has(name)) return;
      const line = sf.getLineAndCharacterOfPosition(inner.getStart(sf)).line + 1;
      violations.push(
        `${file}:${line}: 取り直しが ${name}.${REF_CURRENT}.${CONTAINER_DISCARD_METHOD}() で捨てる入れ物に、${functionLabel(node)} が応答の届いたあとで書く (捨てる前に読み始めた応答が古い値を書き戻す。読み始める前に取った書き込み口で書く)`,
      );
    });
  });
  return violations;
}

/** 受け手のソースを数える (sources は検査する全部のファイル。DELEGATED_RECEIVERS の definedIn もこの中から引く) */
function checkPlacementGuards(
  sources: readonly ReceiverSource[],
  selfHeld: typeof SELF_HELD_RECEIVERS,
  delegated: typeof DELEGATED_RECEIVERS,
  optimisticWriteExemptions: typeof OPTIMISTIC_WRITE_EXEMPTIONS = OPTIMISTIC_WRITE_EXEMPTIONS,
): PlacementGuardReport {
  const violations: string[] = [];
  const countedMarkerReceivers: string[] = [];
  const selfHeldReceivers: string[] = [];
  const refetchPathFetchers: string[] = [];
  const refetchPathSupabaseReads: string[] = [];
  const optimisticWriteFunctions: string[] = [];
  const refetchDiscardedContainers: string[] = [];
  const usedOptimisticWriteExemptions = new Set<string>();
  const byFile = new Map(sources.map((s) => [s.file, s.source]));

  for (const { file, source } of sources) {
    if (file === RECEIVER_HOOK_FILE) continue;
    const sf = parse(file, source);
    for (const line of deferIfHeldWithoutOrderCheck(sf)) {
      violations.push(
        `${file}:${line}: 取り直しの応答を置く前に ${DEFER_IF_HELD} だけを見て、順序 (${ORDER_CHECK_CALL}・後片付けの ${CLEANUP_FLAG}) を見ていない (取得を何本も持つページは useAiConsultationFetchStream の place を使う)`,
      );
    }
    const delegatedRefetch = delegated.find((d) => d.definedIn === file)?.refetch ?? null;
    violations.push(...placementsWithoutOrder(file, sf, delegatedRefetch, refetchPathFetchers));
    violations.push(...supabaseReadsWithoutError(file, sf, delegatedRefetch, refetchPathSupabaseReads));
    violations.push(...writesAfterRefetchDiscard(file, sf, delegatedRefetch, refetchDiscardedContainers));
    for (const call of callsTo(sf, [DATA_REFETCH_HOOK, REFETCH_KEY_HOOK])) {
      const hook = calleeName(call);
      const options = hook === DATA_REFETCH_HOOK ? call.arguments[1] : call.arguments[0];
      const marker = writeMarkerName(options);
      if (marker === null) continue;
      const at = `${file}: ${hook} の ${WRITE_MARKER_OPTION} (${marker})`;
      const declaration = declarationOf(sf, marker);
      const delegation = delegated.find((d) => d.file === file && d.marker === marker);

      if (delegation) {
        const definedSource = byFile.get(delegation.definedIn);
        if (definedSource === undefined) {
          violations.push(`${at}: 書き込みの印を作る ${delegation.definedIn} が無い`);
          continue;
        }
        const definedSf = parse(delegation.definedIn, definedSource);
        const definedMarker = declarationOf(definedSf, marker);
        if (markerKind(definedMarker?.init) !== 'counted') {
          violations.push(`${at}: ${delegation.definedIn} の印が ${PENDING_WRITES_HOOK} で作ったものでない`);
          continue;
        }
        const refetch = returnedPropertyFunction(definedSf, delegation.refetch);
        if (refetch === null || !usesFirstParameter(refetch)) {
          violations.push(`${at}: ${delegation.definedIn} の取り直しの関数 (${delegation.refetch}) が札を受け取って使っていない`);
        }
        if (!seesHeldAtPlacement(definedSf)) {
          violations.push(`${at}: ${delegation.definedIn} が取り直しの応答を置く前に ${DEFER_IF_HELD} を見ていない`);
        }
        violations.push(
          ...optimisticWritesWithoutMarker(
            delegation.definedIn,
            definedSf,
            delegation.refetch,
            marker,
            optimisticWriteExemptions,
            optimisticWriteFunctions,
            usedOptimisticWriteExemptions,
          ),
        );
        countedMarkerReceivers.push(file);
        continue;
      }

      const kind = markerKind(declaration?.init);
      if (kind === 'counted') {
        countedMarkerReceivers.push(file);
        if (hook === DATA_REFETCH_HOOK) {
          const refetch = resolveFunction(sf, call.arguments[0]);
          if (refetch === null) violations.push(`${at}: 取り直しの関数をたどれない`);
          else if (!usesFirstParameter(refetch)) violations.push(`${at}: 取り直しの関数が札 (第 1 引数) を受け取って使っていない`);
        } else if (!receivesRefetchTicket(call)) {
          violations.push(`${at}: 戻り値の ${REFETCH_TICKET_RESULT} を受け取っていない`);
        }
        if (!seesHeldAtPlacement(sf)) violations.push(`${at}: 取り直しの応答を置く前に ${DEFER_IF_HELD} を見ていない`);
        violations.push(
          ...optimisticWritesWithoutMarker(
            file,
            sf,
            delegatedRefetch,
            marker,
            optimisticWriteExemptions,
            optimisticWriteFunctions,
            usedOptimisticWriteExemptions,
          ),
        );
        continue;
      }

      if (kind === 'boolean') {
        const entry = selfHeld.find((s) => s.file === file && s.marker === marker);
        if (!entry) {
          violations.push(
            `${at}: 真偽の ref の印は、取り直しの応答を待つあいだに始めて終えた書き込みを見分けられない (${PENDING_WRITES_HOOK} で作る)`,
          );
          continue;
        }
        const refetch = hook === DATA_REFETCH_HOOK ? resolveFunction(sf, call.arguments[0]) : null;
        if (refetch === null || !setsMarkerTrue(refetch, marker)) {
          violations.push(`${at}: 取り直しの関数が ${marker}.current = true にしない (取り直しの応答を待つあいだに書き込みが始まりうる)`);
          continue;
        }
        selfHeldReceivers.push(file);
        continue;
      }

      violations.push(`${at}: 印の作り方を見分けられない (${PENDING_WRITES_HOOK} で作る)`);
    }
  }

  for (const entry of selfHeld) {
    if (!selfHeldReceivers.includes(entry.file)) {
      violations.push(`SELF_HELD_RECEIVERS の ${entry.file} (${entry.marker}) が、真偽の ref の印を渡す受け手として見つからない (一覧を直す)`);
    }
  }
  for (const exemption of optimisticWriteExemptions) {
    if (byFile.has(exemption.file) && !usedOptimisticWriteExemptions.has(`${exemption.file}:${exemption.fn}`)) {
      violations.push(
        `OPTIMISTIC_WRITE_EXEMPTIONS の ${exemption.file} の ${exemption.fn} が、書き込みの前に取り直しが置く setter を呼ぶ関数として見つからない (一覧を直す)`,
      );
    }
  }
  return {
    violations,
    countedMarkerReceivers,
    selfHeldReceivers,
    refetchPathFetchers,
    refetchPathSupabaseReads,
    optimisticWriteFunctions,
    refetchDiscardedContainers,
  };
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(rel));
    else if (SOURCE_FILE.test(entry.name)) out.push(rel);
  }
  return out;
}

/** 受け手 (hook を呼ぶファイル) と、取り直しの関数を作る hook のファイル */
function receiverSources(): ReceiverSource[] {
  const delegatedFiles = new Set(DELEGATED_RECEIVERS.map((d) => d.definedIn));
  return listSourceFiles(SRC_ROOT)
    .map((file) => ({ file, source: fs.readFileSync(path.join(ROOT, file), 'utf8') }))
    .filter(({ file, source }) => delegatedFiles.has(file) || source.includes(`${DATA_REFETCH_HOOK}(`) || source.includes(`${REFETCH_KEY_HOOK}(`));
}

describe('書き込みの印を渡す受け手は、取り直しの応答を置く前に札の deferIfHeld を見る (#2201 U2)', () => {
  it('受け手のソース', () => {
    const report = checkPlacementGuards(receiverSources(), SELF_HELD_RECEIVERS, DELEGATED_RECEIVERS);
    expect(report.violations).toEqual([]);
    expect(new Set(report.countedMarkerReceivers).size, '数える印を渡す受け手が見つからない (検査が空振りしている)').toBeGreaterThanOrEqual(
      MIN_COUNTED_MARKER_RECEIVERS,
    );
    expect(new Set(report.selfHeldReceivers).size).toBe(SELF_HELD_RECEIVERS.length);
    expect(report.refetchPathFetchers.length, '取り直しの経路の取得をたどれていない (規則 5 が空振りしている)').toBeGreaterThanOrEqual(
      MIN_REFETCH_PATH_FETCHERS,
    );
    expect(
      report.refetchPathSupabaseReads.length,
      `取り直しの経路の Supabase の読み取りを数えられていない (規則 6 が空振りしている。見たのは ${report.refetchPathSupabaseReads.length} 個)`,
    ).toBeGreaterThanOrEqual(MIN_REFETCH_PATH_SUPABASE_READS);
    expect(
      report.optimisticWriteFunctions.length,
      `楽観的な更新を数えられていない (規則 7 が空振りしている。見たのは ${report.optimisticWriteFunctions.join('・')})`,
    ).toBeGreaterThanOrEqual(MIN_OPTIMISTIC_WRITE_FUNCTIONS);
    expect(
      report.refetchDiscardedContainers.length,
      `取り直しが捨てる入れ物を見つけられていない (規則 8 が空振りしている。見たのは ${report.refetchDiscardedContainers.join('・')})`,
    ).toBeGreaterThanOrEqual(MIN_REFETCH_DISCARDED_CONTAINERS);
  });

  describe('見分けの空振りを防ぐ (直す前の /pantry・/menus/weekly・/health/goals の形を赤にする)', () => {
    const header = `import { ${DATA_REFETCH_HOOK}, ${PENDING_WRITES_HOOK}, ${REFETCH_KEY_HOOK} } from '@/hooks/useAiConsultationDataRefetch';`;
    const check = (source: string, selfHeld: typeof SELF_HELD_RECEIVERS = []) =>
      checkPlacementGuards([{ file: 'src/app/(main)/x/page.tsx', source: `${header}\n${source}` }], selfHeld, []).violations;

    it('数える印を渡しても deferIfHeld を見ない (直す前の /pantry)', () => {
      expect(
        check(`function Page() {
          const pendingWrites = ${PENDING_WRITES_HOOK}();
          const fetchItems = useCallback(async (ticket) => { const res = await fetch('/x'); if (ticket.isLatest()) setItems(await res.json()); }, []);
          ${DATA_REFETCH_HOOK}(fetchItems, { writeInFlightRef: pendingWrites });
        }`),
      ).toEqual([expect.stringContaining(DEFER_IF_HELD)]);
    });

    it('取り直しの関数が札を受け取らない (直す前の /menus/weekly)', () => {
      const violations = check(`function Page() {
        const pendingWrites = ${PENDING_WRITES_HOOK}();
        const refetchAfterAiConsultation = useCallback(() => { void refreshMealPlan(); }, [refreshMealPlan]);
        ${DATA_REFETCH_HOOK}(refetchAfterAiConsultation, { writeInFlightRef: pendingWrites });
      }`);
      expect(violations).toEqual([expect.stringContaining('札 (第 1 引数)'), expect.stringContaining(DEFER_IF_HELD)]);
    });

    it('真偽の ref の印 (直す前の /health/goals・栄養目標の再設定)', () => {
      expect(
        check(`function Page() {
          const writeInFlightRef = useRef(false);
          const { beginFetch } = ${DATA_REFETCH_HOOK}((ticket) => fetchGoals(ticket), { writeInFlightRef });
          const x = (ticket) => ticket.isLatest() && ticket.deferIfHeld();
        }`),
      ).toEqual([expect.stringContaining('真偽の ref')]);
    });

    it('取り直しが印を立てるページでも、取り直しの関数が印を立てなければ赤', () => {
      const selfHeld = [{ file: 'src/app/(main)/x/page.tsx', marker: 'writeInFlightRef' }];
      expect(
        check(
          `function Page() {
            const writeInFlightRef = useRef(false);
            const refetchAfterAiConsultation = async (ticket) => { await load(ticket); };
            ${DATA_REFETCH_HOOK}(refetchAfterAiConsultation, { writeInFlightRef });
          }`,
          selfHeld,
        ),
      ).toEqual([expect.stringContaining('.current = true'), expect.stringContaining('SELF_HELD_RECEIVERS')]);
    });

    it('useAiConsultationRefetchKey に数える印を渡して refetchTicket を受け取らない', () => {
      expect(
        check(`function Page() {
          const pendingWrites = ${PENDING_WRITES_HOOK}();
          const { refetchKey } = ${REFETCH_KEY_HOOK}({ writeInFlightRef: pendingWrites });
        }`),
      ).toEqual([expect.stringContaining(REFETCH_TICKET_RESULT), expect.stringContaining(DEFER_IF_HELD)]);
    });

    it('deferIfHeld だけを見て順序を見ない (R4 の直す前の献立表の fetchPantry・fetchUserSettings)', () => {
      const violations = check(`function Page() {
        const pendingWrites = ${PENDING_WRITES_HOOK}();
        const fetchPantry = useCallback(async (refetchTicket = null) => {
          const res = await fetch('/api/pantry');
          if (res.ok) {
            const data = await res.json();
            if (refetchTicket?.deferIfHeld()) return;
            setFridgeItems(data.items);
          }
        }, []);
        ${DATA_REFETCH_HOOK}((ticket) => { void fetchPantry(ticket); }, { writeInFlightRef: pendingWrites });
      }`);
      // 規則 4 (deferIfHeld の前に順序を見ない) と規則 5 (取り直しの経路の取得が順序を 1 つも見ない) の両方が赤にする
      expect(violations).toEqual([expect.stringMatching(/:8: .*順序/), expect.stringMatching(/:4: 取り直しの経路の取得 fetchPantry /)]);
    });

    it('順序の見方が deferIfHeld より後にあっても赤 (応答を置く前に順序を見ていない)', () => {
      expect(
        check(`function Page() {
          const load = async (ticket) => {
            const res = await fetch('/x');
            if (ticket.deferIfHeld()) return;
            if (!ticket.isLatest()) return;
            setItems(await res.json());
          };
          ${DATA_REFETCH_HOOK}(load);
        }`),
      ).toEqual([expect.stringContaining('順序')]);
    });

    it('書き込みの印を渡さない受け手 (useAiConsultationRefetchKey) でも、後片付けの印 (cancelled) を見る前に deferIfHeld を見たら赤', () => {
      const source = `function Page() {
        const { refetchKey, refetchTicket } = ${REFETCH_KEY_HOOK}();
        useEffect(() => {
          let cancelled = false;
          const ticket = refetchTicket();
          const load = async () => {
            const res = await fetch('/x');
            ORDER_GUARD
            setItems(await res.json());
          };
          void load();
          return () => { cancelled = true; };
        }, [refetchKey]);
      }`;
      expect(check(source.replaceAll('ORDER_GUARD', 'if (ticket?.deferIfHeld()) return;'))).toEqual([
        expect.stringMatching(/:9: 取り直しの応答を置く前に/),
        expect.stringMatching(/:7: 取り直しの経路の取得 load /),
      ]);
      expect(check(source.replaceAll('ORDER_GUARD', 'if (cancelled) return; if (ticket?.deferIfHeld()) return;'))).toEqual([]);
    });

    it('取得の流れの begin に札を渡さない (取り直しの経路で応答を置く時点の番兵を見ない) は赤、渡して place で置く形は赤にしない', () => {
      const source = `function Page() {
        const pendingWrites = ${PENDING_WRITES_HOOK}();
        const pantryStream = ${FETCH_STREAM_HOOK}();
        const fetchPantry = useCallback(async (refetchTicket = null) => {
          const order = pantryStream.begin(BEGIN_ARGS);
          const res = await fetch('/api/pantry');
          order.place(() => setFridgeItems(res.items));
        }, [pantryStream]);
        ${DATA_REFETCH_HOOK}((ticket) => { void fetchPantry(ticket); }, { writeInFlightRef: pendingWrites });
      }`;
      expect(check(source.replaceAll('BEGIN_ARGS', ''))).toEqual([expect.stringContaining(DEFER_IF_HELD)]);
      // 対象の鍵だけを渡す begin (札は null) も、札を渡していない
      expect(check(source.replaceAll('BEGIN_ARGS', "null, '2026-01-01'"))).toEqual([expect.stringContaining(DEFER_IF_HELD)]);
      expect(check(source.replaceAll('BEGIN_ARGS', 'refetchTicket'))).toEqual([]);
      expect(check(source.replaceAll('BEGIN_ARGS', "refetchTicket, '2026-01-01'"))).toEqual([]);
    });

    it('直した形は赤にしない', () => {
      expect(
        check(`function Page() {
          const pendingWrites = ${PENDING_WRITES_HOOK}();
          const fetchItems = useCallback(async (ticket, mode) => {
            const res = await fetch('/x');
            if (!ticket.isLatest()) return;
            if (mode === 'refetch' && ticket.deferIfHeld()) return;
            setItems(await res.json());
          }, []);
          ${DATA_REFETCH_HOOK}((ticket) => fetchItems(ticket, refetchReadMode()), { writeInFlightRef: pendingWrites });
        }`),
      ).toEqual([]);
    });
  });

  describe('規則 5: 取り直しの経路の取得は、応答を置くのに順序を見る (R5 の直す前のホームの栄養の分析の形を赤にする)', () => {
    const PAGE_FILE = 'src/app/(main)/x/page.tsx';
    const HOOK_FILE = 'src/hooks/useX.ts';
    const header = `import { ${DATA_REFETCH_HOOK}, ${FETCH_STREAM_HOOK} } from '@/hooks/useAiConsultationDataRefetch';`;
    const checkPage = (source: string) => checkPlacementGuards([{ file: PAGE_FILE, source: `${header}\n${source}` }], [], []).violations;

    it('取り直しの関数を作る hook の、取り直しの経路から呼ぶ取得が順序を 1 つも見ない (直す前の useHomeData の fetchNutritionAnalysis) は赤', () => {
      const source = `export const useX = () => {
        const homeStream = ${FETCH_STREAM_HOOK}();
        const adviceStream = ${FETCH_STREAM_HOOK}();
        const fetchAdvice = async () => {
          ADVICE_BEGIN
          const res = await fetch('/api/advice');
          ADVICE_ORDER
          if (res.ok) setAdvice(await res.json());
        };
        const fetchHome = async (ticket) => {
          const order = homeStream.begin(ticket);
          const res = await fetch('/api/home');
          order.place(() => setHome(res));
          fetchAdvice();
        };
        return { refetch: (ticket) => fetchHome(ticket) };
      };`;
      const delegatedHook = [{ file: PAGE_FILE, marker: 'writes', refetch: 'refetch', definedIn: HOOK_FILE }];
      const run = (adviceBegin: string, adviceOrder: string) =>
        checkPlacementGuards(
          [{ file: HOOK_FILE, source: source.replaceAll('ADVICE_BEGIN', adviceBegin).replaceAll('ADVICE_ORDER', adviceOrder) }],
          [],
          delegatedHook,
        ).violations;
      expect(run('', '')).toEqual([expect.stringMatching(/useX\.ts:4: 取り直しの経路の取得 fetchAdvice が、.*setAdvice \(8 行\)/)]);
      // 直した形: 自分の取得の流れで始め、応答を待ったあとに最後に始めた読み取りかを見る
      expect(run('const order = adviceStream.begin();', 'if (!order.isLatest()) return;')).toEqual([]);
    });

    it('then に渡した関数の中で応答を置くのに順序を見ない取り直しは赤', () => {
      expect(
        checkPage(`function Page() {
          const load = useCallback((ticket) => {
            fetch('/x').then((res) => res.json()).then((data) => setItems(data));
          }, []);
          ${DATA_REFETCH_HOOK}(load);
        }`),
      ).toEqual([expect.stringMatching(/:4: 取り直しの経路の取得 無名の関数 が、.*setItems \(4 行\)/)]);
    });

    it('取り直しそのものが応答を待つ前に立てた印を finally で下ろすところは数えない (家族・譲渡の承諾の画面)。それ以外の setter は赤', () => {
      const source = `function Page() {
        const refetchAfterAiConsultation = async (ticket) => {
          setAiRefetching(true);
          try {
            await load(ticket);
          } finally {
            FINALLY
          }
        };
        ${DATA_REFETCH_HOOK}(refetchAfterAiConsultation);
      }`;
      expect(checkPage(source.replaceAll('FINALLY', 'setAiRefetching(false);'))).toEqual([]);
      expect(checkPage(source.replaceAll('FINALLY', 'setAiRefetching(false); setItems([]);'))).toEqual([
        expect.stringMatching(/:3: 取り直しの経路の取得 refetchAfterAiConsultation が、応答が届いたあとに setItems \(8 行\) で/),
      ]);
    });
  });

  describe('規則 6: 取り直しの経路の Supabase の読み取りは error を受け取る (R7 の直す前のホームの記録の集計の形を赤にする)', () => {
    const PAGE_FILE = 'src/app/(main)/x/page.tsx';
    const HOOK_FILE = 'src/hooks/useX.ts';
    const delegatedHook = [{ file: PAGE_FILE, marker: 'writes', refetch: 'refetch', definedIn: HOOK_FILE }];
    /** 取り直しの経路 (refetch → fetchHome → fetchPart) の fetchPart の本体を body にした hook を数える */
    const run = (body: string) =>
      checkPlacementGuards(
        [
          {
            file: HOOK_FILE,
            source: `export const useX = () => {
              const fetchPart = async (userId, isLatest, mode) => {
                ${body}
              };
              const fetchHome = async (ticket, mode) => {
                const order = homeStream.begin(ticket);
                await fetchPart('user-1', order.isLatest, mode);
              };
              return { refetch: (ticket) => fetchHome(ticket, 'refetch') };
            };`,
          },
        ],
        [],
        delegatedHook,
      );

    it('count を受け取って error を受け取らない (直す前のバッジの数・買い物リストの残り) は赤', () => {
      const report = run(`const { count } = await supabase.from('user_badges').select('*', { count: 'exact', head: true });
                if (isLatest()) setBadgeCount(count || 0);`);
      expect(report.violations).toEqual([expect.stringMatching(/useX\.ts:3: 取り直しの経路の取得 fetchPart が Supabase の読み取りの count を受け取るのに error を受け取らない/)]);
      expect(report.refetchPathSupabaseReads).toEqual([`${HOOK_FILE}:3`]);
    });

    it('問い合わせを入れた const を await する (直す前の今週のベストごはん) も数えて赤', () => {
      expect(
        run(`const query = supabase.from('planned_meals').select('*');
                const { data } = await orderListBy(query, ORDER).limit(1);
                if (isLatest()) setBestMeal(data && data.length > 0 ? data[0] : null);`).violations,
      ).toEqual([expect.stringMatching(/:4: .*Supabase の読み取りの data を受け取るのに error を受け取らない/)]);
    });

    it('受け取った値を条件で見ても、応答を置かない then で別の変数に移して置く (直す前の健康記録の体重) は赤', () => {
      expect(
        run(`const { data: weights } = await supabase.from('health_records').select('weight');
                let latest = null;
                if (weights && weights.length > 0) {
                  latest = weights[0].weight;
                }
                if (isLatest()) setLatestWeight(latest);`).violations,
      ).toEqual([expect.stringMatching(/:3: .*Supabase の読み取りの weights を受け取るのに error を受け取らない/)]);
    });

    it('配列の形で受け取る読み取りも 1 つずつ数える', () => {
      expect(
        run(`const [{ data: a }, { data: b, error: bError }] = await Promise.all([
                  supabase.from('a').select('*'),
                  supabase.from('b').select('*'),
                ]);
                if (isLatest() && !(mode === 'refetch' && bError)) { setA(a); setB(b); }`).violations,
      ).toEqual([expect.stringMatching(/:3: .*Supabase の読み取りの a を受け取るのに error を受け取らない/)]);
    });

    it('直した形 (error を受け取る)・値を条件で見て置く形・Supabase でない読み取りは赤にしない', () => {
      expect(
        run(`const { count, error: countError } = await supabase.from('user_badges').select('*', { count: 'exact', head: true });
                if (isLatest() && !(mode === 'refetch' && countError)) setBadgeCount(count || 0);`).violations,
      ).toEqual([]);
      expect(
        run(`const { data: days } = await supabase.from('user_daily_meals').select('*');
                if (days && isLatest()) {
                  setStreak(days.length);
                }`).violations,
      ).toEqual([]);
      expect(
        run(`const res = await fetch('/api/x');
                const { data } = await res.json();
                const [{ data: first }] = await Promise.all(Array.from(ids, (id) => load(id)));
                if (isLatest()) { setItems(data ?? []); setFirst(first); }`).violations,
      ).toEqual([]);
    });
  });

  describe('規則 7: 取り直しが置く値を楽観的に置いてから書き込む関数は、書き込みの印を始める (P2 の直す前のホームの気分・活動量の形を赤にする)', () => {
    const PAGE_FILE = 'src/app/(main)/x/page.tsx';
    const HOOK_FILE = 'src/hooks/useX.ts';
    const delegatedHook = [{ file: PAGE_FILE, marker: 'writes', refetch: 'refetch', definedIn: HOOK_FILE }];
    /** 取り直しの経路 (refetch → readHome) が setActivity・setPlan で応答を置く hook の、書き込みの関数の本体を body にして数える */
    const runHook = (body: string, exemptions: typeof OPTIMISTIC_WRITE_EXEMPTIONS = []) =>
      checkPlacementGuards(
        [
          {
            file: PAGE_FILE,
            source: `import { ${DATA_REFETCH_HOOK} } from '@/hooks/useAiConsultationDataRefetch';
              function Page() {
                const { refetch, writes } = useX();
                ${DATA_REFETCH_HOOK}(refetch, { writeInFlightRef: writes });
              }`,
          },
          {
            file: HOOK_FILE,
            source: `export const useX = () => {
              const writes = ${PENDING_WRITES_HOOK}();
              const homeStream = ${FETCH_STREAM_HOOK}();
              const readHome = async (ticket) => {
                const order = homeStream.begin(ticket);
                const { data: activity, error } = await supabase.from('daily_activity_logs').select('*').maybeSingle();
                if (activity) order.place(() => setActivity(activity.feeling));
                const res = await fetch('/api/plan');
                order.place(() => setPlan(res));
              };
              const updateActivity = async (level) => {
                ${body}
              };
              return { refetch: (ticket) => readHome(ticket), writes, updateActivity };
            };`,
          },
        ],
        [],
        delegatedHook,
        exemptions,
      );

    it('楽観的に置いてから upsert を await するのに印を始めない (直す前の useHomeData の updateActivityLevel) は赤', () => {
      const report = runHook(`setActivity(level);
                await supabase.from('daily_activity_logs').upsert({ feeling: level });`);
      expect(report.violations).toEqual([
        expect.stringMatching(/useX\.ts:11: updateActivity が setActivity \(12 行\) で楽観的に置いてから書き込みを await するのに、書き込みの印 \(writes\) の begin を呼ばない/),
      ]);
      expect(report.optimisticWriteFunctions).toEqual([`${HOOK_FILE}:11`]);
    });

    it('rpc・method が GET でない fetch の書き込みも数える。GET の fetch・読み取りは書き込みとして数えない', () => {
      expect(runHook(`setPlan(level); await supabase.rpc('set_completed', { level });`).violations).toEqual([
        expect.stringContaining('updateActivity が setPlan'),
      ]);
      expect(runHook(`setPlan(level); await fetch('/api/plan', { method: 'PATCH', body: level });`).violations).toEqual([
        expect.stringContaining('updateActivity が setPlan'),
      ]);
      expect(runHook(`setPlan(level); await fetch('/api/plan', { method: 'GET' });`).optimisticWriteFunctions).toEqual([]);
      expect(runHook(`setPlan(level); await supabase.from('plans').select('*');`).optimisticWriteFunctions).toEqual([]);
      // 取り直しが置かない setter (読み込み中の印など) は楽観的な更新として数えない
      expect(runHook(`setSaving(true); await supabase.from('daily_activity_logs').upsert({ feeling: level });`).optimisticWriteFunctions).toEqual([]);
      // 書き込みのあとに置くだけなら楽観的な更新ではない
      expect(runHook(`await supabase.from('daily_activity_logs').upsert({ feeling: level }); setActivity(level);`).optimisticWriteFunctions).toEqual([]);
    });

    it('印を始める形 (直したあとの updateActivityLevel) は赤にしない', () => {
      expect(
        runHook(`const endWrite = writes.begin();
                try {
                  setActivity(level);
                  await supabase.from('daily_activity_logs').upsert({ feeling: level });
                } finally {
                  endWrite();
                }`).violations,
      ).toEqual([]);
    });

    it('例外に書いた関数は数えず、例外に書いたのに当てはまらない関数があれば赤 (一覧を直す)', () => {
      const exemption = { file: HOOK_FILE, fn: 'updateActivity', reason: '検査の例' };
      const optimistic = `setActivity(level); await supabase.from('daily_activity_logs').upsert({ feeling: level });`;
      expect(runHook(optimistic, [exemption]).violations).toEqual([]);
      expect(runHook(`await supabase.from('daily_activity_logs').upsert({ feeling: level });`, [exemption]).violations).toEqual([
        expect.stringContaining('OPTIMISTIC_WRITE_EXEMPTIONS の src/hooks/useX.ts の updateActivity'),
      ]);
    });

    it('数える印を直に渡すページも数える', () => {
      const source = `import { ${DATA_REFETCH_HOOK}, ${PENDING_WRITES_HOOK} } from '@/hooks/useAiConsultationDataRefetch';
        function Page() {
          const pendingWrites = ${PENDING_WRITES_HOOK}();
          const fetchItems = useCallback(async (ticket) => {
            const res = await fetch('/x');
            if (!ticket.isLatest() || ticket.deferIfHeld()) return;
            setItems(await res.json());
          }, []);
          ${DATA_REFETCH_HOOK}(fetchItems, { writeInFlightRef: pendingWrites });
          const removeItem = async (id) => {
            BEGIN
            setItems((items) => items.filter((item) => item.id !== id));
            await fetch('/x/' + id, { method: 'DELETE' });
          };
        }`;
      const run = (begin: string) => checkPlacementGuards([{ file: PAGE_FILE, source: source.replaceAll('BEGIN', begin) }], [], []).violations;
      expect(run('')).toEqual([expect.stringMatching(/page\.tsx:10: removeItem が setItems \(12 行\)/)]);
      expect(run('const endWrite = pendingWrites.begin();')).toEqual([]);
    });
  });

  describe('規則 8: 取り直しが捨てる入れ物に、応答が届いたあとで書かない (P2 の直す前の献立表の週のキャッシュの形を赤にする)', () => {
    const PAGE_FILE = 'src/app/(main)/x/page.tsx';
    const header = `import { ${DATA_REFETCH_HOOK} } from '@/hooks/useAiConsultationDataRefetch';`;
    const checkPage = (source: string) => checkPlacementGuards([{ file: PAGE_FILE, source: `${header}\n${source}` }], [], []);

    it('取り直しが clear() したあとに、週の読み込み (await のあと)・先読み (then の中) が set で書き戻す (直す前の weekDataCache) は赤', () => {
      const report = checkPage(`function Page() {
        const weekDataCache = useRef(new Map());
        const fetchPlan = async (key) => {
          const data = await fetchWeekData(key);
          weekDataCache.current.set(key, data);
        };
        const prefetch = (key) => {
          fetchWeekData(key).then((data) => {
            weekDataCache.current.set(key, data);
          });
        };
        const refetchAfterAiConsultation = useCallback((ticket) => {
          weekDataCache.current.clear();
          void refreshMealPlan(ticket);
        }, []);
        ${DATA_REFETCH_HOOK}(refetchAfterAiConsultation);
      }`);
      expect(report.violations).toEqual([
        expect.stringMatching(/page\.tsx:6: 取り直しが weekDataCache\.current\.clear\(\) で捨てる入れ物に、fetchPlan が応答の届いたあとで書く/),
        expect.stringMatching(/page\.tsx:10: 取り直しが weekDataCache\.current\.clear\(\) で捨てる入れ物に、無名の関数 が応答の届いたあとで書く/),
      ]);
      expect(report.refetchDiscardedContainers).toEqual([`${PAGE_FILE}:weekDataCache`]);
    });

    it('読み始める前に書く (取得済みの範囲の印)・取り直しが捨てない入れ物に書くのは赤にしない', () => {
      expect(
        checkPage(`function Page() {
          const fetchedRangesRef = useRef(new Set());
          const otherCache = useRef(new Map());
          const fetchRange = async (key) => {
            fetchedRangesRef.current.add(key);
            const data = await fetchDates(key);
            otherCache.current.set(key, data);
          };
          const refetchAfterAiConsultation = useCallback((ticket) => {
            fetchedRangesRef.current.clear();
          }, []);
          ${DATA_REFETCH_HOOK}(refetchAfterAiConsultation);
        }`).violations,
      ).toEqual([]);
    });
  });
});
