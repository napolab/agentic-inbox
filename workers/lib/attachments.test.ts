// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateOutgoingAttachments } from "./attachments";
import { MAX_TOTAL_ATTACHMENT_BYTES } from "../../shared/attachments";

const base64Of = (bytes: number): string => Buffer.alloc(bytes).toString("base64");

test("validateOutgoingAttachments passes through when no attachments are given", () => {
	assert.deepEqual(validateOutgoingAttachments(undefined), { ok: true, attachments: [] });
	assert.deepEqual(validateOutgoingAttachments([]), { ok: true, attachments: [] });
});

test("validateOutgoingAttachments normalizes a valid attachment for sending", () => {
	const result = validateOutgoingAttachments([
		{ filename: "hello.txt", content: Buffer.from("hello").toString("base64"), type: "text/plain" },
		{ filename: "blob.bin", content: "AAEC" },
	]);
	assert.deepEqual(result, {
		ok: true,
		attachments: [
			{ filename: "hello.txt", content: "aGVsbG8=", type: "text/plain", disposition: "attachment" },
			{ filename: "blob.bin", content: "AAEC", type: "application/octet-stream", disposition: "attachment" },
		],
	});
});

test("validateOutgoingAttachments strips line wrapping from base64", () => {
	const result = validateOutgoingAttachments([{ filename: "a.txt", content: "aGVs\r\nbG8=\n" }]);
	assert.equal(result.ok && result.attachments[0]?.content, "aGVsbG8=");
});

test("validateOutgoingAttachments rejects data: URLs with a hint to strip the prefix", () => {
	const result = validateOutgoingAttachments([
		{ filename: "a.png", content: "data:image/png;base64,AAAA" },
	]);
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.error : "", /attachments\[0\] \("a\.png"\).*data: URL/);
});

test("validateOutgoingAttachments rejects non-base64, base64url and unpadded content", () => {
	for (const content of ["not base64!", "AA-_", "aGVsbG8"]) {
		const result = validateOutgoingAttachments([{ filename: "a.bin", content }]);
		assert.equal(result.ok, false, content);
		assert.match(!result.ok ? result.error : "", /not valid standard base64/);
	}
});

test("validateOutgoingAttachments rejects empty filename and empty content", () => {
	const noName = validateOutgoingAttachments([{ filename: " ", content: "AAAA" }]);
	assert.match(!noName.ok ? noName.error : "", /filename is empty/);
	const noContent = validateOutgoingAttachments([{ filename: "a.bin", content: "" }]);
	assert.match(!noContent.ok ? noContent.error : "", /content is empty/);
});

test("validateOutgoingAttachments enforces the total size cap on decoded bytes", () => {
	const half = MAX_TOTAL_ATTACHMENT_BYTES / 2;
	const atLimit = validateOutgoingAttachments([
		{ filename: "a.bin", content: base64Of(half) },
		{ filename: "b.bin", content: base64Of(half) },
	]);
	assert.equal(atLimit.ok, true);

	const overLimit = validateOutgoingAttachments([
		{ filename: "a.bin", content: base64Of(half) },
		{ filename: "b.bin", content: base64Of(half + 1) },
	]);
	assert.equal(overLimit.ok, false);
	assert.match(!overLimit.ok ? overLimit.error : "", /over the 18\.0MB limit \(a\.bin 9\.0MB, b\.bin 9\.0MB\)/);
});
