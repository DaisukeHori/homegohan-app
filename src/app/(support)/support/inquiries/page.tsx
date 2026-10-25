"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { isStaleDataConflict } from "@/lib/admin/api-error-message";

// 一覧の 1 件 (概要)。問い合わせ本文と管理者メモは、詳細 (GET /api/admin/inquiries/[id]) でだけ返る
interface InquirySummary {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

// 詳細パネルの 1 件。message / adminNotes は詳細を取得するまで null
interface Inquiry extends InquirySummary {
  message: string | null;
  adminNotes: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  general: "一般",
  support: "サポート",
  bug: "バグ報告",
  feature: "機能要望",
};

const STATUS_OPTIONS = [
  { value: "pending", label: "未対応", color: "bg-yellow-100 text-yellow-700" },
  { value: "in_progress", label: "対応中", color: "bg-blue-100 text-blue-700" },
  { value: "resolved", label: "解決済", color: "bg-green-100 text-green-700" },
  { value: "closed", label: "完了", color: "bg-gray-100 text-gray-600" },
];

// 一覧 API (GET /api/admin/inquiries) の 1 ページの件数
const PAGE_SIZE = 50;

// 管理者メモの最大文字数 (API の検証と同じ。超えると API が 400 を返す)
const ADMIN_NOTES_MAX_LENGTH = 5000;

/**
 * ステータスの更新が 409 CONFLICT_STALE_DATA (読んでから書くまでに別の運営が先にこの問い合わせを変えた) で断られ、
 * 一覧と開いている問い合わせの詳細を読み直したときの文 (#1917)。
 * サーバーの文は「画面を開き直して」と頼む文なので使わない (画面が自分で読み直すため)。
 * 管理者メモの入力欄が書きかけでなければ、入力欄も読み直した (いま保存されている) メモにする
 */
const STALE_UPDATE_MESSAGE =
  "別の運営が先にこの問い合わせを更新していました。最新の内容を読み込み直したので、ステータスとメモを確かめてから、もう一度操作してください";

/** 管理者メモの入力欄が書きかけ (読み直しで消さずに残す) のときに添える文 (#1917) */
const NOTE_DRAFT_KEPT_SUFFIX = "（書きかけの管理者メモはそのまま残しています）";

/** STALE_UPDATE_MESSAGE の、管理者メモの入力欄が書きかけ (読み直しで消さずに残す) のときの文 (#1917) */
const STALE_UPDATE_MESSAGE_DRAFT_KEPT = `${STALE_UPDATE_MESSAGE}${NOTE_DRAFT_KEPT_SUFFIX}`;

/**
 * 更新が 409 CONFLICT_STALE_DATA で断られ、開いている問い合わせの詳細の読み直しにも失敗したときの文 (#1917)。
 * 読み込み直せていないので「読み込み直した」とは言わない。内容の欄の「再試行」で読み直せたら STALE_UPDATE_MESSAGE に変える。
 * 読み直しの失敗が 401 / 403 / 404 (再試行しても読めない) のときは、この文ではなく STALE_RELOAD_UNAVAILABLE_MESSAGE
 */
const STALE_RELOAD_FAILED_MESSAGE =
  "別の運営が先にこの問い合わせを更新していました。最新の内容を読み込み直せませんでした。内容の欄の「再試行」で読み込み直してから、もう一度操作してください";

/**
 * 更新が 409 CONFLICT_STALE_DATA で断られ、開いている問い合わせの詳細の読み直しが 401 / 403 / 404 (ログインが切れた・
 * 権限が外れた・二段階認証の確認が要る・問い合わせが消えた) だったときの文。
 * 読み直しを繰り返しても読めないので、「再試行」で読み込み直すよう促さない。理由は内容の欄に出ている
 * (営業リードの画面の 409 のあとの読み直しと同じ分け方。src/app/admin/sales/[id]/page.tsx の staleStageMessageOf)
 */
const STALE_RELOAD_UNAVAILABLE_MESSAGE =
  "別の運営が先にこの問い合わせを更新していたので、更新していません。最新の内容も読み込めませんでした（理由は内容の欄に出しています）";

/**
 * 詳細の読み直しの失敗のうち、「再試行」で読み直しても同じ結果になる HTTP ステータス。
 * 401 (ログインが切れた)・403 (権限が外れた・二段階認証の確認が要る・凍結)・404 (問い合わせが消えた)
 */
const DETAIL_UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * 詳細の読み直し (reloadInquiryDetail) の結果。
 *   - reloaded   : 読み直せた。draftKept は、管理者メモの入力欄が書きかけだったので残したか
 *   - failed     : 読み直せなかった (詳細の欄にエラーと「再試行」が出ている)。
 *                  unavailable は、応答が DETAIL_UNAVAILABLE_STATUSES (再試行しても読めない理由) だったか
 *   - superseded : 読み直しの最中に別の問い合わせを開いた・閉じたので結果を捨てた
 */
type DetailReloadOutcome =
  | { kind: "reloaded"; draftKept: boolean }
  | { kind: "failed"; unavailable: boolean }
  | { kind: "superseded" };

/** 409 のあとの詳細の読み直しの結果から、更新の欄に出す文 (superseded のときは null = 文を変えない)。draftEdited は読み直しの前に書きかけだったか */
function staleUpdateMessageOf(outcome: DetailReloadOutcome, draftEdited: boolean): string | null {
  switch (outcome.kind) {
    case "reloaded":
      return outcome.draftKept ? STALE_UPDATE_MESSAGE_DRAFT_KEPT : STALE_UPDATE_MESSAGE;
    case "failed": {
      // 問い合わせが消えた・権限が外れたときは、消えた問い合わせの「再試行」を促さない (理由は内容の欄に出ている)
      const message = outcome.unavailable ? STALE_RELOAD_UNAVAILABLE_MESSAGE : STALE_RELOAD_FAILED_MESSAGE;
      // 読み直せなかったときは入力欄に手を付けていないので、書きかけはそのまま残っている
      return draftEdited ? `${message}${NOTE_DRAFT_KEPT_SUFFIX}` : message;
    }
    case "superseded":
      return null;
  }
}

// 失敗の応答の本文 (JSON でなければ null)
async function readFailureBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    // 本文が JSON でなければ HTTP ステータスで知らせる
    return null;
  }
}

// 失敗の理由 (API の error.message) があれば添えて、なければ HTTP ステータスを添える
function failureMessageOf(body: unknown, status: number, summary: string): string {
  const message =
    typeof body === "object" && body !== null ? (body as { error?: { message?: unknown } }).error?.message : undefined;
  if (typeof message === "string" && message) return `${summary}（${message}）`;
  return `${summary}（HTTP ${status}）`;
}

async function describeFailure(res: Response, summary: string): Promise<string> {
  return failureMessageOf(await readFailureBody(res), res.status, summary);
}

export default function SupportInquiriesPage() {
  const [inquiries, setInquiries] = useState<InquirySummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [adminNote, setAdminNote] = useState("");
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // 更新が 409 CONFLICT_STALE_DATA で断られ、詳細を読み直した問い合わせの id (#1917)。
  // 選び直す・閉じる・更新に成功すると消す
  const [staleReloadedId, setStaleReloadedId] = useState<string | null>(null);
  // その読み直しで、管理者メモの入力欄が書きかけだったので残したか (#1917)。
  // 残したときだけ、書きかけのメモと保存されているメモが違えば、保存されているメモを入力欄の下に出す。
  // 書きかけでなければ入力欄は読み直したメモになるので出さない
  const [staleDraftKept, setStaleDraftKept] = useState(false);
  // 管理者メモの入力欄のいまの値 (描画を待たずに読むための写し。入力欄は changeAdminNote / resetAdminNote でだけ変える)
  const adminNoteRef = useRef("");
  // 管理者メモの入力欄の初めの値 = 最後に読んだ (開いた・読み直した・保存した) メモ。
  // 入力欄がこれと違えば書きかけ (409 のあとの読み直しで、書きかけのメモだけを残す。#1917)
  const loadedNoteRef = useRef("");
  // 絞り込みを素早く切り替えたとき、古いリクエストの結果で一覧を上書きしないための連番
  const requestSeq = useRef(0);
  // 問い合わせを素早く選び直したとき、古い詳細の結果でパネルを上書きしないための連番
  const detailSeq = useRef(0);

  // 管理者メモの入力欄を変える (運営の入力。初めの値は変えない = 書きかけになる)
  const changeAdminNote = useCallback((value: string) => {
    adminNoteRef.current = value;
    setAdminNote(value);
  }, []);

  // 管理者メモの入力欄を読んだ (保存されている) メモにし、それを初めの値にする (書きかけでなくなる)
  const resetAdminNote = useCallback(
    (value: string) => {
      loadedNoteRef.current = value;
      changeAdminNote(value);
    },
    [changeAdminNote],
  );

  // nextPage = 1 は一覧の取り直し、2 以降は「さらに読み込む」(末尾に追加)
  const fetchInquiries = useCallback(async (nextPage = 1) => {
    const append = nextPage > 1;
    const seq = ++requestSeq.current;
    if (append) setLoadingMore(true);
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: String(PAGE_SIZE) });
      if (filterStatus) params.set("status", filterStatus);

      const res = await fetch(`/api/admin/inquiries?${params}`);
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        // 失敗を「該当する問い合わせはありません」と見分けられるよう、エラーとして表示する (#1121)
        const message = await describeFailure(res, "問い合わせを取得できませんでした");
        if (seq !== requestSeq.current) return; // 本文を読んでいる間に新しい取得が始まっていたら、古い失敗は捨てる
        setLoadError(message);
        if (!append) {
          setInquiries([]);
          setTotal(null);
          setHasMore(false);
        }
        return;
      }
      const data = await res.json();
      if (seq !== requestSeq.current) return;
      const fetched: InquirySummary[] = data.inquiries ?? [];
      setLoadError(null);
      setInquiries((prev) =>
        append ? [...prev, ...fetched.filter((item) => !prev.some((p) => p.id === item.id))] : fetched
      );
      setTotal(typeof data.total === "number" ? data.total : null);
      setHasMore(typeof data.total === "number" && nextPage * PAGE_SIZE < data.total);
      setPage(nextPage);
    } catch (error) {
      console.error("Failed to fetch inquiries:", error);
      if (seq !== requestSeq.current) return;
      setLoadError("問い合わせを取得できませんでした（通信エラー）");
      if (!append) {
        setInquiries([]);
        setTotal(null);
        setHasMore(false);
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filterStatus]);

  useEffect(() => {
    fetchInquiries();
  }, [fetchInquiries]);

  // 問い合わせを開く。概要はすぐ出し、本文と管理者メモは詳細 API から取る。
  // 詳細を取得した時点で、誰がどの問い合わせを見たかが API 側で監査ログに記録される。
  const openInquiry = useCallback(async (summary: InquirySummary) => {
    const seq = ++detailSeq.current;
    setSelectedInquiry({ ...summary, message: null, adminNotes: null });
    resetAdminNote("");
    setUpdateError(null);
    setDetailError(null);
    setStaleReloadedId(null);
    setStaleDraftKept(false);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/inquiries/${summary.id}`);
      if (seq !== detailSeq.current) return;
      if (!res.ok) {
        const message = await describeFailure(res, "問い合わせの内容を取得できませんでした");
        if (seq !== detailSeq.current) return; // 本文を読んでいる間に選び直し・閉じられていたら、古い失敗は捨てる
        setDetailError(message);
        return;
      }
      const data = await res.json();
      if (seq !== detailSeq.current) return;
      setSelectedInquiry(data.inquiry);
      resetAdminNote(data.inquiry.adminNotes || "");
    } catch (error) {
      console.error("Failed to fetch inquiry:", error);
      if (seq !== detailSeq.current) return;
      setDetailError("問い合わせの内容を取得できませんでした（通信エラー）");
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, [resetAdminNote]);

  // 開いている問い合わせの詳細だけを取り直す。更新が 409 CONFLICT_STALE_DATA で断られたあと (と、そのあとの「再試行」) に使う (#1917)。
  // 管理者メモの入力欄は、書きかけ (初めの値から変えている) なら消さずに残し、書きかけでなければ読み直したメモにする
  // (開いたときの古いメモを残すと、次の更新でそれを送り、別の運営が書いたメモを上書きしてしまうため)。
  // 取得した時点で、API が閲覧を監査ログに残す (表示が古いまま操作させないために読み直す)
  const reloadInquiryDetail = useCallback(async (inquiryId: string): Promise<DetailReloadOutcome> => {
    const seq = ++detailSeq.current;
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/inquiries/${inquiryId}`);
      if (seq !== detailSeq.current) return { kind: "superseded" };
      if (!res.ok) {
        const message = await describeFailure(res, "問い合わせの内容を取得できませんでした");
        if (seq !== detailSeq.current) return { kind: "superseded" }; // 本文を読んでいる間に選び直し・閉じられていたら、古い失敗は捨てる
        setDetailError(message);
        return { kind: "failed", unavailable: DETAIL_UNAVAILABLE_STATUSES.has(res.status) };
      }
      const data = await res.json();
      if (seq !== detailSeq.current) return { kind: "superseded" };
      setSelectedInquiry(data.inquiry);
      const savedNote: string = data.inquiry.adminNotes || "";
      const draftKept = adminNoteRef.current !== loadedNoteRef.current;
      setStaleDraftKept(draftKept);
      if (draftKept) {
        // 書きかけは残し、初めの値だけをいま保存されているメモにする (書きかけをそのメモと同じに直せば、書きかけでなくなる)
        loadedNoteRef.current = savedNote;
      } else {
        resetAdminNote(savedNote);
      }
      return { kind: "reloaded", draftKept };
    } catch (error) {
      console.error("Failed to reload inquiry:", error);
      if (seq !== detailSeq.current) return { kind: "superseded" };
      setDetailError("問い合わせの内容を取得できませんでした（通信エラー）");
      // 通信エラーは「再試行」で読めることがある
      return { kind: "failed", unavailable: false };
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, [resetAdminNote]);

  /**
   * 409 CONFLICT_STALE_DATA のあとに、開いている問い合わせの詳細を読み直し、結果に合わせて更新の欄の文を決める (#1917)。
   * 読み直しの前に文を決めない (読み直せなかったのに「読み込み直した」の文を残さない)。
   * 詳細の欄の「再試行」(409 のあとの読み直しに失敗したとき) もこれを使い、読み直せたら「読み込み直した」の文に変える
   */
  const reloadStaleDetail = useCallback(
    async (inquiryId: string) => {
      const draftEdited = adminNoteRef.current !== loadedNoteRef.current;
      const message = staleUpdateMessageOf(await reloadInquiryDetail(inquiryId), draftEdited);
      if (message !== null) setUpdateError(message);
    },
    [reloadInquiryDetail],
  );

  const closeInquiry = () => {
    detailSeq.current += 1; // 取得中の詳細があっても、閉じたあとの結果は捨てる
    setSelectedInquiry(null);
    setDetailLoading(false);
    setDetailError(null);
    setUpdateError(null);
    setStaleReloadedId(null);
    setStaleDraftKept(false);
  };

  const handleStatusUpdate = async (inquiryId: string, newStatus: string) => {
    setUpdating(true);
    setUpdateError(null);
    // 管理者メモは、入力欄に手を付けた (最後に読んだ・保存したメモから変えた) ときだけ送る。手を付けていないのに開いたときの
    // メモを送ると、API は自分が読んだ値で比べる (画面を開いてからの変更は見分けない。operator/02 §PUT /api/admin/inquiries/{id})
    // ので、開いたあとに別の運営が書いたメモを、ステータスだけを変えた操作で上書きしてしまう (#1917)。
    // 空にした入力欄は送らない (メモを消さない。これまでと同じ)
    const noteEdited = adminNoteRef.current !== loadedNoteRef.current;
    const adminNotesToSend = noteEdited && adminNote !== "" ? adminNote : undefined;
    try {
      const res = await fetch(`/api/admin/inquiries/${inquiryId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          adminNotes: adminNotesToSend,
        }),
      });

      if (!res.ok) {
        const body = await readFailureBody(res);
        if (isStaleDataConflict(res.status, body)) {
          // 別の運営が先に変えていた (API は書いていない)。表示が古いので、一覧と開いている問い合わせの詳細を読み直し、
          // その旨を出す (運営が手で読み直さなくてよいように。#1917)。書きかけの管理者メモは読み直しで消さない
          // (書きかけでなければ、入力欄は読み直したメモになる。文もそれに合わせる)。
          // 文は詳細の読み直しの結果を待ってから決める (読み直しに失敗したら「読み込み直せなかった」の文にする)
          if (selectedInquiry?.id === inquiryId) {
            setStaleReloadedId(inquiryId);
            await Promise.all([fetchInquiries(), reloadStaleDetail(inquiryId)]);
          } else {
            setUpdateError(noteEdited ? STALE_UPDATE_MESSAGE_DRAFT_KEPT : STALE_UPDATE_MESSAGE);
            await fetchInquiries();
          }
          return;
        }
        // 更新できていないのに、画面だけ新しいステータスに見えないようにする (#1121)
        setUpdateError(failureMessageOf(body, res.status, "更新に失敗しました"));
        return;
      }

      const data = await res.json().catch(() => null);
      setStaleReloadedId(null);
      setStaleDraftKept(false);
      await fetchInquiries();
      if (selectedInquiry?.id === inquiryId) {
        setSelectedInquiry(prev => {
          if (!prev) return null;
          // API が返した更新後の問い合わせ (本文・メモ・resolvedAt なども最新) があればそれを使う
          if (data?.inquiry) return { ...prev, ...data.inquiry };
          return { ...prev, status: newStatus, adminNotes: adminNotesToSend ?? prev.adminNotes };
        });
        // 管理者メモの入力欄は、保存された内容に合わせる (書きかけでなくなる)
        resetAdminNote(data?.inquiry ? (data.inquiry.adminNotes || "") : (adminNotesToSend ?? adminNote));
      }
    } catch (error) {
      console.error("Failed to update inquiry:", error);
      setUpdateError("更新に失敗しました（通信エラー）");
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 本文と管理者メモを取得できている (メモの編集・ステータス変更をしてよい) 状態
  const detailReady = !detailLoading && !detailError;
  // 409 のあとで詳細を読み直した問い合わせで、残した書きかけのメモが保存されているメモと違う (保存されているメモも見せる。#1917)
  const savedNotesDiffer =
    selectedInquiry !== null &&
    staleReloadedId === selectedInquiry.id &&
    staleDraftKept &&
    detailReady &&
    (selectedInquiry.adminNotes ?? "") !== adminNote;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">問い合わせ管理</h1>
          <p className="text-gray-500 mt-1">
            {loadError ? "問い合わせを表示できません" : `${total ?? inquiries.length}件の問い合わせ`}
          </p>
        </div>
        
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="">すべてのステータス</option>
          {STATUS_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-6">
        {/* Inquiry List */}
        <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {loadError && (
            <div
              role="alert"
              className="bg-red-50 border-b border-red-200 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-4"
            >
              <span>{loadError}</span>
              <button
                onClick={() => fetchInquiries()}
                className="underline whitespace-nowrap hover:text-red-900"
              >
                再読み込み
              </button>
            </div>
          )}
          <div className="divide-y divide-gray-50 max-h-[calc(100vh-250px)] overflow-y-auto">
            {inquiries.map((inquiry) => (
              <motion.div
                key={inquiry.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`p-4 cursor-pointer transition-colors ${
                  selectedInquiry?.id === inquiry.id ? "bg-teal-50" : "hover:bg-gray-50"
                }`}
                onClick={() => {
                  // 更新している間は選び直さない (更新の結果を別の問い合わせのパネルに書き込まないため)
                  if (!updating) openInquiry(inquiry);
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    STATUS_OPTIONS.find(s => s.value === inquiry.status)?.color
                  }`}>
                    {STATUS_OPTIONS.find(s => s.value === inquiry.status)?.label}
                  </span>
                  <span className="text-xs text-gray-400">
                    {TYPE_LABELS[inquiry.inquiryType] || inquiry.inquiryType}
                  </span>
                </div>
                <p className="font-medium text-gray-800 line-clamp-1">{inquiry.subject}</p>
                <div className="flex justify-between items-center mt-1">
                  <p className="text-sm text-gray-500">{inquiry.userName || inquiry.email}</p>
                  <p className="text-xs text-gray-400">
                    {new Date(inquiry.createdAt).toLocaleDateString('ja-JP')}
                  </p>
                </div>
              </motion.div>
            ))}
            {/* 取得に失敗したときは上のエラー表示だけを出す (「該当なし」と誤解させない) */}
            {!loadError && inquiries.length === 0 && (
              <div className="p-8 text-center text-gray-400">
                該当する問い合わせはありません
              </div>
            )}
            {hasMore && (
              <button
                onClick={() => fetchInquiries(page + 1)}
                disabled={loadingMore}
                className="w-full p-4 text-sm font-medium text-teal-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {loadingMore ? "読み込み中..." : "さらに読み込む"}
              </button>
            )}
          </div>
        </div>

        {/* Detail Panel */}
        <AnimatePresence>
          {selectedInquiry && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="w-96 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6"
            >
              <div className="flex justify-between items-start">
                <div>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    STATUS_OPTIONS.find(s => s.value === selectedInquiry.status)?.color
                  }`}>
                    {STATUS_OPTIONS.find(s => s.value === selectedInquiry.status)?.label}
                  </span>
                  <h2 className="text-lg font-bold text-gray-800 mt-2">{selectedInquiry.subject}</h2>
                </div>
                <button
                  onClick={closeInquiry}
                  disabled={updating}
                  className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">送信者</span>
                  <span className="text-gray-800">{selectedInquiry.userName || selectedInquiry.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">種別</span>
                  <span className="text-gray-800">{TYPE_LABELS[selectedInquiry.inquiryType]}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">受信日時</span>
                  <span className="text-gray-800">
                    {new Date(selectedInquiry.createdAt).toLocaleString('ja-JP')}
                  </span>
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-500 mb-2">内容</p>
                {detailError ? (
                  <div
                    role="alert"
                    className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm flex items-center justify-between gap-3"
                  >
                    <span>{detailError}</span>
                    <button
                      onClick={() =>
                        // 409 のあとの読み直しに失敗したときは、詳細だけを取り直す (書きかけのメモは残す)。
                        // 読み直せたら、更新の欄の文も「読み込み直した」の文にする (#1917)
                        staleReloadedId === selectedInquiry.id
                          ? reloadStaleDetail(selectedInquiry.id)
                          : openInquiry(selectedInquiry)
                      }
                      className="underline whitespace-nowrap hover:text-red-900"
                    >
                      再試行
                    </button>
                  </div>
                ) : detailLoading ? (
                  <div className="bg-gray-50 rounded-xl p-4 text-gray-400">読み込み中...</div>
                ) : (
                  <div className="bg-gray-50 rounded-xl p-4 text-gray-700 whitespace-pre-wrap">
                    {selectedInquiry.message}
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm text-gray-500 mb-2">管理者メモ</p>
                {/* 既存のメモを読み込むまでは入力させない (見えていないメモを上書きしないため) */}
                <textarea
                  value={adminNote}
                  onChange={(e) => changeAdminNote(e.target.value)}
                  disabled={!detailReady}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-700 resize-none focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                  rows={3}
                  maxLength={ADMIN_NOTES_MAX_LENGTH}
                  placeholder="対応メモを入力..."
                />
                {savedNotesDiffer && (
                  <div data-testid="inquiry-saved-notes" className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
                    <p className="text-xs text-amber-700 mb-1">いま保存されている管理者メモ（入力欄は書きかけのまま残しています）</p>
                    <p className="text-gray-700 whitespace-pre-wrap">{selectedInquiry.adminNotes || "（なし）"}</p>
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm text-gray-500 mb-2">ステータス変更</p>
                <div className="grid grid-cols-2 gap-2">
                  {STATUS_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleStatusUpdate(selectedInquiry.id, opt.value)}
                      disabled={updating || !detailReady || selectedInquiry.status === opt.value}
                      className={`px-3 py-2 rounded-xl text-sm font-medium transition-all ${
                        selectedInquiry.status === opt.value
                          ? "bg-teal-600 text-white"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      } disabled:opacity-50`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {updateError && (
                  <div
                    role="alert"
                    className="mt-3 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm"
                  >
                    {updateError}
                  </div>
                )}
              </div>

              {selectedInquiry.userId && (
                <a
                  href={`/support/users?id=${selectedInquiry.userId}`}
                  className="block w-full py-3 bg-teal-600 text-white text-center rounded-xl font-medium hover:bg-teal-700 transition-colors"
                >
                  ユーザー詳細を見る
                </a>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

