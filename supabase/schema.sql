-- Clara v1.2. Cole integralmente no SQL Editor do SEU projeto Supabase.
-- Não insira aqui dados reais, tokens, chaves privadas ou senhas.
-- 1 usuário = 1 snapshot JSON versionado. Regras são protegidas por RLS.
BEGIN;

CREATE TABLE IF NOT EXISTS public.finance_snapshots (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND payload -> 'schemaVersion' = '1'::jsonb
    AND jsonb_typeof(payload -> 'sources') = 'array'
    AND jsonb_typeof(payload -> 'entries') = 'array'
    AND jsonb_array_length(payload -> 'sources') <= 200
    AND jsonb_array_length(payload -> 'entries') <= 20000
    AND octet_length(payload::text) <= 10000000
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_snapshots ENABLE ROW LEVEL SECURITY;
-- Grants explícitos: nenhum acesso a usuários anônimos; sem DELETE via API.
REVOKE ALL ON public.finance_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.finance_snapshots TO authenticated;

DROP POLICY IF EXISTS clara_snapshot_select ON public.finance_snapshots;
DROP POLICY IF EXISTS clara_snapshot_insert ON public.finance_snapshots;
DROP POLICY IF EXISTS clara_snapshot_update ON public.finance_snapshots;

CREATE POLICY clara_snapshot_select ON public.finance_snapshots
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY clara_snapshot_insert ON public.finance_snapshots
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY clara_snapshot_update ON public.finance_snapshots
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Mesmo que um cliente não use CAS, a revisão não pode retroceder nem pular.
CREATE OR REPLACE FUNCTION public.clara_validate_snapshot_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Não é permitido transferir um snapshot para outra conta';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'A revisão precisa avançar exatamente uma unidade';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clara_snapshot_revision_guard ON public.finance_snapshots;
CREATE TRIGGER clara_snapshot_revision_guard
BEFORE UPDATE ON public.finance_snapshots
FOR EACH ROW EXECUTE FUNCTION public.clara_validate_snapshot_update();

COMMIT;

-- Verificações após executar: RLS=true, policy SELECT/INSERT/UPDATE;
-- os testes de isolamento real entre duas contas devem ser feitos no app.
