import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildAfterCondition,
	compareEntries,
	listInboxPage,
	searchAfterFor,
	type InboxCursor,
	type MailboxEmail,
	type MailboxSearch,
	collectMailboxResults,
	PARTIAL_RESULTS_HINT,
	withholdCursorOnFailure,
	decodeCursor,
	encodeCursor,
	mergeMailboxPages,
	type MailboxPage,
} from "./all-inbox";

const email = (id: string, date: string) => ({ id, date });
const ids = (result: { emails: { mailboxId: string; id: string }[] }) =>
	result.emails.map((e) => `${e.mailboxId}/${e.id}`);

test("cursor round-trips, including non-ASCII mailbox ids", () => {
	const cursor = { date: "2026-09-29T07:00:00.000Z", mailboxId: "てすと@own.example", id: "e1" };
	assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
});

test("decodeCursor rejects garbage instead of throwing", () => {
	assert.equal(decodeCursor("not base64!"), null);
	assert.equal(decodeCursor(btoa("{}")), null);
	assert.equal(decodeCursor(btoa('["a","b"]')), null);
	assert.equal(decodeCursor(btoa("[1,2,3]")), null);
	assert.equal(decodeCursor(""), null);
});

test("searchAfterFor picks the tie rule from the mailbox's position vs the cursor", () => {
	const cursor = { date: "2026-09-01", mailboxId: "m", id: "e5" };
	assert.deepEqual(searchAfterFor(cursor, "z"), { date: "2026-09-01", ties: "include" });
	assert.deepEqual(searchAfterFor(cursor, "m"), { date: "2026-09-01", ties: "after-id", id: "e5" });
	assert.deepEqual(searchAfterFor(cursor, "a"), { date: "2026-09-01", ties: "exclude" });
});

test("buildAfterCondition emits the predicate for every ties variant", () => {
	const params: string[] = [];
	const addParam = (v: string) => {
		params.push(v);
		return `?${params.length}`;
	};
	assert.equal(buildAfterCondition({ date: "d", ties: "include" }, "e.", addParam), "e.date <= ?1");
	assert.equal(buildAfterCondition({ date: "d", ties: "exclude" }, "e.", addParam), "e.date < ?2");
	assert.equal(
		buildAfterCondition({ date: "d", ties: "after-id", id: "i" }, "", addParam),
		"(date < ?3 OR (date = ?3 AND id > ?4))",
	);
	assert.deepEqual(params, ["d", "d", "d", "i"]);
});

test("mergeMailboxPages truncated by limit still returns a cursor", () => {
	const pages: MailboxPage[] = [
		{ mailboxId: "a", emails: [email("a1", "2026-09-03"), email("a2", "2026-09-02"), email("a3", "2026-09-01")], exhausted: true },
	];
	const result = mergeMailboxPages(pages, 2);
	assert.deepEqual(ids(result), ["a/a1", "a/a2"]);
	assert.deepEqual(decodeCursor(result.nextCursor ?? ""), {
		date: "2026-09-02",
		mailboxId: "a",
		id: "a2",
	});
});

// Fake per-mailbox search with exactly the DO's SQL semantics: folder ignored,
// `after` predicate, ORDER BY date DESC, id ASC, LIMIT.
const fakeSearch =
	(data: Record<string, MailboxEmail[]>): MailboxSearch =>
	async (mailboxId, after, fetchLimit) => {
		const rows = data[mailboxId] ?? [];
		const matches = (row: MailboxEmail): boolean => {
			if (!after) return true;
			switch (after.ties) {
				case "include":
					return row.date <= after.date;
				case "exclude":
					return row.date < after.date;
				case "after-id":
					return row.date < after.date || (row.date === after.date && row.id > after.id);
			}
		};
		return rows
			.filter(matches)
			.sort((a, b) => (a.date !== b.date ? (a.date > b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			.slice(0, fetchLimit);
	};

const drainPages = async (data: Record<string, MailboxEmail[]>, limit: number) => {
	const mailboxIds = Object.keys(data);
	const search = fakeSearch(data);
	const collectPages = async (
		cursor: InboxCursor | undefined,
		acc: { emails: { mailboxId: string; id: string; date: string }[]; nextCursor: string | null }[],
	): Promise<typeof acc> => {
		if (acc.length > 200) throw new Error("paging did not terminate");
		const result = await listInboxPage({ mailboxIds, search, limit, maxFetch: 100, cursor });
		const next = [...acc, result];
		if (result.nextCursor === null) return next;
		const decoded = decodeCursor(result.nextCursor);
		assert.ok(decoded);
		return collectPages(decoded, next);
	};
	return collectPages(undefined, []);
};

test("paging through mailboxes with a huge tied timestamp block returns every row once, in order", async () => {
	const tied = "2026-09-10T00:00:00.000Z";
	const data: Record<string, MailboxEmail[]> = {
		a: [
			email("a-new", "2026-09-11T00:00:00.000Z"),
			...Array.from({ length: 18 }, (_, i) => email(`a-tie-${`${i}`.padStart(2, "0")}`, tied)),
			email("a-old", "2026-09-01T00:00:00.000Z"),
		],
		b: [
			...Array.from({ length: 7 }, (_, i) => email(`b-tie-${i}`, tied)),
			email("b-mid", "2026-09-05T00:00:00.000Z"),
		],
		c: [email("c-1", "2026-09-10T12:00:00.000Z"), email("c-2", tied)],
	};
	const limit = 5;
	const pages = await drainPages(data, limit);

	const expected = Object.entries(data)
		.flatMap(([mailboxId, rows]) => rows.map((r) => ({ ...r, mailboxId })))
		.sort(compareEntries)
		.map((e) => `${e.mailboxId}/${e.id}`);
	const actual = pages.flatMap((p) => p.emails.map((e) => `${e.mailboxId}/${e.id}`));

	assert.deepEqual(actual, expected);
	assert.equal(new Set(actual).size, actual.length);
	for (const p of pages.slice(0, -1)) assert.equal(p.emails.length, limit);
	const last = pages.at(-1);
	assert.ok(last);
	assert.equal(last.nextCursor, null);
	assert.ok(last.emails.length > 0, "no trailing empty page");
});

test("paging ends without a trailing empty page when rows divide evenly by limit", async () => {
	const data: Record<string, MailboxEmail[]> = {
		a: [email("a1", "2026-09-04"), email("a2", "2026-09-02")],
		b: [email("b1", "2026-09-03"), email("b2", "2026-09-01")],
	};
	const pages = await drainPages(data, 2);
	assert.deepEqual(pages.map((p) => p.emails.length), [2, 2]);
	assert.equal(pages.at(-1)?.nextCursor, null);
});

test("merges mailboxes newest first and tags each email with its mailbox", () => {
	const pages: MailboxPage[] = [
		{ mailboxId: "a", emails: [email("a1", "2026-09-03"), email("a2", "2026-09-01")], exhausted: true },
		{ mailboxId: "b", emails: [email("b1", "2026-09-02")], exhausted: true },
	];
	const result = mergeMailboxPages(pages, 10);
	assert.deepEqual(ids(result), ["a/a1", "b/b1", "a/a2"]);
	assert.equal(result.nextCursor, null);
});

test("never returns rows past the last row of a mailbox that has more", () => {
	// Mailbox a has more rows after a2 (2026-09-05) that we haven't seen, so
	// b's older rows must wait for a later page.
	const pages: MailboxPage[] = [
		{ mailboxId: "a", emails: [email("a1", "2026-09-06"), email("a2", "2026-09-05")], exhausted: false },
		{ mailboxId: "b", emails: [email("b1", "2026-09-04"), email("b2", "2026-09-01")], exhausted: true },
	];
	const result = mergeMailboxPages(pages, 10);
	assert.deepEqual(ids(result), ["a/a1", "a/a2"]);
	assert.notEqual(result.nextCursor, null);
});

test("paging with the cursor neither repeats nor skips emails sharing a timestamp", () => {
	const same = "2026-09-01T00:00:00.000Z";
	const all: MailboxPage[] = [
		{ mailboxId: "a", emails: [email("x", same), email("y", same)], exhausted: true },
		{ mailboxId: "b", emails: [email("x", same)], exhausted: true },
	];

	const first = mergeMailboxPages(all, 2);
	assert.deepEqual(ids(first), ["a/x", "a/y"]);
	assert.ok(first.nextCursor);

	// The merge's cursor filter drops rows at or before the cursor even if a
	// mailbox re-returned them.
	const cursor = decodeCursor(first.nextCursor);
	assert.ok(cursor);
	const second = mergeMailboxPages(all, 2, cursor);
	assert.deepEqual(ids(second), ["b/x"]);
	assert.equal(second.nextCursor, null);
});

test("returns no cursor when there are no emails at all", () => {
	assert.deepEqual(mergeMailboxPages([], 20), { emails: [], nextCursor: null });
});

const page = (mailboxId: string): MailboxPage => ({ mailboxId, emails: [], exhausted: true });
const ok = (mailboxId: string): PromiseFulfilledResult<MailboxPage> => ({
	status: "fulfilled",
	value: page(mailboxId),
});
const ng = (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason });

test("collectMailboxResults returns every page when all fulfilled", () => {
	const result = collectMailboxResults(["a", "b"], [ok("a"), ok("b")]);
	assert.deepEqual(result, { pages: [page("a"), page("b")], failures: [] });
});

test("collectMailboxResults splits mixed results, mapping by index", () => {
	const result = collectMailboxResults(
		["a", "b", "c"],
		[ok("a"), ng(new Error("timeout")), ng("boom")],
	);
	assert.deepEqual(result.pages, [page("a")]);
	assert.deepEqual(result.failures, [
		{ mailboxId: "b", error: "timeout" },
		{ mailboxId: "c", error: "boom" },
	]);
});

test("collectMailboxResults stringifies non-Error reasons", () => {
	const result = collectMailboxResults(["a", "b"], [ng(42), ng(undefined)]);
	assert.deepEqual(result.failures, [
		{ mailboxId: "a", error: "42" },
		{ mailboxId: "b", error: "undefined" },
	]);
});

test("collectMailboxResults with all rejected yields no pages", () => {
	const result = collectMailboxResults(["a", "b"], [ng(new Error("x")), ng(new Error("y"))]);
	assert.deepEqual(result.pages, []);
	assert.equal(result.failures.length, 2);
});

test("withholdCursorOnFailure passes the cursor through when nothing failed", () => {
	assert.deepEqual(withholdCursorOnFailure("cur", []), { nextCursor: "cur" });
	assert.deepEqual(withholdCursorOnFailure(null, []), { nextCursor: null });
});

test("withholdCursorOnFailure nulls the cursor and adds a hint on failure", () => {
	const result = withholdCursorOnFailure("cur", [{ mailboxId: "a", error: "x" }]);
	assert.deepEqual(result, { nextCursor: null, hint: PARTIAL_RESULTS_HINT });
});
