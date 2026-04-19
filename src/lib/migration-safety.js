/**
 * SQLite migration safety utilities.
 *
 * Prevents data loss from DROP TABLE with foreign_keys=ON (CASCADE deletes).
 */

import Database from 'better-sqlite3';

/**
 * Run a migration function with FK enforcement disabled.
 * Re-enables FKs afterward and verifies integrity.
 *
 * @param {Database} db - better-sqlite3 database instance
 * @param {(db: Database) => void} migrationFn - migration to execute
 * @throws {Error} if FK integrity check fails after migration
 */
export function withFkOff(db, migrationFn) {
  db.pragma('foreign_keys = OFF');
  try {
    migrationFn(db);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violations = db.pragma('foreign_key_check');
  if (violations.length > 0) {
    throw new Error(
      `Migration FK integrity check failed: ${violations.length} violation(s) — ${JSON.stringify(violations)}`,
    );
  }
}

/**
 * Assert that foreign_keys is OFF before proceeding.
 * Call this at the top of any migration block that uses DROP TABLE.
 *
 * @param {Database} db
 * @throws {Error} if foreign_keys is ON
 */
export function assertFkOff(db) {
  const [{ foreign_keys }] = db.pragma('foreign_keys');
  if (foreign_keys) {
    throw new Error(
      'DROP TABLE refused: foreign_keys is ON. Use withFkOff() to wrap this migration.',
    );
  }
}

/**
 * Dry-run a migration on an in-memory clone of the schema.
 * Validates that the migration SQL is syntactically correct and
 * doesn't violate FK constraints, without touching the real database.
 *
 * @param {Database} db - source database (schema is copied)
 * @param {(db: Database) => void} migrationFn - migration to test
 * @returns {{ success: boolean, error?: string }}
 */
export function dryRun(db, migrationFn) {
  const memDb = new Database(':memory:');
  try {
    // Copy schema (CREATE TABLE/INDEX statements) from source
    const schemaSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') ORDER BY type DESC, name")
      .all()
      .map(r => r.sql)
      .join(';\n');
    if (schemaSql) memDb.exec(schemaSql);
    memDb.pragma('foreign_keys = ON');

    migrationFn(memDb);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    memDb.close();
  }
}
