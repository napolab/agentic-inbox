// move_email / mark_email_read / get_thread on an id that does not exist must
// fail with a not-found body instead of reporting a success that changed nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, MAILBOX } from "../harness/setup.mts";

const EMAIL = {
	id: "e1", subject: "Hello", sender: "friend@example.com", recipient: MAILBOX,
	date: "2026-09-01T00:00:00Z", read: false, starred: false, body_html: "<p>hi</p>", body_text: "hi",
	message_id: "e1@example.com", thread_id: "thread-1", email_references: null, in_reply_to: null,
	folder_id: "inbox", attachments: [],
};

const FOLDERS = new Set(["inbox", "archive", "trash"]);

// Mirrors the real DO: moveEmail only checks the folder, updateEmail returns getEmail(id).
const realisticStub = (emails: Record<string, unknown>[]) => {
	const byID = new Map(emails.map((e) => [e.id as string, e]));
	return {
		moveEmail: async (_id: string, folderId: string) => FOLDERS.has(folderId),
		updateEmail: async (id: string, patch: { read?: boolean }) => {
			const email = byID.get(id);
			return email ? { ...email, ...patch } : null;
		},
		getThreadEmails: async (threadId: string) => emails.filter((e) => e.thread_id === threadId),
	};
};

type Res = { isError: boolean; text: string; json: unknown };

const assertErrorBody = (res: Res, body: Record<string, string>) => {
	assert.equal(res.isError, true, res.text);
	assert.deepEqual(res.json, body);
	assert.equal(res.text, JSON.stringify(body, null, 2));
};

test("move_email for an unknown email returns the EmailNotFound body and never moves", async () => {
	const { call, callsTo } = await setup({ stub: realisticStub([]) });
	const res = await call("move_email", { mailboxId: MAILBOX, emailId: "ghost", folderId: "archive" });
	assertErrorBody(res, { error: "Email not found", emailId: "ghost" });
	assert.equal(callsTo("moveEmail").length, 0);
});

test("move_email for a known email into an unknown folder still returns the MoveEmailFailed body", async () => {
	const { call } = await setup({ emails: [EMAIL], stub: realisticStub([EMAIL]) });
	const res = await call("move_email", { mailboxId: MAILBOX, emailId: "e1", folderId: "nowhere" });
	assertErrorBody(res, { error: "Failed to move email", emailId: "e1", folderId: "nowhere" });
});

test("move_email happy path moves a known email", async () => {
	const { call, callsTo } = await setup({ emails: [EMAIL], stub: realisticStub([EMAIL]) });
	const res = await call("move_email", { mailboxId: MAILBOX, emailId: "e1", folderId: "archive" });
	assert.equal(res.isError, false, res.text);
	assert.deepEqual(res.json, { status: "moved", emailId: "e1", folder: "archive" });
	assert.deepEqual(callsTo("moveEmail"), [["e1", "archive"]]);
});

test("mark_email_read for an unknown email returns the EmailNotFound body", async () => {
	const { call } = await setup({ stub: realisticStub([]) });
	const res = await call("mark_email_read", { mailboxId: MAILBOX, emailId: "ghost", read: true });
	assertErrorBody(res, { error: "Email not found", emailId: "ghost" });
});

test("mark_email_read happy path updates a known email", async () => {
	const { call, callsTo } = await setup({ emails: [EMAIL], stub: realisticStub([EMAIL]) });
	const res = await call("mark_email_read", { mailboxId: MAILBOX, emailId: "e1", read: true });
	assert.equal(res.isError, false, res.text);
	assert.deepEqual(res.json, { status: "updated", emailId: "e1", read: true });
	assert.deepEqual(callsTo("updateEmail"), [["e1", { read: true }]]);
});

test("get_thread for an unknown thread returns the ThreadNotFound body", async () => {
	const { call } = await setup({ stub: realisticStub([EMAIL]) });
	const res = await call("get_thread", { mailboxId: MAILBOX, threadId: "no-such-thread" });
	assertErrorBody(res, { error: "Thread not found", threadId: "no-such-thread" });
});

test("get_thread happy path returns the thread's messages", async () => {
	const { call } = await setup({ stub: realisticStub([EMAIL]) });
	const res = await call("get_thread", { mailboxId: MAILBOX, threadId: "thread-1" });
	assert.equal(res.isError, false, res.text);
	const json = res.json as { thread_id: string; message_count: number; messages: { id: string }[] };
	assert.equal(json.thread_id, "thread-1");
	assert.equal(json.message_count, 1);
	assert.deepEqual(json.messages.map((m) => m.id), ["e1"]);
});
