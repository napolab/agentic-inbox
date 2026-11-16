// send_email / send_reply `attachments` (PR #14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, MAILBOX, b64 } from "../harness/setup.mts";

const ORIGINAL = {
	id: "orig-1", subject: "Hello", sender: "friend@example.com", recipient: MAILBOX,
	date: "2026-09-01T00:00:00Z", read: true, starred: false, body_html: "<p>original</p>",
	message_id: "orig@example.com", thread_id: "thread-1", email_references: null, in_reply_to: null,
};
const SEND = { mailboxId: MAILBOX, to: "a@example.com", subject: "s", bodyHtml: "<p>x</p>" };

test("tools/list advertises optional attachments on send_email and send_reply only", async () => {
	const { client } = await setup();
	const { tools } = await client.listTools();
	const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
	for (const name of ["send_email", "send_reply"]) {
		const prop = byName[name].inputSchema.properties.attachments;
		assert.equal(prop?.type, "array", name);
		assert.deepEqual(Object.keys(prop.items.properties).sort(), ["content", "filename", "type"]);
		assert.deepEqual([...prop.items.required].sort(), ["content", "filename"]);
		assert.ok(!byName[name].inputSchema.required.includes("attachments"), `${name}: attachments must be optional`);
	}
	assert.equal(byName.create_draft.inputSchema.properties.attachments, undefined);
});

test("send_email delivers, stores in R2, and records attachment metadata on the Sent copy", async () => {
	const { call, log, callsTo } = await setup();
	const res = await call("send_email", {
		...SEND,
		attachments: [
			{ filename: "note.txt", content: b64("hello"), type: "text/plain" },
			{ filename: "raw.bin", content: "AAEC" },
		],
	});
	assert.equal(res.isError, false, res.text);
	assert.equal(res.json.status, "sent");
	// EMAIL.send gets decoded bytes: a string content is sent as literal text,
	// so the recipient would see the base64 characters instead of the file.
	assert.deepEqual(log.sent[0].attachments, [
		{ content: new Uint8Array(Buffer.from("hello")), filename: "note.txt", type: "text/plain", disposition: "attachment" },
		{ content: new Uint8Array([0, 1, 2]), filename: "raw.bin", type: "application/octet-stream", disposition: "attachment" },
	]);
	assert.equal(Buffer.from(log.r2[0][1]).toString(), "hello");
	assert.deepEqual([...log.r2[1][1]], [0, 1, 2]);
	const [folder, , meta] = callsTo("createEmail")[0] as [string, unknown, any[]];
	assert.equal(folder, "sent");
	assert.deepEqual(meta.map((m) => [m.filename, m.mimetype, m.size]), [
		["note.txt", "text/plain", 5],
		["raw.bin", "application/octet-stream", 3],
	]);
});

test("send_reply carries attachments together with threading headers", async () => {
	const { call, log, callsTo } = await setup({ emails: [ORIGINAL] });
	const res = await call("send_reply", {
		mailboxId: MAILBOX, originalEmailId: "orig-1", to: "friend@example.com", subject: "Re: Hello",
		bodyHtml: "<p>here you go</p>",
		attachments: [{ filename: "a.pdf", content: b64("%PDF"), type: "application/pdf" }],
	});
	assert.equal(res.isError, false, res.text);
	assert.equal(log.sent[0].attachments[0].filename, "a.pdf");
	assert.equal(log.sent[0].headers["In-Reply-To"], "<orig@example.com>");
	assert.equal((callsTo("createEmail")[0][2] as any[])[0].filename, "a.pdf");
});

test("send_email without attachments is unchanged", async () => {
	const { call, log, callsTo } = await setup();
	const res = await call("send_email", SEND);
	assert.equal(res.isError, false, res.text);
	assert.equal(log.sent[0].attachments, undefined);
	assert.deepEqual(callsTo("createEmail")[0][2], []);
});

test("invalid attachments return isError with a recovery hint and have no side effects", async () => {
	const { call, log } = await setup();
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ filename: "x.png", content: "data:image/png;base64,AAAA" }, /data: URL/],
		[{ filename: "x.bin", content: "AA-_" }, /not valid standard base64/],
		[{ filename: "", content: "AAAA" }, /filename is empty/],
		[{ filename: "big.bin", content: Buffer.alloc(18 * 1024 * 1024 + 1).toString("base64") }, /over the 18\.0MB limit/],
	];
	for (const [attachment, hint] of cases) {
		const res = await call("send_email", { ...SEND, attachments: [attachment] });
		assert.equal(res.isError, true);
		assert.match(res.text, hint);
	}
	assert.equal(log.sent.length, 0);
	assert.equal(log.r2.length, 0);
	assert.equal(log.calls.filter(([m]) => m === "createEmail").length, 0);
});

test("schema violations are rejected by MCP input validation before the tool runs", async () => {
	const { call, log } = await setup();
	const res = await call("send_email", { ...SEND, attachments: [{ filename: "a.txt" }] });
	assert.equal(res.isError, true);
	assert.match(res.text, /content/);
	assert.equal(log.sent.length, 0);
});
