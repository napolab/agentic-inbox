// The send binding chooses the Message-ID recipients see (a caller-set one is
// rejected). The Sent copy must store that ID, or a later reply's In-Reply-To
// points at an ID nobody received and Gmail splits the thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, MAILBOX } from "../harness/setup.mts";

test("send_email stores the delivered Message-ID on the Sent copy", async () => {
	const { call, callsTo } = await setup();
	const res = await call("send_email", { mailboxId: MAILBOX, to: "a@example.com", subject: "s", bodyHtml: "<p>x</p>" });
	assert.equal(res.isError, false, res.text);
	assert.equal((callsTo("createEmail")[0][1] as any).message_id, "delivered-1@own.example");
});

test("send_reply to a sent email threads on its delivered Message-ID", async () => {
	const sentEarlier = {
		id: "sent-1", subject: "Hello", sender: MAILBOX, recipient: "friend@example.com",
		date: "2026-09-01T00:00:00Z", read: true, starred: false, body_html: "<p>first</p>",
		message_id: "delivered-0@own.example", thread_id: "sent-1", email_references: null, in_reply_to: null,
	};
	const { call, log, callsTo } = await setup({ emails: [sentEarlier] });
	const res = await call("send_reply", {
		mailboxId: MAILBOX, originalEmailId: "sent-1", to: "friend@example.com", subject: "Re: Hello", bodyHtml: "<p>again</p>",
	});
	assert.equal(res.isError, false, res.text);
	assert.equal(log.sent[0].headers["In-Reply-To"], "<delivered-0@own.example>");
	const stored = callsTo("createEmail")[0][1] as any;
	assert.equal(stored.message_id, "delivered-1@own.example");
	assert.equal(stored.thread_id, "sent-1");
});
