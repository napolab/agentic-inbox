// list_all_inbox_emails: cross-mailbox INBOX listing / search with cursor paging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../harness/setup.mts";

type Row = { id: string; date: string; subject: string; sender: string; read: boolean; folder: string };

const row = (id: string, date: string, extra: Partial<Row> = {}): Row => ({
	id,
	date,
	subject: `subject ${id}`,
	sender: "someone@example.com",
	read: false,
	folder: "inbox",
	...extra,
});

/** Mirrors the DO's `after` predicate in #buildSearchConditions. */
const matchesAfter = (r: Row, after: any): boolean => {
	if (!after) return true;
	switch (after.ties) {
		case "include": return r.date <= after.date;
		case "exclude": return r.date < after.date;
		case "after-id": return r.date < after.date || (r.date === after.date && r.id > after.id);
	}
	throw new Error(`unknown ties: ${after.ties}`);
};

/**
 * Env with one fake Mailbox DO per mailbox. `searchEmails` mimics the real
 * SQL: folder, `after`, is_read, LIKE query/from, ORDER BY date DESC, id ASC, LIMIT.
 * A mailbox mapped to an Error rejects every call.
 */
const multiMailboxEnv = (mailboxes: Record<string, Row[] | Error>) => {
	const calls: [string, Record<string, any>][] = [];
	const stubFor = (mailboxId: string) => ({
		searchEmails: async (o: Record<string, any>) => {
			calls.push([mailboxId, o]);
			const rows = mailboxes[mailboxId];
			if (rows instanceof Error) throw rows;
			return rows
				.filter((r) => r.folder === o.folder)
				.filter((r) => matchesAfter(r, o.after))
				.filter((r) => o.is_read === undefined || r.read === o.is_read)
				.filter((r) => !o.query || `${r.subject} ${r.sender}`.includes(o.query))
				.filter((r) => !o.from || r.sender.includes(o.from))
				.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id < b.id ? -1 : 1))
				.slice(0, o.limit)
				.map(({ folder, ...rest }) => rest);
		},
	});
	const env = {
		MAILBOX: { idFromName: (name: string) => name, get: (id: string) => stubFor(id) },
		BUCKET: {
			head: async () => ({}),
			list: async () => ({
				objects: Object.keys(mailboxes).map((m) => ({ key: `mailboxes/${m}.json` })),
			}),
		},
	};
	return { env, calls };
};

const tag = (e: any) => `${e.mailboxId}/${e.id}`;

test("tools/list exposes list_all_inbox_emails with only optional params", async () => {
	const { client } = await setup();
	const { tools } = await client.listTools();
	const tool = tools.find((t: any) => t.name === "list_all_inbox_emails");
	assert.ok(tool, "list_all_inbox_emails is not registered");
	const props = tool.inputSchema.properties;
	assert.deepEqual(Object.keys(props).sort(), ["cursor", "from", "limit", "query", "unread"]);
	assert.equal(props.limit.type, "integer");
	assert.equal(props.unread.type, "boolean");
	assert.deepEqual(tool.inputSchema.required ?? [], []);
});

test("merges every mailbox's inbox newest first, tagged with mailboxId", async () => {
	const { env, calls } = multiMailboxEnv({
		"a@own.example": [row("a1", "2026-09-03T00:00:00.000Z"), row("a2", "2026-09-01T00:00:00.000Z")],
		"b@second.example": [
			row("b1", "2026-09-02T00:00:00.000Z"),
			row("b-sent", "2026-09-04T00:00:00.000Z", { folder: "sent" }),
		],
	});
	const { call } = await setup({ env });
	const res = await call("list_all_inbox_emails", {});
	assert.equal(res.isError, false, res.text);
	assert.deepEqual(res.json.emails.map(tag), ["a@own.example/a1", "b@second.example/b1", "a@own.example/a2"]);
	assert.equal(res.json.nextCursor, null);
	assert.equal(res.json.mailboxCount, 2);
	assert.ok(calls.every(([, o]) => o.folder === "inbox"));
});

test("walking nextCursor returns every email exactly once, even with a large timestamp tie", async () => {
	const tie = "2026-09-01T00:00:00.000Z";
	const tied = Array.from({ length: 20 }, (_, i) => row(`t${`${i}`.padStart(2, "0")}`, tie));
	const mailboxes = {
		"a@own.example": [row("a1", "2026-09-05T00:00:00.000Z"), ...tied, row("a2", "2026-08-01T00:00:00.000Z")],
		"b@third.example": [row("b1", tie), row("b2", "2026-09-03T00:00:00.000Z")],
		"c@second.example": [row("c1", tie)],
	};
	const { env } = multiMailboxEnv(mailboxes);
	const { call } = await setup({ env });

	const walk = async (cursor: string | undefined, acc: string[][]): Promise<string[][]> => {
		assert.ok(acc.length < 20, "pagination did not terminate");
		const res = await call("list_all_inbox_emails", { limit: 5, ...(cursor === undefined ? {} : { cursor }) });
		assert.equal(res.isError, false, res.text);
		const pages = [...acc, res.json.emails.map(tag)];
		return res.json.nextCursor ? walk(res.json.nextCursor, pages) : pages;
	};
	const pages = await walk(undefined, []);

	const expected = [
		"a@own.example/a1",
		"b@third.example/b2",
		...tied.map((r) => `a@own.example/${r.id}`),
		"b@third.example/b1",
		"c@second.example/c1",
		"a@own.example/a2",
	];
	assert.deepEqual(pages.flat(), expected);
	assert.ok(pages.slice(0, -1).every((p) => p.length === 5), "a non-final page was short");
	assert.ok((pages.at(-1) ?? []).length > 0, "trailing empty page");
});

test("query / from / unread are forwarded to every mailbox as search filters", async () => {
	const { env, calls } = multiMailboxEnv({
		"a@own.example": [row("a1", "2026-09-03T00:00:00.000Z", { subject: "invoice" })],
		"b@third.example": [row("b1", "2026-09-02T00:00:00.000Z", { subject: "hello" })],
	});
	const { call } = await setup({ env });
	const res = await call("list_all_inbox_emails", { query: "invoice", from: "example.com", unread: true });
	assert.equal(res.isError, false, res.text);
	assert.deepEqual(res.json.emails.map((e: any) => e.id), ["a1"]);
	assert.equal(calls.length, 2);
	for (const [, o] of calls) {
		assert.equal(o.query, "invoice");
		assert.equal(o.from, "example.com");
		assert.equal(o.is_read, false);
	}
});

test("a failing mailbox yields partial results, failedMailboxes, and no cursor", async () => {
	const { env } = multiMailboxEnv({
		"a@own.example": [row("a1", "2026-09-03T00:00:00.000Z")],
		"broken@own.example": new Error("DO timed out"),
	});
	const { call } = await setup({ env });
	const res = await call("list_all_inbox_emails", {});
	assert.equal(res.isError, false, res.text);
	assert.deepEqual(res.json.emails.map((e: any) => e.id), ["a1"]);
	assert.deepEqual(res.json.failedMailboxes, [{ mailboxId: "broken@own.example", error: "DO timed out" }]);
	assert.equal(res.json.nextCursor, null);
	assert.match(res.json.hint, /same cursor/);
});

test("an invalid cursor is rejected with a recovery hint before touching any mailbox", async () => {
	const { env, calls } = multiMailboxEnv({ "a@own.example": [row("a1", "2026-09-03T00:00:00.000Z")] });
	const { call } = await setup({ env });
	for (const cursor of ["garbage", ""]) {
		const res = await call("list_all_inbox_emails", { cursor });
		assert.equal(res.isError, true, `cursor ${JSON.stringify(cursor)} was accepted`);
		assert.match(res.text, /nextCursor/);
	}
	assert.equal(calls.length, 0);
});
