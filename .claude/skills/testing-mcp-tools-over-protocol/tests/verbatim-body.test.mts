// MCP bodies go out exactly as the caller wrote them — the AI draft verifier
// used to rewrite them (inserting its own commentary, flattening HTML).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, MAILBOX } from "../harness/setup.mts";

const ORIGINAL = {
	id: "orig-1", subject: "Hello", sender: "friend@example.com", recipient: MAILBOX,
	date: "2026-09-01T00:00:00Z", read: true, starred: false, body_html: "<p>original</p>",
	message_id: "orig@example.com", thread_id: "thread-1", email_references: null, in_reply_to: null,
};
const BODY = "<p>ご確認ありがとうございます。添付の資料をご覧ください。</p><ul><li>一点目</li></ul>";
// Mimics the verifier's observed failure: it prepends commentary to the text.
const chattyAI = async () => ({ response: "Drafted via draft_reply to email f17c9a14.\nご確認ありがとうございます。" });

test("send_email sends the caller's HTML body verbatim", async () => {
	const { call, log, callsTo } = await setup({ ai: chattyAI });
	const res = await call("send_email", { mailboxId: MAILBOX, to: "a@example.com", subject: "s", bodyHtml: BODY });
	assert.equal(res.isError, false, res.text);
	assert.equal(log.sent[0].html, BODY);
	assert.equal((callsTo("createEmail")[0][1] as any).body_html, BODY);
});

test("send_reply sends the caller's body verbatim followed by the quoted original", async () => {
	const { call, log } = await setup({ emails: [ORIGINAL], ai: chattyAI });
	const res = await call("send_reply", {
		mailboxId: MAILBOX, originalEmailId: "orig-1", to: "friend@example.com", subject: "Re: Hello", bodyHtml: BODY,
	});
	assert.equal(res.isError, false, res.text);
	assert.ok(log.sent[0].html.startsWith(BODY), log.sent[0].html);
	assert.match(log.sent[0].html, /<blockquote[\s\S]*original/);
});

test("send_email still sends when the AI binding is down", async () => {
	const { call, log } = await setup();
	const res = await call("send_email", { mailboxId: MAILBOX, to: "a@example.com", subject: "s", bodyHtml: BODY });
	assert.equal(res.isError, false, res.text);
	assert.equal(log.sent[0].html, BODY);
});

test("create_draft stores the caller's body verbatim", async () => {
	const { call, callsTo } = await setup({ ai: chattyAI });
	const res = await call("create_draft", { mailboxId: MAILBOX, to: "a@example.com", subject: "s", bodyHtml: BODY });
	assert.equal(res.isError, false, res.text);
	assert.equal((callsTo("createEmail")[0][1] as any).body_html, BODY);
});
