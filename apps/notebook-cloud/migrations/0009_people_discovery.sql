CREATE TABLE IF NOT EXISTS people_discovery_people (
  id TEXT PRIMARY KEY,
  transport_principal TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS private_notebook_participants (
  notebook_id TEXT NOT NULL REFERENCES notebooks(id),
  person_id TEXT NOT NULL REFERENCES people_discovery_people(id),
  last_joined_at TEXT NOT NULL,
  PRIMARY KEY (notebook_id, person_id)
);
CREATE INDEX IF NOT EXISTS private_notebook_participants_person_idx
  ON private_notebook_participants(person_id, notebook_id);
CREATE TABLE IF NOT EXISTS people_suggestion_suppressions (
  id TEXT PRIMARY KEY,
  owner_person_id TEXT NOT NULL REFERENCES people_discovery_people(id),
  target_person_id TEXT NOT NULL REFERENCES people_discovery_people(id),
  created_at TEXT NOT NULL,
  UNIQUE (owner_person_id, target_person_id),
  CHECK (owner_person_id != target_person_id)
);
CREATE INDEX IF NOT EXISTS people_suggestion_suppressions_target_idx
  ON people_suggestion_suppressions(target_person_id, owner_person_id);
