#!/usr/bin/env bash
# Run with migration/admin credentials after migrations, once per runtime role.
# Does not switch running services. Supply RUNTIME_DB_PASSWORD through the env.
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"
: "${RUNTIME_DB_PASSWORD:?RUNTIME_DB_PASSWORD is required}"
export RUNTIME_DB_ROLE="${RUNTIME_DB_ROLE:-ai_fsm_web}"
[[ "$RUNTIME_DB_ROLE" == ai_fsm_web || "$RUNTIME_DB_ROLE" == ai_fsm_worker ]] || {
  echo 'RUNTIME_DB_ROLE must be ai_fsm_web or ai_fsm_worker' >&2
  exit 1
}
psql_cmd() {
  if command -v psql >/dev/null; then
    psql "$MIGRATION_DATABASE_URL" "$@"
  else
    docker run --rm -i --network host -e RUNTIME_DB_ROLE -e RUNTIME_DB_PASSWORD \
      postgres:16 psql "$MIGRATION_DATABASE_URL" "$@"
  fi
}

psql_cmd -X -q -v ON_ERROR_STOP=1 <<'SQL'
\getenv runtime_role RUNTIME_DB_ROLE
\getenv runtime_password RUNTIME_DB_PASSWORD
BEGIN;
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'runtime_role')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'runtime_role') \gexec
-- Refuse to repurpose an owner/admin identity or a role inheriting other roles.
SELECT set_config('provision.runtime_role', :'runtime_role', true);
DO $$
DECLARE r pg_roles;
BEGIN
  SELECT * INTO STRICT r FROM pg_roles WHERE rolname = current_setting('provision.runtime_role');
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
     OR EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
     OR EXISTS (SELECT FROM pg_class WHERE relowner = r.oid)
     OR EXISTS (SELECT FROM pg_namespace WHERE nspowner = r.oid)
     OR EXISTS (SELECT FROM pg_database WHERE datdba = r.oid) THEN
    RAISE EXCEPTION 'Runtime role must not own objects, inherit roles, or have administrative privileges';
  END IF;
END $$;
ALTER ROLE :"runtime_role" LOGIN PASSWORD :'runtime_password';
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"runtime_role";
-- No schema CREATE, TRUNCATE, REFERENCES, migration-table or non-RLS table grants.
-- User hashes are not runtime-readable columns. Login, profile mutation and
-- password mutation use narrowly scoped functions instead.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.users FROM :"runtime_role";
REVOKE ALL (id, account_id, email, full_name, phone, password_hash, role, created_at, updated_at)
  ON TABLE public.users FROM :"runtime_role";
REVOKE SELECT ON TABLE public.users FROM PUBLIC;
REVOKE SELECT (password_hash) ON TABLE public.users FROM PUBLIC;
GRANT SELECT (id, account_id, email, full_name, phone, role, created_at, updated_at)
  ON TABLE public.users TO :"runtime_role";
SELECT format('GRANT INSERT (id, account_id, email, full_name, phone, password_hash, role) ON TABLE public.users TO %I', :'runtime_role')
WHERE :'runtime_role' = 'ai_fsm_web' \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', c.relname, :'runtime_role')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  AND c.relname <> 'users' \gexec
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";
SELECT format('GRANT EXECUTE ON FUNCTION public.app_login_candidates(text) TO %I', :'runtime_role')
WHERE :'runtime_role' = 'ai_fsm_web' \gexec
SELECT format('GRANT EXECUTE ON FUNCTION public.app_company_member_directory() TO %I', :'runtime_role')
WHERE :'runtime_role' = 'ai_fsm_web' \gexec
SELECT format('GRANT EXECUTE ON FUNCTION public.app_user_password_hash(uuid) TO %I', :'runtime_role')
WHERE :'runtime_role' = 'ai_fsm_web' \gexec
SELECT format('GRANT EXECUTE ON FUNCTION public.app_update_company_member_profile(uuid, text, text, text, text) TO %I', :'runtime_role')
WHERE :'runtime_role' = 'ai_fsm_web' \gexec
SELECT format('GRANT EXECUTE ON FUNCTION public.app_update_user_password(uuid, text, text) TO %I', :'runtime_role')
WHERE :'runtime_role' = 'ai_fsm_web' \gexec
SELECT format('GRANT EXECUTE ON FUNCTION public.app_update_legacy_user_role(uuid, text) TO %I', :'runtime_role')
WHERE :'runtime_role' = 'ai_fsm_web' \gexec
COMMIT;
SQL
echo "Provisioned restricted ${RUNTIME_DB_ROLE}; runtime connection settings were not changed."
