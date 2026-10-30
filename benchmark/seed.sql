CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

DELETE FROM items WHERE name LIKE 'benchmark-item-%';

INSERT INTO items (name)
SELECT 'benchmark-item-' || value
FROM generate_series(1, 10000) AS series(value);
