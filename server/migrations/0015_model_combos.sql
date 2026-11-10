-- A combo is one Cursor model-picker name that stands for several models.
-- runs_started counts runs that resolved the combo; the loop strategy rotates
-- the first member with it.
CREATE TABLE model_combos (
    combo_id TEXT PRIMARY KEY NOT NULL,
    sort_order INTEGER NOT NULL,
    display_name TEXT NOT NULL UNIQUE,
    strategy TEXT NOT NULL CHECK (strategy IN ('ordered', 'loop', 'random')),
    runs_started INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

-- Members in fallback order. model_id is an API-key model hash or a
-- provider model id ("provider:..."), so it cannot reference model_configs;
-- the store rewrites or removes API-key members when their model changes.
CREATE TABLE model_combo_members (
    combo_id TEXT NOT NULL REFERENCES model_combos(combo_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    PRIMARY KEY (combo_id, position),
    UNIQUE (combo_id, model_id)
);

CREATE INDEX model_combo_members_model ON model_combo_members(model_id);
