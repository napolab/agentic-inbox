// send_reply with valid attachments but a non-existent originalEmailId (PR #14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, MAILBOX, b64 } from "../harness/setup.mts";

test("send_reply with valid attachments and unknown originalEmailId errors with no side effects", async () => {
	const { call, log, callsTo } = await setup({ emails: [] });
	const res = await call("send_reply", {
		mailboxId: MAILBOX,
		originalEmailId: "does-not-exist",
		to: "friend@example.com",
		subject: "Re: Hello",
		bodyHtml: "<p>here you go</p>",
		attachments: [{ filename: "a.pdf", content: b64("%PDF"), type: "application/pdf" }],
	});
	assert.equal(res.isError, true, res.text);
	assert.match(res.text, /Original email not found/);
	assert.equal(log.sent.length, 0);
	assert.equal(log.r2.length, 0);
	assert.equal(callsTo("createEmail").length, 0);
	assert.deepEqual(callsTo("getEmail").map((a) => a[0]), ["does-not-exist"]);
});
