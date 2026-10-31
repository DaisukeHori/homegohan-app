/**
 * 運営の強制譲渡の RPC の戻り値 (#1917。supabase/migrations/20261023140000_operator_transfer_return_old_owner.sql)。
 *
 * operator_force_owner_transfer / operator_force_representative_transfer は、組織 / 家族の行を FOR NO KEY UPDATE でロックしてから
 * 旧オーナー / 旧代表者を読み、更新した後の行と一緒に jsonb で返す。route はこの旧オーナー / 旧代表者を、監査
 * (admin_audit_logs の details.from_user_id) と旧オーナー / 旧代表者への知らせの宛先に使う。RPC の前にロックの外で読んだ値は、
 * 運営 2 人がほぼ同時に同じ組織 / 家族を譲渡すると、この譲渡の直前の値 (先の譲渡の相手) と食い違う。
 *
 * 行 (organization / family_group) は、route が読む列 (id・name) だけを確かめ、ほかの列はそのまま応答の data に載せる (looseObject)。
 * migration の前の定義の DB は行そのもの (organization / family_group のキーが無い) を返すので、このスキーマに合わない。
 * そのときは route が、先に読んだ値で記録し、食い違いうることをログに残す。
 */
import { z } from 'zod';

/** operator_force_owner_transfer の戻り値。old_owner_id は組織の行のロックの下で読んだ owner_id (membership_audit の old_owner_id と同じ値) */
export const OperatorForceOwnerTransferResultSchema = z.object({
  organization: z.looseObject({ id: z.string(), name: z.string().nullable() }),
  old_owner_id: z.string().nullable(),
});

export type OperatorForceOwnerTransferResult = z.infer<typeof OperatorForceOwnerTransferResultSchema>;

/** operator_force_representative_transfer の戻り値。old_rep_id は家族の行のロックの下で読んだ representative_id (membership_audit の old_rep_id と同じ値) */
export const OperatorForceRepresentativeTransferResultSchema = z.object({
  family_group: z.looseObject({ id: z.string(), name: z.string().nullable() }),
  old_rep_id: z.string().nullable(),
});

export type OperatorForceRepresentativeTransferResult = z.infer<typeof OperatorForceRepresentativeTransferResultSchema>;

/**
 * 譲渡先がすでに今の代表者 / オーナーのときに、運営の強制譲渡の route が返す失敗 (#2086 V1)。
 *
 * route は RPC の commit のあとに監査 (admin_audit_logs) と全メンバーへの通知メールを待ってから 200 を返すので、その間に
 * プロキシが時間切れ (504 など) を返すと、譲渡は済んでいるのに画面は失敗と見る。そこで「実行する」を押し直すと、RPC は
 * 今の代表者 / オーナー (= 1 回目の譲渡先) を旧代表者 / 旧オーナーとして同じ人へ譲渡し直し、監査と通知メールが二重になる
 * (2 通目は「旧オーナー」欄が新オーナー本人のアドレス)。route はこれを、RPC の前の読み込み (譲渡先が今の代表者 / オーナー) と
 * RPC (ロックの下で読んだ旧代表者 / 旧オーナーが譲渡先と同じなら、何も書かずに同じ語 ALREADY_REPRESENTATIVE / ALREADY_OWNER で断る。
 * supabase/migrations/20261030120000_operator_force_transfer_reject_same.sql。#2093 W5) の両方で見つけ、監査も通知も出さずにこの 409 で止める。
 * その migration を当てる前の DB の RPC は断らずに書くので、route は RPC の戻り値の旧代表者 / 旧オーナーが譲渡先と同じときも 409 にする。
 * 画面 (src/lib/membership/operator-screen-messages.ts の postOperatorForceAction) は、この code を譲渡が済んでいたものとして扱う。
 * このファイルはブラウザからも読む (zod だけに依存する)
 */
export const OPERATOR_FORCE_TRANSFER_ALREADY_REPRESENTATIVE_CODE = 'ALREADY_REPRESENTATIVE';
export const OPERATOR_FORCE_TRANSFER_ALREADY_OWNER_CODE = 'ALREADY_OWNER';

/** 上の 2 つの code を返すときの HTTP ステータス (409 Conflict。今の状態と食い違う操作) */
export const OPERATOR_FORCE_TRANSFER_ALREADY_DONE_STATUS = 409;

/** 上の 2 つの code の本文の文 (画面は code を見て一覧へ戻すので、この文は code を見ない呼び出し元のためのもの) */
export const OPERATOR_FORCE_TRANSFER_ALREADY_REPRESENTATIVE_MESSAGE =
  'この人はすでに代表者です。一覧で今の状態を確かめてください';
export const OPERATOR_FORCE_TRANSFER_ALREADY_OWNER_MESSAGE = 'この人はすでにオーナーです。一覧で今の状態を確かめてください';
