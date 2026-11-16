import { err, ok } from "neverthrow";
import { createRunner, type Plugin } from "./processor";
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

/** What MCP clients and the chat model see for a failed tool call. */
export type ToolErrorBody = {
	error: string;
	emailId?: string;
	threadId?: string;
	draftId?: string;
	originalEmailId?: string;
	folderId?: string;
	mailboxId?: string;
};

export type ToolErrorBodyPlugin = Plugin<ToolError, ToolErrorBody>;

export const emailNotFoundBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof EmailNotFoundError ? ok({ error: e.message, emailId: e.emailId }) : err(e)),
};

export const threadNotFoundBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof ThreadNotFoundError ? ok({ error: e.message, threadId: e.threadId }) : err(e)),
};

export const draftNotFoundBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof DraftNotFoundError ? ok({ error: e.message, draftId: e.draftId }) : err(e)),
};

export const notADraftBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof NotADraftError ? ok({ error: e.message, draftId: e.draftId }) : err(e)),
};

export const originalEmailNotFoundBody: ToolErrorBodyPlugin = {
	run: (e) =>
		e instanceof OriginalEmailNotFoundError
			? ok({ error: e.message, originalEmailId: e.originalEmailId })
			: err(e),
};

export const moveEmailFailedBody: ToolErrorBodyPlugin = {
	run: (e) =>
		e instanceof MoveEmailFailedError ? ok({ error: e.message, emailId: e.emailId, folderId: e.folderId }) : err(e),
};

export const invalidMailboxAddressBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof InvalidMailboxAddressError ? ok({ error: e.message, mailboxId: e.mailboxId }) : err(e)),
};

export const mailboxNotFoundBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof MailboxNotFoundError ? ok({ error: e.message, mailboxId: e.mailboxId }) : err(e)),
};

// The message names only the operation; the raw cause stays server-side.
export const mailboxOperationBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof MailboxOperationError ? ok({ error: e.message }) : err(e)),
};

export const sendFailedBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof SendFailedError ? ok({ error: e.message }) : err(e)),
};

export const rateLimitedBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof RateLimitedError ? ok({ error: e.message }) : err(e)),
};

export const attachmentValidationBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof AttachmentValidationError ? ok({ error: e.message }) : err(e)),
};

export const invalidCursorBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof InvalidCursorError ? ok({ error: e.message }) : err(e)),
};

export const draftVerificationBody: ToolErrorBodyPlugin = {
	run: (e) => (e instanceof DraftVerificationError ? ok({ error: e.message }) : err(e)),
};

export const createToolErrorBodyRenderer = (plugins: readonly ToolErrorBodyPlugin[]) => {
	const runner = createRunner(plugins);
	return (error: ToolError): ToolErrorBody => runner(error).unwrapOr({ error: error.message });
};

export const toToolErrorBody = createToolErrorBodyRenderer([
	mailboxNotFoundBody,
	mailboxOperationBody,
	invalidMailboxAddressBody,
	emailNotFoundBody,
	threadNotFoundBody,
	originalEmailNotFoundBody,
	draftNotFoundBody,
	notADraftBody,
	moveEmailFailedBody,
	attachmentValidationBody,
	rateLimitedBody,
	sendFailedBody,
	draftVerificationBody,
	invalidCursorBody,
]);

// Causes are server-side only: bodies never carry them, so log them at the edge.
export const logToolErrorCause = (
	error: ToolError,
	log: (...args: unknown[]) => void = console.error,
): void => {
	const hasCause =
		error instanceof MailboxOperationError || (error instanceof DraftVerificationError && error.cause !== undefined);
	if (hasCause) log(error.message, error.cause);
};
