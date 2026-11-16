import { test } from "node:test";
import assert from "node:assert/strict";
import {
	addFilesWithinLimit,
	bytesToBase64,
	filesToSendAttachments,
} from "./compose-attachments";
import { MAX_TOTAL_ATTACHMENT_BYTES } from "../../shared/attachments";

function makeFile(name: string, size: number, type = "text/plain"): File {
	return new File([new Uint8Array(size)], name, { type });
}

test("addFilesWithinLimit merges files under the cap", () => {
	const result = addFilesWithinLimit([makeFile("a.txt", 100)], [makeFile("b.txt", 200)]);
	assert.equal(result.outcome, "ok");
	if (result.outcome === "ok") {
		assert.deepEqual(result.files.map((f) => f.name), ["a.txt", "b.txt"]);
	}
});

test("addFilesWithinLimit rejects when the total exceeds the cap", () => {
	const result = addFilesWithinLimit(
		[makeFile("big.bin", MAX_TOTAL_ATTACHMENT_BYTES)],
		[makeFile("straw.txt", 1)],
	);
	assert.equal(result.outcome, "too_large");
	if (result.outcome === "too_large") {
		assert.equal(result.attemptedBytes, MAX_TOTAL_ATTACHMENT_BYTES + 1);
		assert.equal(result.limitBytes, MAX_TOTAL_ATTACHMENT_BYTES);
	}
});

test("bytesToBase64 round-trips content, including chunk boundaries", () => {
	const sizes = [0, 1, 3, 0x8000 - 1, 0x8000, 0x8000 + 1, 0x20000 + 7];
	for (const size of sizes) {
		const bytes = new Uint8Array(size).map((_, i) => i % 256);
		const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
		assert.deepEqual(decoded, bytes, `round-trip failed for size ${size}`);
	}
});

test("filesToSendAttachments encodes content and falls back to octet-stream", async () => {
	const file = new File([new TextEncoder().encode("hello")], "greeting", { type: "" });
	const [attachment] = await filesToSendAttachments([file]);
	assert.equal(attachment.filename, "greeting");
	assert.equal(attachment.type, "application/octet-stream");
	assert.equal(attachment.disposition, "attachment");
	assert.equal(atob(attachment.content), "hello");
});
