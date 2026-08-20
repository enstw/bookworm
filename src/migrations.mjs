// Additive-only migrations (PM-06, R5). A pull-mode instance's D1 is never
// re-run through schema.sql — the updater only swaps the Worker — so a release
// that needs a schema change ships the change in the manifest, and the updater
// applies it BEFORE the swap. Two modules share this: package-release.mjs
// reads migrations.sql into the manifest, and the updater runs what the
// manifest carries.
//
// The additive rule is a GATE, not a habit, because a failed swap leaves the
// OLD worker facing the migrated schema: only changes an old worker survives
// are allowed — a new column it ignores, a new table, a new index, a seed
// row. A DROP, DELETE, UPDATE, or a rename would strand the pre-swap code
// against a schema it can no longer read, and R5 is exactly that hazard.

// Split a migrations.sql file into statements, dropping comment lines and
// blanks. Semicolon-terminated, one statement each — the same simple shape
// schema.sql uses.
export function parseMigrations(sql) {
  return sql
    .split("\n").filter((line) => !/^\s*--/.test(line)).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}

const ADDITIVE = [
  /^CREATE TABLE IF NOT EXISTS /is,
  /^CREATE (UNIQUE )?INDEX IF NOT EXISTS /is,
  /^ALTER TABLE \w+ ADD COLUMN /is,
  /^INSERT OR IGNORE INTO /is,
];

// Is this statement one an old worker can survive facing after the swap?
export function isAdditive(sql) {
  return ADDITIVE.some((re) => re.test(sql.trim()));
}
