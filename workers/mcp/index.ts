// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { err, ok, type ResultAsync } from "neverthrow";
import { z } from "zod";
import {
	toolListMailboxes,
	toolListEmails,
	toolListAllInboxEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendReply,
	toolSendEmail,
	toolMarkEmailRead,
	toolMoveEmail,
	attemptMailboxOperation,
} from "../lib/tools";
import { MailboxNotFoundError, type MailboxOperationError, type ToolError } from "../lib/tool-errors";
import { logToolErrorCause, toToolErrorBody } from "../lib/tool-error-body";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import type { Env } from "../types";

const attachmentsParam = z
	.array(
		z.object({
			filename: z
				.string()
				.describe("File name shown to the recipient, with extension (e.g. report.pdf)"),
			content: z
				.string()
				.describe("File bytes as standard base64 (not a data: URL, not base64url)"),
			type: z
				.string()
				.optional()
				.describe("MIME type (e.g. application/pdf). Defaults to application/octet-stream"),
		}),
	)
	.optional()
	.describe("Files to attach. Total decoded size must be 18MB or less.");

const mcpText = (result: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
});

const mcpError = (error: ToolError) => {
	logToolErrorCause(error);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(toToolErrorBody(error), null, 2) }],
		isError: true as const,
	};
};

/**
 * EmailMCP — exposes email tools over the Model Context Protocol.
 *
 * Clients (ProtoAgent, Claude Code, Cursor, etc.) connect to the
 * `/mcp` endpoint and can list mailboxes, read/search emails,
 * draft replies, send messages, and manage folders.
 */
export class EmailMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "agentic-inbox",
		version: "1.0.0",
	});

	async init() {
		const env = this.env;

		const verifyMailbox = (mailboxId: string): ResultAsync<void, MailboxNotFoundError | MailboxOperationError> =>
			attemptMailboxOperation("verifyMailbox", () => env.BUCKET.head(`mailboxes/${mailboxId}.json`)).andThen(
				(obj) => (obj ? ok(undefined) : err(new MailboxNotFoundError(mailboxId))),
			);

		// ── list_mailboxes ─────────────────────────────────────────
		this.server.tool(
			"list_mailboxes",
			"List all available mailboxes",
			{},
			() => toolListMailboxes(env).match(mcpText, mcpError),
		);

		// ── list_emails ────────────────────────────────────────────
		this.server.tool(
			"list_emails",
			"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
			{
				mailboxId: z
					.string()
					.describe("The mailbox email address (e.g. user@example.com)"),
				folder: z
					.string()
					.default(Folders.INBOX)
					.describe(FOLDER_TOOL_DESCRIPTION),
				limit: z
					.number()
					.default(20)
					.describe("Maximum number of emails to return"),
				page: z
					.number()
					.default(1)
					.describe("Page number for pagination"),
			},
			({ mailboxId, folder, limit, page }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolListEmails(env, mailboxId, { folder, limit, page }))
					.match(mcpText, mcpError),
		);

		// ── list_all_inbox_emails ──────────────────────────────────
		this.server.tool(
			"list_all_inbox_emails",
			"List received emails across ALL mailboxes' inboxes, newest first, each tagged with its mailboxId. Optionally filter with query (matches subject, body, sender, recipients), from, or unread. Paginate by passing nextCursor back as cursor until it is null.",
			{
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.default(20)
					.describe("Maximum number of emails to return (1-50)"),
				cursor: z
					.string()
					.optional()
					.describe("nextCursor from the previous response; omit to start from the newest email"),
				query: z
					.string()
					.optional()
					.describe("Free-text search over subject, body, sender and recipients"),
				from: z
					.string()
					.optional()
					.describe("Only emails whose sender contains this text"),
				unread: z
					.boolean()
					.optional()
					.describe("If true, only unread emails"),
			},
			(params) => toolListAllInboxEmails(env, params).match(mcpText, mcpError),
		);

		// ── get_email ──────────────────────────────────────────────
		this.server.tool(
			"get_email",
			"Get a single email with its full body content. Use this to read the actual content of an email.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to retrieve"),
			},
			({ mailboxId, emailId }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolGetEmail(env, mailboxId, emailId))
					.match(mcpText, mcpError),
		);

		// ── get_thread ─────────────────────────────────────────────
		this.server.tool(
			"get_thread",
			"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				threadId: z
					.string()
					.describe("The thread_id to retrieve all messages for"),
			},
			({ mailboxId, threadId }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolGetThread(env, mailboxId, threadId))
					.match(mcpText, mcpError),
		);

		// ── search_emails ──────────────────────────────────────────
		this.server.tool(
			"search_emails",
			"Search for emails matching a query across subject and body fields.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				query: z.string().describe("Search query to match against subject and body"),
				folder: z
					.string()
					.optional()
					.describe("Optional folder to restrict search to"),
			},
			({ mailboxId, query, folder }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolSearchEmails(env, mailboxId, { query, folder }))
					.match(mcpText, mcpError),
		);

		// ── draft_reply ────────────────────────────────────────────
		this.server.tool(
			"draft_reply",
			"Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line (usually 'Re: ...')"),
				bodyHtml: z
					.string()
					.describe("The HTML body of the reply"),
			},
			({ mailboxId, originalEmailId, to, subject, bodyHtml }) =>
				verifyMailbox(mailboxId)
					.andThen(() =>
						toolDraftReply(env, mailboxId, {
							originalEmailId,
							to,
							subject,
							body: bodyHtml,
							isPlainText: false,
						}),
					)
					.match(mcpText, mcpError),
		);

		// ── create_draft ───────────────────────────────────────────
		this.server.tool(
			"create_draft",
			"Create a new draft email. Can be a new email or a reply draft.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				to: z
					.string()
					.optional()
					.describe("Recipient email address (optional for early drafts)"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the draft"),
				in_reply_to: z
					.string()
					.optional()
					.describe("The ID of the email this draft is replying to (optional)"),
				thread_id: z
					.string()
					.optional()
					.describe("Thread ID to attach this draft to (optional)"),
			},
			({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) =>
				verifyMailbox(mailboxId)
					.andThen(() =>
						toolDraftEmail(env, mailboxId, {
							to: to || "",
							subject,
							body: bodyHtml,
							isPlainText: false,
							in_reply_to,
							thread_id,
						}),
					)
					.map((draft) => ({
						status: "draft_created",
						draftId: draft.draftId,
						threadId: draft.threadId,
						message: "Draft created in Drafts folder.",
					}))
					.match(mcpText, mcpError),
		);

		// ── update_draft ───────────────────────────────────────────
		this.server.tool(
			"update_draft",
			"Update an existing draft email's content.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				draftId: z.string().describe("The ID of the draft to update"),
				to: z
					.string()
					.optional()
					.describe("Updated recipient email address"),
				subject: z.string().optional().describe("Updated subject line"),
				bodyHtml: z.string().optional().describe("Updated HTML body"),
			},
			({ mailboxId, draftId, to, subject, bodyHtml }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolUpdateDraft(env, mailboxId, { draftId, to, subject, bodyHtml }))
					.match(mcpText, mcpError),
		);

		// ── delete_email ───────────────────────────────────────────
		this.server.tool(
			"delete_email",
			"Permanently delete an email by ID.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to delete"),
			},
			({ mailboxId, emailId }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolDeleteEmail(env, mailboxId, emailId))
					.match(mcpText, mcpError),
		);

		// ── send_reply ─────────────────────────────────────────────
		this.server.tool(
			"send_reply",
			"Send a reply to an email. Only call after drafting and getting confirmation.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the reply"),
				attachments: attachmentsParam,
			},
			({ mailboxId, originalEmailId, to, subject, bodyHtml, attachments }) =>
				verifyMailbox(mailboxId)
					.andThen(() =>
						toolSendReply(env, mailboxId, { originalEmailId, to, subject, bodyHtml, attachments }),
					)
					.match(mcpText, mcpError),
		);

		// ── send_email ─────────────────────────────────────────────
		this.server.tool(
			"send_email",
			"Send a new email (not a reply). Only call after getting confirmation.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the email"),
				attachments: attachmentsParam,
			},
			({ mailboxId, to, subject, bodyHtml, attachments }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolSendEmail(env, mailboxId, { to, subject, bodyHtml, attachments }))
					.match(mcpText, mcpError),
		);

		// ── mark_email_read ────────────────────────────────────────
		this.server.tool(
			"mark_email_read",
			"Mark an email as read or unread.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				read: z.boolean().describe("true to mark as read, false for unread"),
			},
			({ mailboxId, emailId, read }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolMarkEmailRead(env, mailboxId, emailId, read))
					.match(mcpText, mcpError),
		);

		// ── move_email ─────────────────────────────────────────────
		this.server.tool(
			"move_email",
			"Move an email to a different folder (inbox, sent, draft, archive, trash).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				folderId: z
					.string()
					.describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			},
			({ mailboxId, emailId, folderId }) =>
				verifyMailbox(mailboxId)
					.andThen(() => toolMoveEmail(env, mailboxId, emailId, folderId))
					.match(mcpText, mcpError),
		);
	}
}
