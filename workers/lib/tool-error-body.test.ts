import { test } from "node:test";
import assert from "node:assert/strict";

import {
	AttachmentValidationError,
	DraftNotFoundError,
	DraftVerificationError,
	EmailNotFoundError,
	InvalidCursorError,
	InvalidMailboxAddressError,
	MailboxNotFoundError,
	MailboxOperationError,
	MoveEmailFailedError,
	NotADraftError,
	OriginalEmailNotFoundError,
	RateLimitedError,
	SendFailedError,
	ThreadNotFoundError,
	type ToolError,
} from "./tool-errors";
import {
	attachmentValidationBody,
	createToolErrorBodyRenderer,
	draftNotFoundBody,
	draftVerificationBody,
	emailNotFoundBody,
	invalidCursorBody,
	invalidMailboxAddressBody,
	logToolErrorCause,
	mailboxNotFoundBody,
	mailboxOperationBody,
	moveEmailFailedBody,
	notADraftBody,
	originalEmailNotFoundBody,
	rateLimitedBody,
	sendFailedBody,
	threadNotFoundBody,
	toToolErrorBody,
	type ToolErrorBodyPlugin,
} from "./tool-error-body";
import { INVALID_CURSOR_MESSAGE } from "./all-inbox";

const cases: [string, ToolErrorBodyPlugin, ToolError, Record<string, string>][] = [
	["EmailNotFoundError", emailNotFoundBody, new EmailNotFoundError("e1"), { error: "Email not found", emailId: "e1" }],
	["DraftNotFoundError", draftNotFoundBody, new DraftNotFoundError("d1"), { error: "Draft not found", draftId: "d1" }],
	[
		"NotADraftError",
		notADraftBody,
		new NotADraftError("d1"),
		{ error: "Cannot discard: email is not a draft", draftId: "d1" },
	],
	[
		"ThreadNotFoundError",
		threadNotFoundBody,
		new ThreadNotFoundError("t1"),
		{ error: "Thread not found", threadId: "t1" },
	],
	[
		"OriginalEmailNotFoundError",
		originalEmailNotFoundBody,
		new OriginalEmailNotFoundError("o1"),
		{ error: "Original email not found", originalEmailId: "o1" },
	],
	[
		"MoveEmailFailedError",
		moveEmailFailedBody,
		new MoveEmailFailedError("e1", "archive"),
		{ error: "Failed to move email", emailId: "e1", folderId: "archive" },
	],
	[
		"SendFailedError",
		sendFailedBody,
		new SendFailedError("reply", { cause: new Error("boom") }),
		{ error: "Failed to send reply: boom" },
	],
	["RateLimitedError", rateLimitedBody, new RateLimitedError("slow down"), { error: "slow down" }],
	[
		"AttachmentValidationError",
		attachmentValidationBody,
		new AttachmentValidationError("bad file"),
		{ error: "bad file" },
	],
	["InvalidCursorError", invalidCursorBody, new InvalidCursorError(), { error: INVALID_CURSOR_MESSAGE }],
	[
		"DraftVerificationError",
		draftVerificationBody,
		new DraftVerificationError(),
		{ error: "Draft verification failed — body could not be verified. Please try again." },
	],
	[
		"InvalidMailboxAddressError",
		invalidMailboxAddressBody,
		new InvalidMailboxAddressError("nodomain"),
		{ error: "Invalid mailbox email address", mailboxId: "nodomain" },
	],
	[
		"MailboxNotFoundError",
		mailboxNotFoundBody,
		new MailboxNotFoundError("x@y.z"),
		{ error: 'Mailbox "x@y.z" not found. Use list_mailboxes to see available mailboxes.', mailboxId: "x@y.z" },
	],
	[
		"MailboxOperationError",
		mailboxOperationBody,
		new MailboxOperationError("getEmail", { cause: new Error("secret internals") }),
		{ error: "Mailbox operation failed: getEmail" },
	],
];

for (const [name, plugin, error, body] of cases) {
	test(`${name} plugin renders its body`, () => {
		assert.deepEqual(plugin.run(error)._unsafeUnwrap(), body);
	});

	test(`${name} plugin passes other errors through as err(input)`, () => {
		const other = error instanceof RateLimitedError ? new EmailNotFoundError("e") : new RateLimitedError("r");
		assert.equal(plugin.run(other)._unsafeUnwrapErr(), other);
	});

	test(`toToolErrorBody renders ${name} through the registry`, () => {
		assert.deepEqual(toToolErrorBody(error), body);
	});
}

test("SendFailedError keeps the email kind in its message", () => {
	assert.equal(new SendFailedError("email", { cause: new Error("x") }).message, "Failed to send email: x");
});

test("MailboxOperationError keeps the raw cause out of the body but on the error", () => {
	const cause = new Error("secret internals");
	const error = new MailboxOperationError("getEmail", { cause });
	assert.equal(error.cause, cause);
	assert.doesNotMatch(JSON.stringify(toToolErrorBody(error)), /secret/);
});

test("a renderer falls back to { error: message } when no plugin matches", () => {
	const render = createToolErrorBodyRenderer([emailNotFoundBody]);
	assert.deepEqual(render(new RateLimitedError("fallback message")), { error: "fallback message" });
});

test("a renderer with no plugins still renders every error", () => {
	const render = createToolErrorBodyRenderer([]);
	assert.deepEqual(render(new EmailNotFoundError("e1")), { error: "Email not found" });
});

test("logToolErrorCause logs the cause of unexpected and verification failures only", () => {
	const logged: unknown[][] = [];
	const log = (...args: unknown[]) => {
		logged.push(args);
	};
	const opCause = new Error("DO reset");
	const verifyCause = new Error("AI down");
	logToolErrorCause(new MailboxOperationError("getEmail", { cause: opCause }), log);
	logToolErrorCause(new DraftVerificationError({ cause: verifyCause }), log);
	logToolErrorCause(new DraftVerificationError(), log);
	logToolErrorCause(new EmailNotFoundError("e1"), log);
	assert.deepEqual(logged, [
		["Mailbox operation failed: getEmail", opCause],
		["Draft verification failed — body could not be verified. Please try again.", verifyCause],
	]);
});
