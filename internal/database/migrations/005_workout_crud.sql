-- Source fields describe provenance, not workout identity.
ALTER TABLE workouts DROP CONSTRAINT workouts_user_id_source_source_ref_key;

---- create above / drop below ----

-- Downgrade requires resolving any duplicate provenance first.
ALTER TABLE workouts ADD CONSTRAINT workouts_user_id_source_source_ref_key UNIQUE (user_id, source, source_ref);
