// Every tool failure is one pretty-JSON `{ error, ...ids }` body with isError,
// rendered per error class regardless of which tool produced it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, MAILBOX, repoImport } from "../harness/setup.mts";

const { INVALID_CURSOR_MESSAGE } = await repoImport("workers/lib/all-inbox.ts");

const ORIGINAL = {
	id: "orig-1", subject: "Hello", sender: "friend@example.com", recipient: MAILBOX,
	date: "2026-09-01T00:00:00Z", read: true, starred: false, body_html: "<p>original</p>",
	message_id: "orig@example.com", thread_id: "thread-1", email_references: null, in_reply_to: null,
};
const SEND = { mailboxId: MAILBOX, to: "a@example.com", subject: "s", bodyHtml: "<p>x</p>" };

type Res = { isError: boolean; text: string; json: unknown };

const assertErrorBody = (res: Res, body: Record<string, string>) => {
	assert.equal(res.isError, true, res.text);
	assert.deepEqual(res.json, body);
	assert.equal(res.text, JSON.stringify(body, null, 2));
};

test("get_email for a missing email returns the EmailNotFound body", async () => {
	const { call } = await setup();
	const res = await call("get_email", { mailboxId: MAILBOX, emailId: "missing" });
	assertErrorBody(res, { error: "Email not found", emailId: "missing" });
});

test("update_draft for a missing draft returns the DraftNotFound body and writes nothing", async () => {
	const { call, callsTo } = await setup();
	const res = await call("update_draft", { mailboxId: MAILBOX, draftId: "gone", subject: "x" });
	assertErrorBody(res, { error: "Draft not found", draftId: "gone" });
	assert.equal(callsTo("createEmail").length, 0);
});

test("delete_email for a missing email returns the EmailNotFound body", async () => {
	const { call } = await setup({ stub: { deleteEmail: async () => null } });
	const res = await call("delete_email", { mailboxId: MAILBOX, emailId: "missing" });
	assertErrorBody(res, { error: "Email not found", emailId: "missing" });
});

test("send_reply to a missing original returns the OriginalEmailNotFound body with no side effects", async () => {
	const { call, log, callsTo } = await setup();
	const res = await call("send_reply", { ...SEND, originalEmailId: "nope" });
	assertErrorBody(res, { error: "Original email not found", originalEmailId: "nope" });
	assert.equal(log.sent.length, 0);
	assert.equal(callsTo("createEmail").length, 0);
});

test("send_email delivery failure returns the SendFailed body and stores no Sent copy", async () => {
	const { call, log, callsTo } = await setup({
		env: { EMAIL: { send: async () => { throw new Error("smtp down"); } } },
	});
	const res = await call("send_email", SEND);
	assertErrorBody(res, { error: "Failed to send email: smtp down" });
	assert.equal(log.r2.length, 0);
	assert.equal(callsTo("createEmail").length, 0);
});

test("send_reply delivery failure returns the SendFailed body for a reply", async () => {
	const { call, callsTo } = await setup({
		emails: [ORIGINAL],
		env: { EMAIL: { send: async () => { throw new Error("smtp down"); } } },
	});
	const res = await call("send_reply", { ...SEND, originalEmailId: "orig-1" });
	assertErrorBody(res, { error: "Failed to send reply: smtp down" });
	assert.equal(callsTo("createEmail").length, 0);
});

test("send_email over the rate limit returns the DO's message and sends nothing", async () => {
	const { call, log } = await setup({ stub: { checkSendRateLimit: async () => "Rate limit: 10 per hour" } });
	const res = await call("send_email", SEND);
	assertErrorBody(res, { error: "Rate limit: 10 per hour" });
	assert.equal(log.sent.length, 0);
});

test("an unknown mailbox returns the MailboxNotFound body before touching the DO", async () => {
	const { call, log } = await setup();
	const res = await call("get_email", { mailboxId: "ghost@own.example", emailId: "e1" });
	assertErrorBody(res, {
		error: 'Mailbox "ghost@own.example" not found. Use list_mailboxes to see available mailboxes.',
		mailboxId: "ghost@own.example",
	});
	assert.equal(log.calls.length, 0);
});

test("list_all_inbox_emails with a garbage cursor returns the InvalidCursor body", async () => {
	const { call } = await setup();
	const res = await call("list_all_inbox_emails", { cursor: "garbage" });
	assertErrorBody(res, { error: INVALID_CURSOR_MESSAGE });
});

test("a throwing DO method becomes a MailboxOperation body without leaking the cause", async () => {
	const { call } = await setup({ stub: { getEmail: async () => { throw new Error("SQLITE internal detail"); } } });
	const res = await call("get_email", { mailboxId: MAILBOX, emailId: "e1" });
	assertErrorBody(res, { error: "Mailbox operation failed: getEmail" });
	assert.doesNotMatch(res.text, /SQLITE/);
});

test("a throwing rate-limit check stops send_email with no side effects", async () => {
	const { call, log, callsTo } = await setup({
		stub: { checkSendRateLimit: async () => { throw new Error("DO reset"); } },
	});
	const res = await call("send_email", SEND);
	assertErrorBody(res, { error: "Mailbox operation failed: checkSendRateLimit" });
	assert.equal(log.sent.length, 0);
	assert.equal(log.r2.length, 0);
	assert.equal(callsTo("createEmail").length, 0);
});

test("a throwing R2 head during mailbox verification is a MailboxOperation error", async () => {
	const { call, log } = await setup({
		env: { BUCKET: { head: async () => { throw new Error("R2 down"); } } },
	});
	const res = await call("list_emails", { mailboxId: MAILBOX });
	assertErrorBody(res, { error: "Mailbox operation failed: verifyMailbox" });
	assert.equal(log.calls.length, 0);
});

test("send_email happy path still sends and stores the Sent copy", async () => {
	const { call, log, callsTo } = await setup();
	const res = await call("send_email", SEND);
	assert.equal(res.isError, false, res.text);
	assert.equal((res.json as { status: string }).status, "sent");
	assert.equal(log.sent.length, 1);
	assert.equal(callsTo("createEmail").length, 1);
});

test("draft_reply happy path saves a draft threaded on the original", async () => {
	const { call, callsTo } = await setup({ emails: [ORIGINAL] });
	const res = await call("draft_reply", {
		mailboxId: MAILBOX, originalEmailId: "orig-1", to: "friend@example.com", subject: "Re: Hello", bodyHtml: "<p>ok</p>",
	});
	assert.equal(res.isError, false, res.text);
	assert.equal((res.json as { status: string }).status, "draft_saved");
	const [folder, record] = callsTo("createEmail")[0] as [string, { thread_id: string; in_reply_to: string }];
	assert.equal(folder, "draft");
	assert.equal(record.thread_id, "thread-1");
	assert.equal(record.in_reply_to, "orig-1");
});
