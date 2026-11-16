// The DO class itself imports "cloudflare:workers" and cannot load under node,
// so this runs the exact condition string #buildSearchConditions splices in
// (buildAfterCondition) against a real SQLite, like migrations.test.ts does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAfterCondition, type SearchAfter } from "../lib/all-inbox";

const ROWS = [
	["e1", "2026-09-02"],
	["e2", "2026-09-01"],
	["e3", "2026-09-01"],
	["e4", "2026-09-01"],
	["e5", "2026-08-31"],
] as const;

const query = (after: SearchAfter | undefined): string[] => {
	const dir = mkdtempSync(join(tmpdir(), "search-after-"));
	try {
		const values = ROWS.map(([id, date]) => `('${id}','${date}')`).join(",");
		const quote = (v: string) => `'${v}'`;
		const where = after ? `WHERE ${buildAfterCondition(after, "e.", quote)}` : "";
		const sql = `CREATE TABLE emails (id TEXT, date TEXT); INSERT INTO emails VALUES ${values};
			SELECT e.id FROM emails e ${where} ORDER BY e.date DESC, e.id ASC;`;
		const out = execFileSync("sqlite3", [join(dir, "t.db")], { input: sql, encoding: "utf8" });
		return out.split("\n").filter((line) => line !== "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test("after: include keeps rows with date <= d", () => {
	assert.deepEqual(query({ date: "2026-09-01", ties: "include" }), ["e2", "e3", "e4", "e5"]);
});

test("after: exclude keeps rows with date < d", () => {
	assert.deepEqual(query({ date: "2026-09-01", ties: "exclude" }), ["e5"]);
});

test("after: after-id keeps older rows plus same-date rows with a greater id", () => {
	assert.deepEqual(query({ date: "2026-09-01", ties: "after-id", id: "e3" }), ["e4", "e5"]);
});

// Mirrors #buildSearchConditions' param allocation (query LIKE ?1..?4, folder
// ?5, then `after`) with the real `?N` addParam and sqlite3 bound parameters.
// The allocation logic is duplicated here because the DO cannot load in node.
test("after-id with ?N params combined with query and folder filters", () => {
	const dir = mkdtempSync(join(tmpdir(), "search-after-params-"));
	try {
		const rows = [
			["e1", "2026-09-02", "hello", "f1"],
			["e2", "2026-09-01", "hello", "f1"],
			["e3", "2026-09-01", "hello", "f1"],
			["e4", "2026-09-01", "hello", "f1"],
			["e5", "2026-09-01", "nomatch", "f1"],
			["e6", "2026-09-01", "hello", "f2"],
			["e7", "2026-08-31", "hello", "f1"],
			["e8", "2026-08-31", "hello", "f2"],
		] as const;
		const values = rows.map(([id, date, subject, folder]) => `('${id}','${date}','${subject}','${folder}')`).join(",");

		const params: string[] = [];
		const addParam = (value: string) => {
			params.push(value);
			return `?${params.length}`;
		};
		const [p1, p2, p3, p4] = ["%hello%", "%hello%", "%hello%", "%hello%"].map(addParam);
		const conditions = [
			`(e.subject LIKE ${p1} OR e.body LIKE ${p2} OR e.sender LIKE ${p3} OR e.recipient LIKE ${p4})`,
		];
		const folderParam = addParam("Inbox");
		conditions.push(`e.folder_id = (SELECT id FROM folders WHERE name = ${folderParam} OR id = ${folderParam} LIMIT 1)`);
		conditions.push(buildAfterCondition({ date: "2026-09-01", ties: "after-id", id: "e3" }, "e.", addParam));

		// sqlite3 dot-commands must start a line, so no indentation here.
		const sql = [
			"CREATE TABLE folders (id TEXT, name TEXT);",
			"INSERT INTO folders VALUES ('f1','Inbox'),('f2','Sent');",
			"CREATE TABLE emails (id TEXT, date TEXT, subject TEXT, folder_id TEXT, body TEXT, sender TEXT, recipient TEXT);",
			`INSERT INTO emails (id, date, subject, folder_id) VALUES ${values};`,
			// Double-quoted so the dot-command tokenizer keeps the inner SQL string
			// literal; otherwise a bare 2026-09-01 is evaluated as integer arithmetic.
			...params.map((value, i) => `.parameter set ?${i + 1} "'${value}'"`),
			`SELECT e.id FROM emails e WHERE ${conditions.join(" AND ")} ORDER BY e.date DESC, e.id ASC;`,
		].join("\n");		const out = execFileSync("sqlite3", [join(dir, "t.db")], { input: sql, encoding: "utf8" });
		assert.deepEqual(out.split("\n").filter((line) => line !== ""), ["e4", "e7"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no after leaves rows in date DESC, id ASC order", () => {
	assert.deepEqual(query(undefined), ["e1", "e2", "e3", "e4", "e5"]);
});
