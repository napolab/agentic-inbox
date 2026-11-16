// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each tool returns a ResultAsync whose error channel is a ToolError class;
 * the Agent and MCP server render failures with toToolErrorBody at the edge.
 */

import { err, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import type { EmailFull } from "./schemas";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import {
	storeAttachments,
	validateOutgoingAttachments,
	type OutgoingAttachment,
	type OutgoingAttachmentInput,
} from "./attachments";
import { sendEmail, type SendEmailParams } from "../email-sender";
import { Folders } from "../../shared/folders";
import {
	decodeCursor,
	listInboxPage,
	type InboxCursor,
	type MailboxEmail,
	type SearchAfter,
} from "./all-inbox";
import {
	AttachmentValidationError,
	DraftNotFoundError,
	DraftVerificationError,
	EmailNotFoundError,
	InvalidCursorError,
	InvalidMailboxAddressError,
	MailboxOperationError,
	MoveEmailFailedError,
	NotADraftError,
	OriginalEmailNotFoundError,
	RateLimitedError,
	SendFailedError,
	ThreadNotFoundError,
} from "./tool-errors";
import type { Env } from "../types";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: {
		query: string;
		folder?: string;
	}) => Promise<unknown>;
};

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>;
};

type MailboxStub = ReturnType<typeof getMailboxStub>;

// ── binding boundary ───────────────────────────────────────────────

/** Run a binding call, folding any throw (sync or async) into MailboxOperationError. */
export const attemptMailboxOperation = <T>(
	operation: string,
	fn: () => Promise<T>,
): ResultAsync<T, MailboxOperationError> =>
	ResultAsync.fromThrowable(fn, (cause) => new MailboxOperationError(operation, { cause }))();

const callMailbox = <T>(
	env: Env,
	mailboxId: string,
	operation: string,
	fn: (stub: MailboxStub) => Promise<T>,
): ResultAsync<T, MailboxOperationError> =>
	attemptMailboxOperation(operation, async () => fn(getMailboxStub(env, mailboxId)));

const getEmailRecord = (
	env: Env,
	mailboxId: string,
	emailId: string,
): ResultAsync<EmailFull | null, MailboxOperationError> =>
	callMailbox(env, mailboxId, "getEmail", async (stub) => (await stub.getEmail(emailId)) as EmailFull | null);

const requirePresent = <T, E>(value: T | null | undefined, toError: () => E): Result<T, E> => {
	if (value === null || value === undefined) return err(toError());
	return ok(value);
};

// ── list_mailboxes ─────────────────────────────────────────────────

export const toolListMailboxes = (env: Env) =>
	attemptMailboxOperation("listMailboxes", () => listMailboxes(env.BUCKET));

// ── list_emails ────────────────────────────────────────────────────

export const toolListEmails = (
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) =>
	callMailbox(env, mailboxId, "getEmails", (stub) =>
		stub.getEmails({
			folder: params.folder,
			limit: params.limit,
			page: params.page,
			sortColumn: "date",
			sortDirection: "DESC",
		}),
	);

// ── get_email ──────────────────────────────────────────────────────

export const toolGetEmail = (env: Env, mailboxId: string, emailId: string) =>
	callMailbox(env, mailboxId, "getEmail", (stub) => getFullEmail(stub, emailId)).andThen((email) =>
		requirePresent(email, () => new EmailNotFoundError(emailId)),
	);

// ── get_thread ─────────────────────────────────────────────────────

export const toolGetThread = (env: Env, mailboxId: string, threadId: string) =>
	callMailbox(env, mailboxId, "getThreadEmails", (stub) => getFullThread(stub, threadId)).andThen((thread) =>
		thread.message_count > 0 ? ok(thread) : err(new ThreadNotFoundError(threadId)),
	);

// ── list_all_inbox_emails ──────────────────────────────────────────

type InboxFilterStub = {
	searchEmails: (options: {
		folder: string;
		query?: string;
		from?: string;
		is_read?: boolean;
		after?: SearchAfter;
		limit: number;
		page: number;
	}) => Promise<MailboxEmail[]>;
};

type InboxFilter = { query?: string; from?: string; unread?: boolean };

/** The DO caps a single fetch at 100 rows. */
const MAX_DO_FETCH = 100;

const parseCursor = (raw: string | undefined): Result<InboxCursor | undefined, InvalidCursorError> => {
	if (raw === undefined) return ok(undefined);
	return requirePresent(decodeCursor(raw), () => new InvalidCursorError());
};

const searchInbox =
	(env: Env, filter: InboxFilter) => (mailboxId: string, after: SearchAfter | undefined, fetchLimit: number) => {
		const stub = getMailboxStub(env, mailboxId) as unknown as InboxFilterStub;
		return stub.searchEmails({
			folder: Folders.INBOX,
			query: filter.query || undefined,
			from: filter.from || undefined,
			is_read: filter.unread ? false : undefined,
			after,
			limit: fetchLimit,
			page: 1,
		});
	};

export const toolListAllInboxEmails = (
	env: Env,
	params: InboxFilter & { limit: number; cursor?: string },
) =>
	parseCursor(params.cursor)
		.asyncAndThen((cursor) =>
			attemptMailboxOperation("listMailboxes", () => listMailboxes(env.BUCKET)).map((mailboxes) => ({
				cursor,
				mailboxIds: mailboxes.map((m) => m.id),
			})),
		)
		.andThen(({ cursor, mailboxIds }) =>
			attemptMailboxOperation("searchEmails", () =>
				listInboxPage({
					mailboxIds,
					limit: params.limit,
					maxFetch: MAX_DO_FETCH,
					cursor,
					search: searchInbox(env, params),
				}),
			).map(({ emails, nextCursor, hint, failures }) => ({
				emails,
				nextCursor,
				...(hint === undefined ? {} : { hint }),
				mailboxCount: mailboxIds.length,
				...(failures.length > 0 ? { failedMailboxes: failures } : {}),
			})),
		);

// ── search_emails ──────────────────────────────────────────────────

export const toolSearchEmails = (env: Env, mailboxId: string, params: { query: string; folder?: string }) =>
	callMailbox(env, mailboxId, "searchEmails", (stub) =>
		(stub as unknown as MailboxSearchStub).searchEmails({
			query: params.query,
			folder: params.folder,
		}),
	);

// ── draft body ─────────────────────────────────────────────────────

type DraftBodyOptions = { isPlainText?: boolean; runVerifyDraft?: boolean };

/**
 * Only the autonomous agent sets runVerifyDraft: its body is model output that
 * can leak drafting commentary. MCP bodies are stored verbatim.
 */
export const verifyDraftBody = (verify: () => Promise<string>): ResultAsync<string, DraftVerificationError> =>
	ResultAsync.fromThrowable(verify, (cause) => new DraftVerificationError({ cause }))().andThen((sanitized) =>
		sanitized ? ok(sanitized) : err(new DraftVerificationError()),
	);

const prepareDraftBody = (
	env: Env,
	body: string,
	options: DraftBodyOptions,
): ResultAsync<string, DraftVerificationError> => {
	const verified = options.runVerifyDraft ? verifyDraftBody(() => verifyDraft(env.AI, body)) : okAsync(body);
	return verified.map((processed) => (options.isPlainText ? textToHtml(processed) : processed));
};

// ── draft_reply ────────────────────────────────────────────────────

const quoteOriginal = (original: EmailFull | null, fallbackSender: string): string => {
	if (!original) return "";
	return buildQuotedReplyBlock({
		date: original.date,
		sender: original.sender || fallbackSender,
		body_html: original.body_html,
		body_text: original.body_text,
	});
};

export const toolDraftReply = (
	env: Env,
	mailboxId: string,
	params: DraftBodyOptions & {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
	},
) =>
	prepareDraftBody(env, params.body.trim(), params)
		.andThen((processedBody) =>
			getEmailRecord(env, mailboxId, params.originalEmailId).map((original) => ({
				bodyHtml: processedBody + quoteOriginal(original, params.to),
				threadId: original?.thread_id || params.originalEmailId,
			})),
		)
		.andThen(({ bodyHtml, threadId }) => {
			const draftId = crypto.randomUUID();
			return callMailbox(env, mailboxId, "createEmail", (stub) =>
				stub.createEmail(
					Folders.DRAFT,
					{
						id: draftId,
						subject: params.subject,
						sender: mailboxId.toLowerCase(),
						recipient: params.to.toLowerCase(),
						date: new Date().toISOString(),
						body_html: bodyHtml,
						body_text: null,
						in_reply_to: params.originalEmailId,
						email_references: null,
						thread_id: threadId,
					},
					[],
				),
			).map(() => ({
				status: "draft_saved" as const,
				draftId,
				message: "Draft saved to Drafts folder. Review it and confirm to send.",
				draft: {
					originalEmailId: params.originalEmailId,
					to: params.to,
					subject: params.subject,
					body: params.isPlainText ? params.body.trim() : bodyHtml,
				},
			}));
		});

// ── draft_email (new email, not a reply) ───────────────────────────

type ThreadHint = { in_reply_to?: string; thread_id?: string };

const resolveDraftThreadId = (
	env: Env,
	mailboxId: string,
	hint: ThreadHint,
	draftId: string,
): ResultAsync<string, MailboxOperationError> => {
	if (hint.thread_id) return okAsync(hint.thread_id);
	const inReplyTo = hint.in_reply_to;
	if (!inReplyTo) return okAsync(draftId);
	return getEmailRecord(env, mailboxId, inReplyTo).map((original) => original?.thread_id || inReplyTo);
};

export const toolDraftEmail = (
	env: Env,
	mailboxId: string,
	params: DraftBodyOptions &
		ThreadHint & {
			to: string;
			subject: string;
			body: string;
		},
) => {
	const draftId = crypto.randomUUID();
	return prepareDraftBody(env, params.body.trim(), params)
		.andThen((processedBody) =>
			resolveDraftThreadId(env, mailboxId, params, draftId).map((threadId) => ({ processedBody, threadId })),
		)
		.andThen(({ processedBody, threadId }) =>
			callMailbox(env, mailboxId, "createEmail", (stub) =>
				stub.createEmail(
					Folders.DRAFT,
					{
						id: draftId,
						subject: params.subject,
						sender: mailboxId.toLowerCase(),
						recipient: (params.to || "").toLowerCase(),
						date: new Date().toISOString(),
						body_html: processedBody,
						body_text: null,
						in_reply_to: params.in_reply_to || null,
						email_references: null,
						thread_id: threadId,
					},
					[],
				),
			).map(() => ({
				status: "draft_saved" as const,
				draftId,
				threadId,
				message: "Draft saved to Drafts folder. Review it and confirm to send.",
				draft: {
					to: params.to,
					subject: params.subject,
					body: params.isPlainText ? params.body.trim() : processedBody,
				},
			})),
		);
};

// ── update_draft ───────────────────────────────────────────────────

// Text-only drafts (moved into Drafts by the user) have no html part —
// fall back to the text part so the update does not erase the body.
const existingDraftHtml = (draft: EmailFull): string =>
	draft.body_html ?? (draft.body_text ? textToHtml(draft.body_text) : "");

export const toolUpdateDraft = (
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
) =>
	getEmailRecord(env, mailboxId, params.draftId)
		.andThen((draft) => requirePresent(draft, () => new DraftNotFoundError(params.draftId)))
		.andThen((oldDraft) =>
			callMailbox(env, mailboxId, "deleteEmail", (stub) => stub.deleteEmail(params.draftId)).map(() => oldDraft),
		)
		.andThen((oldDraft) => {
			const newDraftId = crypto.randomUUID();
			return callMailbox(env, mailboxId, "createEmail", (stub) =>
				stub.createEmail(
					Folders.DRAFT,
					{
						id: newDraftId,
						subject: params.subject ?? oldDraft.subject,
						sender: mailboxId.toLowerCase(),
						recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
						date: new Date().toISOString(),
						body_html: params.bodyHtml ?? existingDraftHtml(oldDraft),
						body_text: null,
						in_reply_to: oldDraft.in_reply_to || null,
						email_references: oldDraft.email_references || null,
						thread_id: oldDraft.thread_id || newDraftId,
					},
					[],
				),
			).map(() => ({
				status: "draft_updated" as const,
				newDraftId,
				oldDraftId: params.draftId,
				message: "Draft updated in Drafts folder.",
			}));
		});

// ── mark_email_read ────────────────────────────────────────────────

// updateEmail returns the re-read row, so null means no email had that id.
export const toolMarkEmailRead = (env: Env, mailboxId: string, emailId: string, read: boolean) =>
	callMailbox(env, mailboxId, "updateEmail", (stub) => stub.updateEmail(emailId, { read }))
		.andThen((updated) => requirePresent(updated, () => new EmailNotFoundError(emailId)))
		.map(() => ({ status: "updated" as const, emailId, read }));

// ── move_email ─────────────────────────────────────────────────────

// The DO's moveEmail only reports whether the folder exists, so check the email first.
export const toolMoveEmail = (env: Env, mailboxId: string, emailId: string, folderId: string) =>
	getEmailRecord(env, mailboxId, emailId)
		.andThen((email) => requirePresent(email, () => new EmailNotFoundError(emailId)))
		.andThen(() => callMailbox(env, mailboxId, "moveEmail", (stub) => stub.moveEmail(emailId, folderId)))
		.andThen((moved) =>
			moved
				? ok({ status: "moved" as const, emailId, folder: folderId })
				: err(new MoveEmailFailedError(emailId, folderId)),
		);

// ── discard_draft ──────────────────────────────────────────────────

export const toolDiscardDraft = (env: Env, mailboxId: string, draftId: string) =>
	getEmailRecord(env, mailboxId, draftId)
		.andThen((email) => requirePresent(email, () => new DraftNotFoundError(draftId)))
		.andThen((email) => (email.folder_id === Folders.DRAFT ? ok(email) : err(new NotADraftError(draftId))))
		.andThen(() => callMailbox(env, mailboxId, "deleteEmail", (stub) => stub.deleteEmail(draftId)))
		.map(() => ({ status: "discarded" as const, draftId }));

// ── delete_email ───────────────────────────────────────────────────

export const toolDeleteEmail = (env: Env, mailboxId: string, emailId: string) =>
	callMailbox(env, mailboxId, "deleteEmail", (stub) => stub.deleteEmail(emailId)).andThen((deleted) =>
		deleted === null ? err(new EmailNotFoundError(emailId)) : ok({ status: "deleted" as const, emailId }),
	);

// ── send helpers ───────────────────────────────────────────────────

type SentMessage = { status: "sent"; messageId: string; message: string };

type SentRecord = {
	messageId: string;
	subject: string;
	to: string;
	bodyHtml: string;
	inReplyTo: string | null;
	references: string | null;
	threadId: string;
};

const validateAttachments = (
	inputs: OutgoingAttachmentInput[] | undefined,
): Result<OutgoingAttachment[], AttachmentValidationError> => {
	const validated = validateOutgoingAttachments(inputs);
	if (!validated.ok) return err(new AttachmentValidationError(validated.error));
	return ok(validated.attachments);
};

const checkSendRateLimit = (
	env: Env,
	mailboxId: string,
): ResultAsync<void, RateLimitedError | MailboxOperationError> =>
	callMailbox(env, mailboxId, "checkSendRateLimit", (stub) =>
		(stub as unknown as RateLimitStub).checkSendRateLimit(),
	).andThen((limited) => (limited ? err(new RateLimitedError(limited)) : ok(undefined)));

const mailboxDomain = (mailboxId: string): Result<string, InvalidMailboxAddressError> =>
	requirePresent(mailboxId.split("@")[1] || null, () => new InvalidMailboxAddressError(mailboxId));

/**
 * Send and report the delivered Message-ID. The Sent copy must store that ID
 * (not a self-generated one) or replies to it cannot be threaded.
 */
const deliver = (
	env: Env,
	kind: SendFailedError["kind"],
	params: SendEmailParams,
): ResultAsync<string, SendFailedError> =>
	ResultAsync.fromThrowable(
		async () => (await sendEmail(env.EMAIL, params)).messageId,
		(cause) => new SendFailedError(kind, { cause }),
	)().orTee((e) => console.error("Email send failed:", e.message));

const storeSentCopy = (
	env: Env,
	mailboxId: string,
	attachments: OutgoingAttachment[],
	record: SentRecord,
	deliveredMessageId: string,
): ResultAsync<void, MailboxOperationError> =>
	attemptMailboxOperation("storeAttachments", () =>
		storeAttachments(env.BUCKET, record.messageId, attachments),
	).andThen((attachmentData) =>
		callMailbox(env, mailboxId, "createEmail", (stub) =>
			stub.createEmail(
				Folders.SENT,
				{
					id: record.messageId,
					subject: record.subject,
					sender: mailboxId.toLowerCase(),
					recipient: record.to.toLowerCase(),
					date: new Date().toISOString(),
					body_html: record.bodyHtml,
					body_text: null,
					in_reply_to: record.inReplyTo,
					email_references: record.references,
					thread_id: record.threadId,
					message_id: deliveredMessageId,
				},
				attachmentData,
			),
		),
	);

type Outgoing = {
	kind: SendFailedError["kind"];
	record: SentRecord;
	attachments: OutgoingAttachment[];
	headers?: Record<string, string>;
};

const sendAndStore = (
	env: Env,
	mailboxId: string,
	{ kind, record, attachments, headers }: Outgoing,
): ResultAsync<SentMessage, SendFailedError | MailboxOperationError> =>
	deliver(env, kind, {
		to: record.to,
		from: mailboxId,
		subject: record.subject,
		html: record.bodyHtml,
		attachments,
		headers,
	})
		.andThen((delivered) => storeSentCopy(env, mailboxId, attachments, record, delivered))
		.map(() => ({
			status: "sent" as const,
			messageId: record.messageId,
			message: `${kind === "reply" ? "Reply" : "Email"} sent to ${record.to}`,
		}));

// ── send_reply ─────────────────────────────────────────────────────

type ReplyParams = {
	originalEmailId: string;
	to: string;
	subject: string;
	bodyHtml: string;
	attachments?: OutgoingAttachmentInput[];
};

// The caller's body is sent verbatim; only the quoted original is appended.
const buildReply = (
	mailboxId: string,
	params: ReplyParams,
	original: EmailFull,
): Result<{ record: SentRecord; headers: Record<string, string> }, InvalidMailboxAddressError> =>
	mailboxDomain(mailboxId).map((fromDomain) => {
		const { originalMsgId, references, threadId } = buildReferencesChain(original);
		return {
			record: {
				messageId: generateMessageId(fromDomain).messageId,
				subject: params.subject,
				to: params.to,
				bodyHtml: params.bodyHtml + quoteOriginal(original, params.to),
				inReplyTo: originalMsgId,
				references: references.length > 0 ? JSON.stringify(references) : null,
				threadId,
			},
			headers: buildThreadingHeaders(originalMsgId, references),
		};
	});

export const toolSendReply = (
	env: Env,
	mailboxId: string,
	params: ReplyParams,
): ResultAsync<
	SentMessage,
	| AttachmentValidationError
	| RateLimitedError
	| OriginalEmailNotFoundError
	| InvalidMailboxAddressError
	| SendFailedError
	| MailboxOperationError
> =>
	validateAttachments(params.attachments)
		.asyncAndThen((attachments) => checkSendRateLimit(env, mailboxId).map(() => attachments))
		.andThen((attachments) =>
			getEmailRecord(env, mailboxId, params.originalEmailId)
				.andThen((original) =>
					requirePresent(original, () => new OriginalEmailNotFoundError(params.originalEmailId)),
				)
				.andThen((original) => buildReply(mailboxId, params, original))
				.map((reply) => ({ ...reply, attachments, kind: "reply" as const })),
		)
		.andThen((outgoing) => sendAndStore(env, mailboxId, outgoing));

// ── send_email ─────────────────────────────────────────────────────

type NewEmailParams = {
	to: string;
	subject: string;
	bodyHtml: string;
	attachments?: OutgoingAttachmentInput[];
};

const buildNewEmail = (mailboxId: string, params: NewEmailParams): Result<SentRecord, InvalidMailboxAddressError> =>
	mailboxDomain(mailboxId).map((fromDomain) => {
		const { messageId } = generateMessageId(fromDomain);
		return {
			messageId,
			subject: params.subject,
			to: params.to,
			bodyHtml: params.bodyHtml,
			inReplyTo: null,
			references: null,
			threadId: messageId,
		};
	});

export const toolSendEmail = (
	env: Env,
	mailboxId: string,
	params: NewEmailParams,
): ResultAsync<
	SentMessage,
	AttachmentValidationError | RateLimitedError | InvalidMailboxAddressError | SendFailedError | MailboxOperationError
> =>
	validateAttachments(params.attachments)
		.asyncAndThen((attachments) => checkSendRateLimit(env, mailboxId).map(() => attachments))
		.andThen((attachments) =>
			buildNewEmail(mailboxId, params).map((record) => ({ record, attachments, kind: "email" as const })),
		)
		.andThen((outgoing) => sendAndStore(env, mailboxId, outgoing));
