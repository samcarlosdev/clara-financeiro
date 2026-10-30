-- Clara v1.5: executar no SQL Editor do Supabase ANTES de usar o novo aplicativo.
-- Não apaga registros, não modifica RLS e permite ler backups v1.
BEGIN;
ALTER TABLE public.finance_snapshots DROP CONSTRAINT IF EXISTS finance_snapshots_payload_check;
ALTER TABLE public.finance_snapshots ADD CONSTRAINT finance_snapshots_payload_check CHECK (
 jsonb_typeof(payload) = 'object'
 AND (payload ->> 'schemaVersion') IN ('1','2')
 AND CASE WHEN jsonb_typeof(payload->'sources') = 'array' THEN jsonb_array_length(payload->'sources') <= 200 ELSE false END
 AND CASE WHEN jsonb_typeof(payload->'entries') = 'array' THEN jsonb_array_length(payload->'entries') <= 20000 ELSE false END
 AND CASE WHEN (payload->>'schemaVersion') = '2' THEN
    CASE WHEN jsonb_typeof(payload->'payees') = 'array' THEN jsonb_array_length(payload->'payees') <= 300 ELSE false END
 ELSE true END
 AND octet_length(payload::text) <= 10000000
);
-- Evita que um aplicativo v1 antigo sobrescreva um snapshot já migrado.
CREATE OR REPLACE FUNCTION public.clara_prevent_schema_downgrade()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (OLD.payload->>'schemaVersion') = '2' AND (NEW.payload->>'schemaVersion') IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'Clara desatualizado: atualize o aplicativo antes de sincronizar';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS clara_schema_downgrade_guard ON public.finance_snapshots;
CREATE TRIGGER clara_schema_downgrade_guard BEFORE UPDATE ON public.finance_snapshots
FOR EACH ROW EXECUTE FUNCTION public.clara_prevent_schema_downgrade();
COMMIT;
