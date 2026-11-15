-- status_history และ admin_audit_log ยังเป็น append-only แต่ยอมให้ UPDATE ได้เฉพาะ
-- Authorized Anonymization Operation (data-schema §2.3): คอลัมน์ actor เท่านั้น และต้องเปลี่ยนเป็น
-- internpath.anonymous_actor_id ภายใน Transaction ที่ตั้งทั้ง internpath.anonymize = 'on' และ
-- internpath.anonymous_actor_id (ตั้งแบบ local ใน Transaction เดียวกัน; handler ของ UserDeletionRequested เท่านั้น)
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
DECLARE
  actor_column text;
  anonymous_actor_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('internpath.anonymize', true) = 'on' THEN
    actor_column := CASE TG_TABLE_NAME
      WHEN 'status_history' THEN 'actor_id'
      WHEN 'admin_audit_log' THEN 'admin_id'
      ELSE NULL
    END;
    anonymous_actor_id := NULLIF(current_setting('internpath.anonymous_actor_id', true), '')::uuid;

    IF actor_column IS NOT NULL
       AND anonymous_actor_id IS NOT NULL
       AND (to_jsonb(OLD) ->> actor_column) IS NOT NULL
       AND (to_jsonb(NEW) ->> actor_column)::uuid = anonymous_actor_id
       AND (to_jsonb(NEW) ->> actor_column) IS DISTINCT FROM (to_jsonb(OLD) ->> actor_column)
       AND (to_jsonb(NEW) - actor_column) = (to_jsonb(OLD) - actor_column)
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
