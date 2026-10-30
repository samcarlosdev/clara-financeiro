-- CLARA v1.3 - SQL de inicializacao / reaplicacao para Supabase PostgreSQL.
-- Execute no SQL Editor do projeto (role postgres). NAO apaga registros.
-- schemaVersion = 1 corresponde ao estado atual do Clara v1.3.

BEGIN;

CREATE TABLE IF NOT EXISTS public.finance_snapshots (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Reaplicavel em projetos que ja tentaram executar a versao anterior.
-- As constraints sao reconstruidas sem remover nenhuma linha da tabela.
ALTER TABLE public.finance_snapshots
  DROP CONSTRAINT IF EXISTS finance_snapshots_payload_check;
ALTER TABLE public.finance_snapshots
  DROP CONSTRAINT IF EXISTS clara_payload_guard;
ALTER TABLE public.finance_snapshots
  DROP CONSTRAINT IF EXISTS clara_revision_positive;

ALTER TABLE public.finance_snapshots
  ADD CONSTRAINT clara_revision_positive CHECK (revision >= 1);

-- CASE garante que jsonb_array_length so seja chamado em arrays.
-- IS DISTINCT FROM trata chaves ausentes/NULL como invalidas.
ALTER TABLE public.finance_snapshots
  ADD CONSTRAINT clara_payload_guard CHECK (
    CASE
      WHEN jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN false
      WHEN (payload -> 'schemaVersion') IS DISTINCT FROM '1'::jsonb THEN false
      WHEN jsonb_typeof(payload -> 'sources') IS DISTINCT FROM 'array' THEN false
      WHEN jsonb_typeof(payload -> 'entries') IS DISTINCT FROM 'array' THEN false
      ELSE
        jsonb_array_length(payload -> 'sources') <= 200
        AND jsonb_array_length(payload -> 'entries') <= 20000
        AND octet_length(payload::text) <= 10000000
    END
  );

ALTER TABLE public.finance_snapshots ENABLE ROW LEVEL SECURITY;

-- A API so autoriza SELECT, INSERT e UPDATE de usuarios autenticados.
REVOKE ALL PRIVILEGES ON TABLE public.finance_snapshots
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.finance_snapshots TO authenticated;

DROP POLICY IF EXISTS clara_snapshot_select ON public.finance_snapshots;
DROP POLICY IF EXISTS clara_snapshot_insert ON public.finance_snapshots;
DROP POLICY IF EXISTS clara_snapshot_update ON public.finance_snapshots;

CREATE POLICY clara_snapshot_select ON public.finance_snapshots
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY clara_snapshot_insert ON public.finance_snapshots
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY clara_snapshot_update ON public.finance_snapshots
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Impede trocar o dono e exige incremento exato da revisao.
CREATE OR REPLACE FUNCTION public.clara_validate_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $clara_guard$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Nao e permitido transferir um snapshot para outra conta';
  END IF;
  IF NEW.revision IS DISTINCT FROM (OLD.revision + 1) THEN
    RAISE EXCEPTION 'A revisao precisa avancar exatamente uma unidade';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$clara_guard$;

DROP TRIGGER IF EXISTS clara_snapshot_revision_guard ON public.finance_snapshots;
CREATE TRIGGER clara_snapshot_revision_guard
  BEFORE UPDATE ON public.finance_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.clara_validate_snapshot_update();

-- Funcao so deve ser executada pelo gatilho; nao expor chamada RPC direta.
REVOKE ALL ON FUNCTION public.clara_validate_snapshot_update()
  FROM PUBLIC, anon, authenticated;

COMMIT;

-- Diagnosticos seguros: nao exibem informacoes financeiras.
SELECT
  'public.finance_snapshots' AS tabela,
  c.relrowsecurity AS rls_habilitada,
  has_table_privilege('authenticated', 'public.finance_snapshots', 'SELECT') AS pode_ler,
  has_table_privilege('authenticated', 'public.finance_snapshots', 'INSERT') AS pode_inserir,
  has_table_privilege('authenticated', 'public.finance_snapshots', 'UPDATE') AS pode_atualizar,
  has_table_privilege('authenticated', 'public.finance_snapshots', 'DELETE') AS pode_excluir
FROM pg_class c
WHERE c.oid = 'public.finance_snapshots'::regclass;
