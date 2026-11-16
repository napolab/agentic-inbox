import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, splitMbox, unescapeMboxrd } from "./import-mbox";

const DOMAIN = "own.example";

test("received mail routes to the own-domain recipient's inbox", () => {
	const headers = "From: news@service.example\r\nTo: Somebody <news@own.example>\r\nSubject: x\r\n";
	assert.deepEqual(classifyMessage(headers, DOMAIN), { mailbox: "news@own.example", folder: "inbox" });
});

test("mail sent from an own-domain address routes to that mailbox's sent folder", () => {
	const headers = "From: contact@own.example\r\nTo: friend@example.com\r\n";
	assert.deepEqual(classifyMessage(headers, DOMAIN), { mailbox: "contact@own.example", folder: "sent" });
});

test("finds the own-domain address in Cc or Delivered-To", () => {
	const headers = "From: a@b.example\r\nTo: list@lists.example\r\nCc: work@own.example\r\n";
	assert.deepEqual(classifyMessage(headers, DOMAIN), { mailbox: "work@own.example", folder: "inbox" });
	const headers2 = "From: a@b.example\r\nTo: list@lists.example\r\nDelivered-To: billing@own.example\r\n";
	assert.deepEqual(classifyMessage(headers2, DOMAIN), { mailbox: "billing@own.example", folder: "inbox" });
});

test("ignores look-alike domains but still finds a genuine own-domain address alongside one", () => {
	const headers =
		"From: x@example.com\r\nTo: phisher@own.example.evil.com\r\nCc: real@own.example\r\n";
	assert.deepEqual(classifyMessage(headers, DOMAIN), { mailbox: "real@own.example", folder: "inbox" });

	const headersLookAlikeOnly = "From: x@example.com\r\nTo: phisher@own.example.evil.com\r\n";
	assert.equal(classifyMessage(headersLookAlikeOnly, DOMAIN), null);
});

test("skips mail with no own-domain participant (e.g. other-domain-only)", () => {
	const headers = "From: x@example.com\r\nTo: contact@other.example\r\n";
	assert.equal(classifyMessage(headers, DOMAIN), null);
});

test("skips Spam, Trash, Draft, and Chat per X-Gmail-Labels", () => {
	for (const label of ["Spam", "Trash", "Draft", "Chat"]) {
		const headers = `From: x@example.com\r\nTo: hello@own.example\r\nX-Gmail-Labels: Inbox,${label}\r\n`;
		assert.equal(classifyMessage(headers, DOMAIN), null, label);
	}
});

test("splitMbox splits on From_ lines and keeps bodies intact", () => {
	const mbox = [
		"From 1@xxx Thu Jan 01 00:00:00 2026",
		"To: a@own.example",
		"",
		"body one",
		"From 2@xxx Thu Jan 02 00:00:00 2026",
		"To: b@own.example",
		"",
		">From the archives", // mboxrd-escaped body line
		"",
	].join("\n");
	const messages = [...splitMbox(mbox)];
	assert.equal(messages.length, 2);
	assert.match(messages[0], /body one/);
	assert.match(unescapeMboxrd(messages[1]), /^From the archives$/m);
	assert.doesNotMatch(messages[1], /^From 1@xxx/m);
});
