import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyDraftBody } from "./tools";
import { DraftVerificationError } from "./tool-errors";
import { toToolErrorBody } from "./tool-error-body";

test("verifyDraftBody turns a throwing verifier into DraftVerificationError carrying the cause", async () => {
	const cause = new Error("AI binding exploded");
	const result = await verifyDraftBody(async () => {
		throw cause;
	});
	const error = result._unsafeUnwrapErr();
	assert.ok(error instanceof DraftVerificationError);
	assert.equal(error.cause, cause);
	assert.deepEqual(toToolErrorBody(error), {
		error: "Draft verification failed — body could not be verified. Please try again.",
	});
	assert.doesNotMatch(JSON.stringify(toToolErrorBody(error)), /exploded/);
});

test("verifyDraftBody rejects an empty verifier answer without a cause", async () => {
	const error = (await verifyDraftBody(async () => ""))._unsafeUnwrapErr();
	assert.ok(error instanceof DraftVerificationError);
	assert.equal(error.cause, undefined);
});

test("verifyDraftBody passes a sanitized body through", async () => {
	assert.equal((await verifyDraftBody(async () => "clean body"))._unsafeUnwrap(), "clean body");
});
