import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQuotedReplyBlock, deriveBodyText, listMailboxes, replaceMessageIdHeader } from "./email-helpers";

test("listMailboxes follows R2 truncated/cursor pages until exhausted", async () => {
	const pages: Record<string, { keys: string[]; next?: string }> = {
		start: { keys: ["mailboxes/a@x.com.json", "mailboxes/b@x.com.json"], next: "c1" },
		c1: { keys: ["mailboxes/c@x.com.json"], next: "c2" },
		c2: { keys: ["mailboxes/d@x.com.json"] },
	};
	const seen: (string | undefined)[] = [];
	const bucket = {
		list: async (opts: { prefix?: string; cursor?: string }) => {
			seen.push(opts.cursor);
			const page = pages[opts.cursor ?? "start"];
			if (!page) throw new Error(`unexpected cursor ${opts.cursor}`);
			const objects = page.keys.map((key) => ({ key }));
			return page.next === undefined
				? { objects, truncated: false }
				: { objects, truncated: true, cursor: page.next };
		},
	};

	const result = await listMailboxes(bucket as unknown as R2Bucket);

	assert.deepEqual(
		result.map((m) => m.id),
		["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
	);
	assert.deepEqual(seen, [undefined, "c1", "c2"]);
});

test("deriveBodyText prefers the html part, matching what the user sees", () => {
	// Marketing mail often ships a degenerate text/plain stub; the HTML part is
	// the message the user actually reads, so it must win.
	assert.equal(
		deriveBodyText({
			body_html: "<p>Hello <b>world</b></p>",
			body_text: "This message requires an HTML-capable client.",
		}),
		"Hello world",
	);
});

test("deriveBodyText strips style and script content from the html part", () => {
	assert.equal(
		deriveBodyText({
			body_html: "<style>.a{color:red}</style><script>alert(1)</script><p>Hi</p>",
			body_text: null,
		}),
		"Hi",
	);
});

test("deriveBodyText returns the text part verbatim when there is no html part", () => {
	const text = "Dear customer,\n\nContact John <john@example.com>\nRegards";
	assert.equal(deriveBodyText({ body_html: null, body_text: text }), text);
	assert.equal(deriveBodyText({ body_html: "", body_text: text }), text);
});

test("deriveBodyText returns empty string when both parts are missing", () => {
	assert.equal(deriveBodyText({ body_html: null, body_text: null }), "");
});

test("buildQuotedReplyBlock quotes the text part with preserved line breaks", () => {
	const block = buildQuotedReplyBlock({
		date: "2026-08-11T00:00:00Z",
		sender: "a@example.com",
		body_text: "line one\nline two",
		body_html: null,
	});
	assert.ok(block.includes("line one<br>line two"));
});

test("buildQuotedReplyBlock quotes the stripped html part when one exists", () => {
	const block = buildQuotedReplyBlock({
		date: "2026-08-11T00:00:00Z",
		sender: "a@example.com",
		body_html: "<p>Hello</p>",
		body_text: "text stub",
	});
	assert.ok(block.includes("Hello"));
	assert.ok(!block.includes("text stub"));
	assert.ok(!block.includes("<p>"));
});

test("buildQuotedReplyBlock returns empty string when there is no body", () => {
	assert.equal(
		buildQuotedReplyBlock({ date: "", sender: "x", body_html: null, body_text: null }),
		"",
	);
});

test("replaceMessageIdHeader swaps only the message-id entry", () => {
	const raw = JSON.stringify([
		{ key: "subject", value: "Hi" },
		{ key: "message-id", value: "<provisional@own.example>" },
	]);
	assert.deepEqual(JSON.parse(replaceMessageIdHeader(raw, "delivered@own.example") ?? ""), [
		{ key: "subject", value: "Hi" },
		{ key: "message-id", value: "<delivered@own.example>" },
	]);
});

test("replaceMessageIdHeader returns missing or malformed headers unchanged", () => {
	assert.equal(replaceMessageIdHeader(null, "x@y"), null);
	assert.equal(replaceMessageIdHeader("not json", "x@y"), "not json");
	assert.equal(replaceMessageIdHeader('{"key":"message-id"}', "x@y"), '{"key":"message-id"}');
});
