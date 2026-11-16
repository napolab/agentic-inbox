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
	SEND_RATE_LIMITS,
	SENT_SINCE_COUNT_SQL,
	THREAD_LOOKBACK_MS,
	isoSince,
} from "./time-windows";

const runSqlite = (dbPath: string, sql: string): string => {
	return execFileSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
};

// The sqlite3 CLI cannot bind parameters, so substitute them as quoted
// literals. The SQL string itself stays byte-identical to what the DO runs.
const bind = (sql: string, params: readonly string[]): string => {
	return params.reduce(
		(acc, param, index) => acc.replaceAll(`?${index + 1}`, `'${param.replaceAll("'", "''")}'`),
		sql,
	);
};

// A fixed clock keeps the assertions independent of the wall-clock hour.
// The legacy `datetime('now', ...)` form behaved differently depending on how
// far into the UTC day the test happened to run, which is precisely the bug.
const NOW = Date.parse("2026-08-17T11:11:19.000Z");
const HOUR_MS = 60 * 60 * 1000;

// `date` is written with toISOString() -- see the insert sites in workers/index.ts.
const seedSentEmails = (db: string): void => {
	runSqlite(
		db,
		`CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT, date TEXT);
		INSERT INTO emails (id, folder_id, date) VALUES
			('recent',    'sent',  '2026-08-17T11:00:00.000Z'),
			('earlier',   'sent',  '2026-08-17T00:05:00.000Z'),
			('yesterday', 'sent',  '2026-08-16T09:00:00.000Z'),
			('old',       'sent',  '2026-08-10T09:00:00.000Z'),
			('inbound',   'inbox', '2026-08-17T11:05:00.000Z');`,
	);
};

const countSince = (db: string, since: string): number => {
	const out = runSqlite(db, `${bind(SENT_SINCE_COUNT_SQL, ["sent", since])};`);
	return parseInt(out.trim(), 10);
};

const withSeededDb = (run: (db: string) => void): void => {
	const dir = mkdtempSync(join(tmpdir(), "time-windows-test-"));
	const db = join(dir, "test.db");
	try {
		seedSentEmails(db);
		run(db);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test("the hourly window counts only mail sent within the last hour", () => {
	withSeededDb((db) => {
		assert.equal(
			countSince(db, isoSince(NOW, HOUR_MS)),
			1,
			"only 'recent' is within the hour -- 'earlier' is the same UTC day but 11 hours back",
		);
	});
});

test("the daily window counts only mail sent within the last 24 hours", () => {
	withSeededDb((db) => {
		assert.equal(
			countSince(db, isoSince(NOW, 24 * HOUR_MS)),
			2,
			"'recent' and 'earlier'; 'yesterday' is 26 hours back",
		);
	});
});

test("the count is scoped to the sent folder", () => {
	withSeededDb((db) => {
		const out = runSqlite(db, `${bind(SENT_SINCE_COUNT_SQL, ["inbox", isoSince(NOW, HOUR_MS)])};`);
		assert.equal(parseInt(out.trim(), 10), 1, "'inbound' only, never the sent rows");
	});
});

// Regression guard. `date` holds "2026-08-17T00:05:00.000Z" while
// datetime('now') yields "2026-08-17 11:11:19" -- SQLite compares them as TEXT
// and 'T'(0x54) > ' '(0x20), so every row sharing the date part passed the
// filter and the hourly cap silently behaved as a daily one.
test("datetime('now', ...) over-counts because 'T' sorts after ' '", () => {
	withSeededDb((db) => {
		const legacy = runSqlite(
			db,
			`SELECT COUNT(*) FROM emails
			 WHERE folder_id = 'sent'
			   AND date >= datetime('2026-08-17 11:11:19', '-1 hour');`,
		);
		assert.equal(
			parseInt(legacy.trim(), 10),
			2,
			"the legacy form also swallows 'earlier' -- do not reintroduce it",
		);
	});
});

test("isoSince produces an ISO string comparable to the stored date format", () => {
	assert.equal(isoSince(NOW, HOUR_MS), "2026-08-17T10:11:19.000Z");
});

test("the send caps keep the documented hour/day limits", () => {
	assert.deepEqual(
		SEND_RATE_LIMITS.map((limit) => [limit.windowMs, limit.max]),
		[
			[HOUR_MS, 20],
			[24 * HOUR_MS, 100],
		],
	);
});

test("thread lookback stays at seven days", () => {
	assert.equal(THREAD_LOOKBACK_MS, 7 * 24 * HOUR_MS);
});
