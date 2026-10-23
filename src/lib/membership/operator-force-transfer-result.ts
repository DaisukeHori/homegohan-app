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
