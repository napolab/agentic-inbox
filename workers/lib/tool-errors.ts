import { INVALID_CURSOR_MESSAGE } from "./all-inbox";

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : `${cause}`);

export class EmailNotFoundError extends Error {
	override name = "EmailNotFoundError" as const;
	constructor(readonly emailId: string) {
		super("Email not found");
	}
}

export class ThreadNotFoundError extends Error {
	override name = "ThreadNotFoundError" as const;
	constructor(readonly threadId: string) {
		super("Thread not found");
	}
}

export class DraftNotFoundError extends Error {
	override name = "DraftNotFoundError" as const;
	constructor(readonly draftId: string) {
		super("Draft not found");
	}
}

export class NotADraftError extends Error {
	override name = "NotADraftError" as const;
	constructor(readonly draftId: string) {
		super("Cannot discard: email is not a draft");
	}
}

export class OriginalEmailNotFoundError extends Error {
	override name = "OriginalEmailNotFoundError" as const;
	constructor(readonly originalEmailId: string) {
		super("Original email not found");
	}
}

export class MoveEmailFailedError extends Error {
	override name = "MoveEmailFailedError" as const;
	constructor(
		readonly emailId: string,
		readonly folderId: string,
	) {
		super("Failed to move email");
	}
}

export class SendFailedError extends Error {
	override name = "SendFailedError" as const;
	constructor(
		readonly kind: "reply" | "email",
		options: { cause: unknown },
	) {
		super(`Failed to send ${kind}: ${describeCause(options.cause)}`, options);
	}
}

/** The message is the Mailbox DO's user-facing rate-limit explanation. */
export class RateLimitedError extends Error {
	override name = "RateLimitedError" as const;
}

/** The message is the recovery hint from validateOutgoingAttachments. */
export class AttachmentValidationError extends Error {
	override name = "AttachmentValidationError" as const;
}

export class InvalidCursorError extends Error {
	override name = "InvalidCursorError" as const;
	constructor() {
		super(INVALID_CURSOR_MESSAGE);
	}
}

export class DraftVerificationError extends Error {
	override name = "DraftVerificationError" as const;
	constructor(options?: { cause?: unknown }) {
		super("Draft verification failed — body could not be verified. Please try again.", options);
	}
}

export class InvalidMailboxAddressError extends Error {
	override name = "InvalidMailboxAddressError" as const;
	constructor(readonly mailboxId: string) {
		super("Invalid mailbox email address");
	}
}

export class MailboxNotFoundError extends Error {
	override name = "MailboxNotFoundError" as const;
	constructor(readonly mailboxId: string) {
		super(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`);
	}
}

/** An unexpected throw from a Durable Object or R2 binding call. */
export class MailboxOperationError extends Error {
	override name = "MailboxOperationError" as const;
	constructor(
		readonly operation: string,
		options: { cause: unknown },
	) {
		super(`Mailbox operation failed: ${operation}`, options);
	}
}

export type ToolError =
	| EmailNotFoundError
	| ThreadNotFoundError
	| DraftNotFoundError
	| NotADraftError
	| OriginalEmailNotFoundError
	| MoveEmailFailedError
	| SendFailedError
	| RateLimitedError
	| AttachmentValidationError
	| InvalidCursorError
	| DraftVerificationError
	| InvalidMailboxAddressError
	| MailboxNotFoundError
	| MailboxOperationError;
