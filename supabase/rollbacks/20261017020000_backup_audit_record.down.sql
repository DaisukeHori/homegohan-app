-- rollback: 20261017020000_backup_audit_record.sql
-- (ファイルは supabase/rollbacks/20261017020000_backup_audit_record.down.sql)
-- 書いた監査行は消さない (残す記録。この down は関数だけを消す)
DROP FUNCTION IF EXISTS public.record_backup_audit(text, jsonb);
