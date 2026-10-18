-- Free workout names are independent of the optional legacy classification.
ALTER TABLE workouts ADD COLUMN name text NOT NULL DEFAULT '';
UPDATE workouts SET name = COALESCE(workout_type, '');

CREATE TABLE workout_programs (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 2000),
    name_key text NOT NULL GENERATED ALWAYS AS (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) STORED,
    entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) BETWEEN 1 AND 100),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (user_id, name_key)
);

---- create above / drop below ----

DROP TABLE workout_programs;
ALTER TABLE workouts DROP COLUMN name;
