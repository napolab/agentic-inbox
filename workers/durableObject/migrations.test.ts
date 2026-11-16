// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BACKFILL_HTML_CHUNK_SQL,
	BACKFILL_TEXT_CHUNK_SQL,
	mailboxMigrations,
} from "./migrations";

const runSqlite = (dbPath: string, sql: string): string => {
	return execFileSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
};

const getMigrationSql = (name: string): string => {
	const migration = mailboxMigrations.find((m) => m.name === name);
	assert.ok(migration, `migration ${name} must exist`);
	return migration.sql;
};

// Mirrors the two BEGIN/COMMIT strips in applyMigrations (migrations.ts) so
// this test exercises the exact SQL string the DO runtime executes -- the
// DO runtime forbids SQL-level transactions and strips this wrapper before
// running the migration via storage.transactionSync().
const stripTransactionWrapper = (sql: string): string => {
	let migrationSql = sql.trim();
	migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
	migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");
	return migrationSql;
};

const CLASSIFICATION_SQL = `SELECT id, body_html IS NOT NULL, body_text IS NOT NULL FROM emails ORDER BY id;`;

const seedLegacyRows = (db: string): void => {
	runSqlite(
		db,
		`CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT, body TEXT);
		INSERT INTO emails (id, folder_id, body) VALUES
			('html', 'inbox', '<div>Hello <b>world</b></div>'),
			('text', 'inbox', 'Dear customer,' || char(10) || 'Regards'),
			('text-addr', 'inbox', 'Contact John <john@example.com>'),
			('text-math', 'inbox', 'if a < b and b > c'),
			('empty', 'inbox', ''),
			('nul', 'inbox', NULL),
			('draft-tagless', 'draft', 'hello'),
			('draft-html', 'draft', '<p>hello</p>');`,
	);
	runSqlite(db, stripTransactionWrapper(getMigrationSql("9_add_body_parts")));
};

const EXPECTED_CLASSIFICATION = [
	// Drafts were always authored as HTML (compose editor / tools),
	// and draft edit/send/update read only body_html -- so legacy
	// draft rows classify as HTML even when the fragment is tagless.
	"draft-html|1|0",
	"draft-tagless|1|0",
	"empty|0|1",
	"html|1|0",
	"nul|0|0",
	"text|0|1",
	"text-addr|1|0",
	"text-math|0|1",
].join("\n");

test("9_add_body_parts only adds the columns -- no full-table UPDATE", () => {
	const sql = getMigrationSql("9_add_body_parts");
	assert.match(sql, /ALTER TABLE emails ADD COLUMN body_html TEXT;/);
	assert.match(sql, /ALTER TABLE emails ADD COLUMN body_text TEXT;/);
	assert.doesNotMatch(
		sql,
		/UPDATE/i,
		"body copies belong in the chunked backfill, not in the migration transaction",
	);
});

test("backfill chunk statements classify legacy bodies into html/text columns", () => {
	const dir = mkdtempSync(join(tmpdir(), "mig-test-"));
	const db = join(dir, "test.db");
	try {
		seedLegacyRows(db);

		// One pass suffices for the fixture set (LIMIT 1000 > 8 rows).
		runSqlite(db, `${BACKFILL_HTML_CHUNK_SQL};\n${BACKFILL_TEXT_CHUNK_SQL};`);
		const afterFirstPass = runSqlite(db, CLASSIFICATION_SQL).trim();
		assert.equal(afterFirstPass, EXPECTED_CLASSIFICATION);

		// A second pass must be a no-op: the loop re-runs the same statements
		// until no rows remain unclassified, so they have to be idempotent.
		runSqlite(db, `${BACKFILL_HTML_CHUNK_SQL};\n${BACKFILL_TEXT_CHUNK_SQL};`);
		assert.equal(runSqlite(db, CLASSIFICATION_SQL).trim(), EXPECTED_CLASSIFICATION);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("text chunk cannot steal rows the html chunk would claim", () => {
	// The text chunk runs first here: it must still leave every html-ish row
	// (and every draft) for the html chunk, otherwise interrupting the
	// backfill between the two statements would misclassify rows forever.
	const dir = mkdtempSync(join(tmpdir(), "mig-test-"));
	const db = join(dir, "test.db");
	try {
		seedLegacyRows(db);

		runSqlite(db, `${BACKFILL_TEXT_CHUNK_SQL};\n${BACKFILL_HTML_CHUNK_SQL};`);
		assert.equal(runSqlite(db, CLASSIFICATION_SQL).trim(), EXPECTED_CLASSIFICATION);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backfill leaves no unclassified rows behind", () => {
	const dir = mkdtempSync(join(tmpdir(), "mig-test-"));
	const db = join(dir, "test.db");
	try {
		seedLegacyRows(db);
		runSqlite(db, `${BACKFILL_HTML_CHUNK_SQL};\n${BACKFILL_TEXT_CHUNK_SQL};`);

		// This is the loop's termination predicate in backfillBodyParts.
		const remaining = runSqlite(
			db,
			`SELECT COUNT(*) FROM emails
			 WHERE body IS NOT NULL AND body_html IS NULL AND body_text IS NULL;`,
		).trim();
		assert.equal(remaining, "0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
