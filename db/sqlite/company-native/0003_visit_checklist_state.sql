-- Preserve the visit-local inspection disposition and note on the canonical
-- visit-to-work-order-task relation. Work order task completion status remains
-- a separate lifecycle field and is not overloaded with inspection findings.

ALTER TABLE visit_tasks ADD COLUMN disposition TEXT
  CHECK (disposition IN ('ok','fix_now','monitor','optional','refer'));
ALTER TABLE visit_tasks ADD COLUMN note TEXT;
ALTER TABLE visit_tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
