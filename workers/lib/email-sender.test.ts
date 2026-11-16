// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { bareMessageId, sendEmail } from "../email-sender";

const captureBinding = () => {
	const sent: unknown[] = [];
	const binding = {
		send: async (message: unknown) => {
			sent.push(message);
			return { messageId: "m1" };
		},
	} as unknown as SendEmail;
	return { binding, sent };
};

test("sendEmail hands the binding decoded bytes, not the base64 text", async () => {
	const original = "inbox MCP attachment test\n日本語の本文\n";
	const { binding, sent } = captureBinding();

	await sendEmail(binding, {
		to: "a@example.com",
		from: "b@example.com",
		subject: "s",
		text: "t",
		attachments: [
			{
				content: Buffer.from(original, "utf8").toString("base64"),
				filename: "attachment-test.txt",
				type: "text/plain",
				disposition: "attachment",
			},
		],
	});

	const [message] = sent as { attachments: { content: unknown }[] }[];
	const content = message?.attachments[0]?.content;
	assert.ok(content instanceof Uint8Array, "a string content is sent by the binding as literal text");
	assert.equal(Buffer.from(content).toString("utf8"), original);
});

test("sendEmail round-trips binary attachment bytes exactly", async () => {
	const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
	const { binding, sent } = captureBinding();

	await sendEmail(binding, {
		to: "a@example.com",
		from: "b@example.com",
		subject: "s",
		text: "t",
		attachments: [
			{
				content: Buffer.from(bytes).toString("base64"),
				filename: "all-bytes.bin",
				type: "application/octet-stream",
				disposition: "attachment",
			},
		],
	});

	const [message] = sent as { attachments: { content: Uint8Array }[] }[];
	assert.deepEqual(message?.attachments[0]?.content, bytes);
});

test("sendEmail returns the binding's Message-ID without angle brackets", async () => {
	const binding = { send: async () => ({ messageId: "<x7Kp2QmZ@own.example>" }) } as unknown as SendEmail;
	const { messageId } = await sendEmail(binding, { to: "a@example.com", from: "b@example.com", subject: "s", text: "t" });
	assert.equal(messageId, "x7Kp2QmZ@own.example");
});

test("bareMessageId leaves an already-bare ID alone", () => {
	assert.equal(bareMessageId("abc@own.example"), "abc@own.example");
	assert.equal(bareMessageId(" <abc@own.example> "), "abc@own.example");
});
