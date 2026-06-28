CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT,
  description TEXT,
  date_text   TEXT,
  date        DATE,
  location    TEXT,
  region      TEXT,
  category    TEXT,
  is_manual   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_date_idx   ON events(date);
CREATE INDEX IF NOT EXISTS events_region_idx ON events(region);
CREATE INDEX IF NOT EXISTS events_source_idx ON events(source);
