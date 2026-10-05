-- Company-scoped, field-limited workforce directory and password boundary.
-- Keep the existing migration history immutable; this is an additive rollout.

-- A principal is visible only when it has an active membership in the selected
-- company. The primary users.account_id is not membership authority.
DROP POLICY IF EXISTS users_select ON public.users;
DROP POLICY IF EXISTS users_select_company_membership ON public.users;
CREATE POLICY users_select_company_membership ON public.users
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.business_memberships m
       WHERE m.user_id = users.id
         AND m.account_id = public.app_account_id()
         AND m.status = 'active'
    )
  );

-- The web role receives no direct UPDATE privilege on users. These row rules
-- are used by the security-definer functions below, which also enforce the
-- field and company rules before mutating a row.
DROP POLICY IF EXISTS users_update_company_member ON public.users;
CREATE POLICY users_update_company_member ON public.users
  FOR UPDATE USING (
    account_id = public.app_account_id()
    AND EXISTS (
      SELECT 1 FROM public.business_memberships m
       WHERE m.user_id = users.id
         AND m.account_id = public.app_account_id()
         AND m.status = 'active'
    )
    AND (
      public.is_owner_or_admin()
      OR id = public.app_user_id()
    )
  )
  WITH CHECK (
    account_id = public.app_account_id()
    AND EXISTS (
      SELECT 1 FROM public.business_memberships m
       WHERE m.user_id = users.id
         AND m.account_id = public.app_account_id()
         AND m.status = 'active'
    )
    AND (
      public.is_owner_or_admin()
      OR id = public.app_user_id()
    )
  );

-- The roster is deliberately limited to public fields and has no company
-- parameter. Scope comes from the verified transaction context and active
-- membership, and role is the membership role rather than users.role.
CREATE OR REPLACE FUNCTION public.app_company_member_directory()
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  phone text,
  role text,
  status text,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.full_name, u.email, u.phone, m.role, m.status, u.created_at
    FROM public.business_memberships m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.account_id = public.app_account_id()
     AND m.status = 'active'
   ORDER BY m.role, u.full_name, u.email;
$$;
REVOKE ALL ON FUNCTION public.app_company_member_directory() FROM PUBLIC;

-- Login remains on migration 178's one-purpose pre-session helper. This
-- authenticated helper is only for a same-company self-change or owner reset.
CREATE OR REPLACE FUNCTION public.app_user_password_hash(target_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.password_hash
    FROM public.users u
   WHERE u.id = target_user_id
     AND u.account_id = public.app_account_id()
     AND EXISTS (
       SELECT 1 FROM public.business_memberships target_membership
        WHERE target_membership.account_id = public.app_account_id()
          AND target_membership.user_id = u.id
          AND target_membership.status = 'active'
     )
     AND EXISTS (
       SELECT 1 FROM public.business_memberships actor_membership
        WHERE actor_membership.account_id = public.app_account_id()
          AND actor_membership.user_id = public.app_user_id()
          AND actor_membership.status = 'active'
          AND actor_membership.role = public.app_role()
          AND (
            actor_membership.user_id = u.id
            OR (actor_membership.role = 'owner' AND public.app_role() = 'owner')
          )
     );
$$;
REVOKE ALL ON FUNCTION public.app_user_password_hash(uuid) FROM PUBLIC;

-- Profile changes keep the primary-company profile projection usable while
-- preventing a member who belongs to several companies from editing it in the
-- wrong company. Technicians can edit only their own name and phone. Managers
-- can edit company members; only an owner can change the legacy role field.
CREATE OR REPLACE FUNCTION public.app_update_company_member_profile(
  target_user_id uuid,
  next_full_name text,
  next_email text,
  next_phone text,
  next_role text
)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH updated AS (
    UPDATE public.users u
       SET full_name = next_full_name,
           email = next_email,
           phone = next_phone,
           role = next_role,
           updated_at = now()
     WHERE u.id = target_user_id
       AND u.account_id = public.app_account_id()
       AND EXISTS (
         SELECT 1 FROM public.business_memberships target_membership
          WHERE target_membership.account_id = public.app_account_id()
            AND target_membership.user_id = u.id
            AND target_membership.status = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM public.business_memberships actor_membership
          WHERE actor_membership.account_id = public.app_account_id()
            AND actor_membership.user_id = public.app_user_id()
            AND actor_membership.status = 'active'
            AND actor_membership.role = public.app_role()
            AND (
              (
                actor_membership.role IN ('owner', 'admin')
                AND (actor_membership.role = 'owner' OR next_role = u.role)
              )
              OR (
                actor_membership.user_id = u.id
                AND actor_membership.role = 'tech'
                AND next_email = u.email
                AND next_role = u.role
              )
            )
       )
     RETURNING true AS changed
  )
  SELECT COALESCE((SELECT changed FROM updated), false);
$$;
REVOKE ALL ON FUNCTION public.app_update_company_member_profile(uuid, text, text, text, text) FROM PUBLIC;

-- Compare-and-swap the observed hash so a concurrent password change cannot
-- be overwritten after the route verifies the current password.
CREATE OR REPLACE FUNCTION public.app_update_user_password(
  target_user_id uuid,
  expected_password_hash text,
  next_password_hash text
)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH updated AS (
    UPDATE public.users u
       SET password_hash = next_password_hash,
           updated_at = now()
     WHERE u.id = target_user_id
       AND u.account_id = public.app_account_id()
       AND u.password_hash = expected_password_hash
       AND EXISTS (
         SELECT 1 FROM public.business_memberships target_membership
          WHERE target_membership.account_id = public.app_account_id()
            AND target_membership.user_id = u.id
            AND target_membership.status = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM public.business_memberships actor_membership
          WHERE actor_membership.account_id = public.app_account_id()
            AND actor_membership.user_id = public.app_user_id()
            AND actor_membership.status = 'active'
            AND actor_membership.role = public.app_role()
            AND (
              actor_membership.user_id = u.id
              OR (actor_membership.role = 'owner' AND public.app_role() = 'owner')
            )
       )
     RETURNING true AS changed
  )
  SELECT COALESCE((SELECT changed FROM updated), false);
$$;
REVOKE ALL ON FUNCTION public.app_update_user_password(uuid, text, text) FROM PUBLIC;

-- An owner can repair the legacy users.role projection for an unassigned
-- principal in their primary company without creating a membership. This is
-- deliberately separate from the roster and cannot grant session access.
CREATE OR REPLACE FUNCTION public.app_update_legacy_user_role(
  target_user_id uuid,
  next_role text
)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH updated AS (
    UPDATE public.users u
       SET role = next_role,
           updated_at = now()
     WHERE u.id = target_user_id
       AND u.account_id = public.app_account_id()
       AND NOT EXISTS (
         SELECT 1 FROM public.business_memberships target_membership
          WHERE target_membership.account_id = public.app_account_id()
            AND target_membership.user_id = u.id
       )
       AND EXISTS (
         SELECT 1 FROM public.business_memberships actor_membership
          WHERE actor_membership.account_id = public.app_account_id()
            AND actor_membership.user_id = public.app_user_id()
            AND actor_membership.status = 'active'
            AND actor_membership.role = 'owner'
            AND public.app_role() = 'owner'
       )
     RETURNING true AS changed
  )
  SELECT COALESCE((SELECT changed FROM updated), false);
$$;
REVOKE ALL ON FUNCTION public.app_update_legacy_user_role(uuid, text) FROM PUBLIC;

-- Hashes are never directly selectable by application roles. Existing broad
-- SELECT grants are removed, then only the public user columns needed by the
-- current web and worker projections are restored. Direct update/delete are
-- withheld; user removal revokes only the selected company membership.
REVOKE SELECT ON TABLE public.users FROM PUBLIC;
REVOKE SELECT (password_hash) ON TABLE public.users FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_fsm_web') THEN
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.users FROM ai_fsm_web;
    REVOKE SELECT (password_hash) ON TABLE public.users FROM ai_fsm_web;
    GRANT SELECT (id, account_id, email, full_name, phone, role, created_at, updated_at)
      ON TABLE public.users TO ai_fsm_web;
    GRANT INSERT (id, account_id, email, full_name, phone, password_hash, role)
      ON TABLE public.users TO ai_fsm_web;
    GRANT EXECUTE ON FUNCTION public.app_company_member_directory() TO ai_fsm_web;
    GRANT EXECUTE ON FUNCTION public.app_user_password_hash(uuid) TO ai_fsm_web;
    GRANT EXECUTE ON FUNCTION public.app_update_company_member_profile(uuid, text, text, text, text) TO ai_fsm_web;
    GRANT EXECUTE ON FUNCTION public.app_update_user_password(uuid, text, text) TO ai_fsm_web;
    GRANT EXECUTE ON FUNCTION public.app_update_legacy_user_role(uuid, text) TO ai_fsm_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_fsm_worker') THEN
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.users FROM ai_fsm_worker;
    REVOKE SELECT (password_hash) ON TABLE public.users FROM ai_fsm_worker;
    GRANT SELECT (id, account_id, email, full_name, phone, role, created_at, updated_at)
      ON TABLE public.users TO ai_fsm_worker;
  END IF;
END $$;
