-- #1401: force tenant RLS and same-account parent integrity for Workforce data.
-- This is additive; migrations 179–181 remain immutable.

ALTER TABLE workforce_skills
  ADD CONSTRAINT workforce_skills_account_id_id_key UNIQUE (account_id, id);

ALTER TABLE field_job_templates
  ADD CONSTRAINT field_job_templates_account_id_id_key UNIQUE (account_id, id);

ALTER TABLE technician_skills
  DROP CONSTRAINT technician_skills_skill_id_fkey,
  ADD CONSTRAINT technician_skills_membership_same_account_fk
    FOREIGN KEY (account_id, user_id)
    REFERENCES business_memberships (account_id, user_id) ON DELETE CASCADE,
  ADD CONSTRAINT technician_skills_skill_same_account_fk
    FOREIGN KEY (account_id, skill_id)
    REFERENCES workforce_skills (account_id, id) ON DELETE CASCADE;

ALTER TABLE technician_availability
  ADD CONSTRAINT technician_availability_membership_same_account_fk
    FOREIGN KEY (account_id, user_id)
    REFERENCES business_memberships (account_id, user_id) ON DELETE CASCADE;

ALTER TABLE field_job_template_tasks
  DROP CONSTRAINT field_job_template_tasks_template_id_fkey,
  ADD CONSTRAINT field_job_template_tasks_template_same_account_fk
    FOREIGN KEY (account_id, template_id)
    REFERENCES field_job_templates (account_id, id) ON DELETE CASCADE;

ALTER TABLE business_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY business_memberships_select_account ON business_memberships
  FOR SELECT USING (account_id = app_account_id());
CREATE POLICY business_memberships_insert_manager ON business_memberships
  FOR INSERT WITH CHECK (
    account_id = app_account_id()
    AND (
      app_role() = 'owner'
      OR (app_role() = 'admin' AND role = 'tech')
    )
  );
CREATE POLICY business_memberships_update_manager ON business_memberships
  FOR UPDATE USING (
    account_id = app_account_id()
    AND (
      app_role() = 'owner'
      OR (app_role() = 'admin' AND role = 'tech')
    )
  )
  WITH CHECK (
    account_id = app_account_id()
    AND (
      app_role() = 'owner'
      OR (app_role() = 'admin' AND role = 'tech')
    )
  );
CREATE POLICY business_memberships_delete_owner ON business_memberships
  FOR DELETE USING (account_id = app_account_id() AND app_role() = 'owner');

ALTER TABLE workforce_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY workforce_skills_select_account ON workforce_skills
  FOR SELECT USING (account_id = app_account_id());
CREATE POLICY workforce_skills_insert_manager ON workforce_skills
  FOR INSERT WITH CHECK (account_id = app_account_id() AND is_owner_or_admin());
CREATE POLICY workforce_skills_update_manager ON workforce_skills
  FOR UPDATE USING (account_id = app_account_id() AND is_owner_or_admin())
  WITH CHECK (account_id = app_account_id() AND is_owner_or_admin());
CREATE POLICY workforce_skills_delete_manager ON workforce_skills
  FOR DELETE USING (account_id = app_account_id() AND is_owner_or_admin());

ALTER TABLE technician_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY technician_skills_select_active_member ON technician_skills
  FOR SELECT USING (
    account_id = app_account_id()
    AND EXISTS (
      SELECT 1 FROM business_memberships m
       WHERE m.account_id = technician_skills.account_id
         AND m.user_id = technician_skills.user_id
         AND m.status = 'active'
    )
  );
CREATE POLICY technician_skills_insert_manager ON technician_skills
  FOR INSERT WITH CHECK (
    account_id = app_account_id()
    AND is_owner_or_admin()
    AND EXISTS (
      SELECT 1 FROM business_memberships m
       WHERE m.account_id = technician_skills.account_id
         AND m.user_id = technician_skills.user_id
         AND m.status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM workforce_skills s
       WHERE s.account_id = technician_skills.account_id
         AND s.id = technician_skills.skill_id
         AND s.active
    )
  );
CREATE POLICY technician_skills_update_manager ON technician_skills
  FOR UPDATE USING (account_id = app_account_id() AND is_owner_or_admin())
  WITH CHECK (
    account_id = app_account_id()
    AND is_owner_or_admin()
    AND EXISTS (
      SELECT 1 FROM business_memberships m
       WHERE m.account_id = technician_skills.account_id
         AND m.user_id = technician_skills.user_id
         AND m.status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM workforce_skills s
       WHERE s.account_id = technician_skills.account_id
         AND s.id = technician_skills.skill_id
         AND s.active
    )
  );
CREATE POLICY technician_skills_delete_manager ON technician_skills
  FOR DELETE USING (account_id = app_account_id() AND is_owner_or_admin());

ALTER TABLE technician_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_availability FORCE ROW LEVEL SECURITY;
CREATE POLICY technician_availability_select_active_member ON technician_availability
  FOR SELECT USING (
    account_id = app_account_id()
    AND EXISTS (
      SELECT 1 FROM business_memberships m
       WHERE m.account_id = technician_availability.account_id
         AND m.user_id = technician_availability.user_id
         AND m.status = 'active'
    )
  );
CREATE POLICY technician_availability_insert_manager ON technician_availability
  FOR INSERT WITH CHECK (
    account_id = app_account_id()
    AND is_owner_or_admin()
    AND EXISTS (
      SELECT 1 FROM business_memberships m
       WHERE m.account_id = technician_availability.account_id
         AND m.user_id = technician_availability.user_id
         AND m.status = 'active'
    )
  );
CREATE POLICY technician_availability_update_manager ON technician_availability
  FOR UPDATE USING (account_id = app_account_id() AND is_owner_or_admin())
  WITH CHECK (
    account_id = app_account_id()
    AND is_owner_or_admin()
    AND EXISTS (
      SELECT 1 FROM business_memberships m
       WHERE m.account_id = technician_availability.account_id
         AND m.user_id = technician_availability.user_id
         AND m.status = 'active'
    )
  );
CREATE POLICY technician_availability_delete_manager ON technician_availability
  FOR DELETE USING (account_id = app_account_id() AND is_owner_or_admin());

ALTER TABLE field_job_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_job_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY field_job_templates_select_account ON field_job_templates
  FOR SELECT USING (account_id = app_account_id());
CREATE POLICY field_job_templates_insert_manager ON field_job_templates
  FOR INSERT WITH CHECK (account_id = app_account_id() AND is_owner_or_admin());
CREATE POLICY field_job_templates_update_manager ON field_job_templates
  FOR UPDATE USING (account_id = app_account_id() AND is_owner_or_admin())
  WITH CHECK (account_id = app_account_id() AND is_owner_or_admin());
CREATE POLICY field_job_templates_delete_manager ON field_job_templates
  FOR DELETE USING (account_id = app_account_id() AND is_owner_or_admin());

ALTER TABLE field_job_template_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_job_template_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY field_job_template_tasks_select_account ON field_job_template_tasks
  FOR SELECT USING (account_id = app_account_id());
CREATE POLICY field_job_template_tasks_insert_manager ON field_job_template_tasks
  FOR INSERT WITH CHECK (
    account_id = app_account_id()
    AND is_owner_or_admin()
    AND EXISTS (
      SELECT 1 FROM field_job_templates t
       WHERE t.account_id = field_job_template_tasks.account_id
         AND t.id = field_job_template_tasks.template_id
    )
  );
CREATE POLICY field_job_template_tasks_update_manager ON field_job_template_tasks
  FOR UPDATE USING (account_id = app_account_id() AND is_owner_or_admin())
  WITH CHECK (
    account_id = app_account_id()
    AND is_owner_or_admin()
    AND EXISTS (
      SELECT 1 FROM field_job_templates t
       WHERE t.account_id = field_job_template_tasks.account_id
         AND t.id = field_job_template_tasks.template_id
    )
  );
CREATE POLICY field_job_template_tasks_delete_manager ON field_job_template_tasks
  FOR DELETE USING (account_id = app_account_id() AND is_owner_or_admin());

-- Existing installations may have provisioned the restricted web role before
-- these six tables acquired RLS. Grant only row-level DML; forced policies keep
-- every operation tenant-scoped. Fresh installs receive the same grants from
-- db-provision-runtime.sh after migrations.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_fsm_web') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      public.business_memberships,
      public.workforce_skills,
      public.technician_skills,
      public.technician_availability,
      public.field_job_templates,
      public.field_job_template_tasks TO ai_fsm_web';
  END IF;
END $$;
