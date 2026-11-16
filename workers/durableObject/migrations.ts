// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Migration {
	name: string;
	sql: string;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
	sql: SqlStorage,
	migrations: Migration[],
	storage?: DurableObjectStorage,
): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const migration of migrations) {
		const applied = [
			...sql.exec(
				`SELECT 1 FROM d1_migrations WHERE name = ?`,
				migration.name,
			),
		];
		if (applied.length > 0) continue;

		// Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
		// Cloudflare's DO runtime forbids SQL-level transactions -- must use
		// the JS storage.transactionSync() API instead.
		let migrationSql = migration.sql.trim();
		migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
		migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

		const escapedName = migration.name.replace(/'/g, "''");
		const run = () => {
			sql.exec(migrationSql);
			sql.exec(
				`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
			);
		};

		if (storage) {
			// Preferred: atomic transaction via the DO JS API
			storage.transactionSync(run);
		} else {
			// Fallback: run without explicit transaction (each exec is auto-committed)
			run();
		}
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
	const trimmed = sql.trim();
	// Don't double-wrap if someone already added BEGIN/COMMIT
	if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
	return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
	},
	{
		name: "2_add_email_threading",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
	},
	{
		name: "3_add_draft_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
	},
	{
		name: "4_add_message_id",
		sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
	},
	{
		name: "5_add_raw_headers",
		sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
	},
	{
		name: "6_mark_sent_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
	},
	{
		name: "7_add_cc_bcc",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
	},
	{
		// No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
		// instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
		// statements so they're safe to run without a transaction.
		name: "8_add_folder_date_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
	},
	{
		// Store the two MIME parts separately. body_html = HTML part,
		// body_text = plain-text part; either may be NULL. Schema change only:
		// copying the legacy single-column `body` into them happens in
		// backfillBodyParts(), chunked and resumable, because a large mailbox
		// would blow the DO's transaction budget here and roll back forever.
		name: "9_add_body_parts",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN body_html TEXT;
            ALTER TABLE emails ADD COLUMN body_text TEXT;
        `),
	},
];

// ── Legacy body backfill (chunked, resumable) ──────────────────────

/** Marker row in d1_migrations; its presence means the backfill is complete. */
const BACKFILL_MIGRATION_NAME = "9b_backfill_body_parts";

/**
 * A legacy row still awaiting classification: it has a `body` and neither
 * part has been filled in yet. Both chunk statements narrow this same
 * predicate, so a row can only ever be claimed once.
 */
const UNCLASSIFIED_PREDICATE = `body IS NOT NULL AND body_html IS NULL AND body_text IS NULL`;

/**
 * Rows whose legacy `body` is HTML: the GLOB is ≈ /<[a-z]/i followed by '>'.
 * Drafts are exempt from the GLOB — drafts were always authored as HTML
 * (compose editor / agent tools) and draft edit/send/update read only
 * body_html, so a tagless fragment like 'hello' must not fall into body_text
 * where those flows would see an empty draft and overwrite it.
 */
const HTML_CLASSIFIER = `(folder_id = 'draft' OR body GLOB '*<[A-Za-z]*>*')`;

/** Rows copied into body_html, one chunk at a time. */
export const BACKFILL_HTML_CHUNK_SQL = `UPDATE emails SET body_html = body WHERE rowid IN (
	SELECT rowid FROM emails
	WHERE ${UNCLASSIFIED_PREDICATE}
		AND ${HTML_CLASSIFIER}
	LIMIT 1000)`;

/**
 * Rows copied into body_text. The classifier is negated rather than relying
 * on "body_html IS NULL after the html pass": the two statements run in
 * separate chunks, so a later html chunk must not find its rows already
 * claimed by an earlier text chunk.
 */
export const BACKFILL_TEXT_CHUNK_SQL = `UPDATE emails SET body_text = body WHERE rowid IN (
	SELECT rowid FROM emails
	WHERE ${UNCLASSIFIED_PREDICATE}
		AND NOT ${HTML_CLASSIFIER}
	LIMIT 1000)`;

const COUNT_UNCLASSIFIED_SQL = `SELECT COUNT(*) as remaining FROM emails WHERE ${UNCLASSIFIED_PREDICATE}`;

/**
 * Copy legacy single-column `body` values into body_html / body_text.
 *
 * Runs outside the migration runner and outside any single transaction: each
 * chunk commits on its own, so a constructor that dies mid-backfill resumes
 * where it left off on the next request instead of retrying a monolithic
 * transaction that can never fit in the DO's budget.
 *
 * Once every row is classified, a marker row is written to d1_migrations so
 * later constructors exit after a single SELECT.
 */
export function backfillBodyParts(
	sql: SqlStorage,
	storage?: DurableObjectStorage,
): void {
	const done = [
		...sql.exec(`SELECT 1 FROM d1_migrations WHERE name = ?`, BACKFILL_MIGRATION_NAME),
	];
	if (done.length > 0) return;

	const countRemaining = (): number => {
		const row = [...sql.exec(COUNT_UNCLASSIFIED_SQL)][0] as
			| { remaining: number }
			| undefined;
		return row?.remaining ?? 0;
	};

	const runChunk = () => {
		sql.exec(BACKFILL_HTML_CHUNK_SQL);
		sql.exec(BACKFILL_TEXT_CHUNK_SQL);
	};

	for (;;) {
		const remaining = countRemaining();
		if (remaining === 0) break;

		if (storage) {
			// Preferred: one committed chunk per transaction via the DO JS API
			storage.transactionSync(runChunk);
		} else {
			// Fallback: run without explicit transaction (each exec auto-commits)
			runChunk();
		}

		// No progress means the leftovers match neither classifier (only
		// possible with a NULL folder_id, which the schema forbids). Stop
		// rather than spin forever — retrying would never classify them.
		if (countRemaining() >= remaining) break;
	}

	sql.exec(`INSERT INTO d1_migrations (name) VALUES (?)`, BACKFILL_MIGRATION_NAME);
}
