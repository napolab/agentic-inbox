// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatBytes,
	formatComposeDate,
	getSignatureBlock,
	htmlToPlainText,
	splitEmailList,
	toEmailListValue,
} from "~/lib/utils";
import { deriveBodyText } from "shared/body-parts";
import { addFilesWithinLimit, filesToSendAttachments, type SendAttachment } from "~/lib/compose-attachments";
import { unpackFileList } from "~/lib/filelist";
import { fromNullable } from "~/lib/option";
import { useFileList } from "~/hooks/useFileList";
import { useDeleteEmail, useForwardEmail, useReplyToEmail, useSaveDraft, useSendEmail } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { type ComposeMode, useUIStore } from "~/hooks/useUIStore";

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = trimmed.toLowerCase();
	if (normalized === exclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(deriveBodyText(original)).replace(/\n/g, "<br>");

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?: string,
) {
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();
	appendUniqueAddress(toRecipients, toSeen, original.sender, selfAddress);

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = recipient.toLowerCase();
		if (
			normalized === selfAddress ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: ccRecipients.length > 0,
	};
}

/**
 * Editor HTML for a stored draft.
 *
 * A text-only email can legitimately live in Drafts (moved there by the user),
 * so fall back to the text part converted to minimal editor markup. This is
 * deliberately not `plainTextToHtml` — its pre-wrap/link wrapper would be
 * re-saved as editor content on the next save.
 */
function draftEditorHtml(draft: { body_html?: string | null; body_text?: string | null }) {
	if (draft.body_html != null && draft.body_html !== "") return draft.body_html;
	if (draft.body_text == null || draft.body_text === "") return "";
	return escapeHtml(draft.body_text).replace(/\n/g, "<br>");
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	mailboxEmail: string | undefined,
	sigBlock: string,
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draftEditorHtml(draft),
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			body: sigBlock ? `<p><br></p>${sigBlock}` : "",
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, deriveBodyText(original))}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail?.toLowerCase());
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, deriveBodyText(original))}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

// What the compose form actually submits — mirrors the server's
// SendEmailRequestSchema minus threading fields (added by reply/forward
// routes server-side).
type SendEmailPayload = {
	to: string | string[];
	cc: string | string[] | undefined;
	bcc: string | string[] | undefined;
	from: string | { email: string; name: string };
	subject: string;
	html: string;
	text: string;
	attachments?: SendAttachment[];
};

// The endpoint-level send decision: threaded variants carry the id they
// thread onto, so a reply/forward without an emailId is unrepresentable.
type SendAction =
	| { kind: "new" }
	| { kind: "reply"; emailId: string }
	| { kind: "forward"; emailId: string };

function resolveSendAction(mode: ComposeMode, emailId: string): SendAction {
	switch (mode) {
		case "reply":
		case "reply-all":
			return { kind: "reply", emailId };
		case "forward":
			return { kind: "forward", emailId };
		case "new":
			return { kind: "new" };
		default: {
			const _exhaustive: never = mode;
			throw new Error(`unhandled compose mode: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

interface DispatchSendParams {
	action: SendAction;
	mailboxId: string;
	email: SendEmailPayload;
	// Mutation results are awaited for completion only; their data is unused.
	send: (vars: { mailboxId: string; email: SendEmailPayload }) => Promise<unknown>;
	reply: (vars: { mailboxId: string; emailId: string; email: SendEmailPayload }) => Promise<unknown>;
	forward: (vars: { mailboxId: string; emailId: string; email: SendEmailPayload }) => Promise<unknown>;
}

async function dispatchSend({ action, mailboxId, email, send, reply, forward }: DispatchSendParams): Promise<void> {
	switch (action.kind) {
		case "new": {
			await send({ mailboxId, email });
			return;
		}
		case "reply": {
			await reply({ mailboxId, emailId: action.emailId, email });
			return;
		}
		case "forward": {
			await forward({ mailboxId, emailId: action.emailId, email });
			return;
		}
		default: {
			const _exhaustive: never = action;
			throw new Error(`unhandled send action: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

export function useComposeForm(mailboxId?: string, _folder?: string) {
	const toastManager = useKumoToastManager();
	const { composeOptions, closePanel, closeCompose } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const sendEmailMutation = useSendEmail();
	const saveDraftMutation = useSaveDraft();
	const replyMutation = useReplyToEmail();
	const forwardMutation = useForwardEmail();
	const deleteEmailMutation = useDeleteEmail();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	// Picks accumulate into the accepted selection, capped by total size;
	// an oversized pick keeps the previous selection and reports the error.
	const mergeAttachmentPicks = useCallback((accepted: File[], picked: File[]): File[] => {
		const result = addFilesWithinLimit(accepted, picked);
		switch (result.outcome) {
			case "too_large": {
				setError(`Attachments exceed the ${formatBytes(result.limitBytes)} total limit.`);
				return accepted;
			}
			case "ok": {
				setError(null);
				return result.files;
			}
			default: {
				const _exhaustive: never = result;
				throw new Error(`unhandled add-files outcome: ${JSON.stringify(_exhaustive)}`);
			}
		}
	}, []);
	const attachmentInput = useFileList(mergeAttachmentPicks);
	const attachmentFiles = useMemo(
		() => unpackFileList(attachmentInput.files),
		[attachmentInput.files],
	);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	const isDraftEdit = !!composeOptions.draftEmail;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit Draft";
		switch (composeOptions.mode) { case "reply": return "Reply"; case "reply-all": return "Reply All"; case "forward": return "Forward"; default: return "New Message"; }
	}, [composeOptions.mode, isDraftEdit]);

	const sigBlock = useMemo(() => getSignatureBlock(currentMailbox?.settings), [currentMailbox]);

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		lastInitializedOptionsRef.current = composeOptions;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setError(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);
		// no_bind (compose UI not mounted) is fine: a freshly mounted input is empty.
		attachmentInput.clear();
	}, [composeOptions, currentMailbox?.email, sigBlock, attachmentInput]);

	const removeAttachment = useCallback(
		(file: File) => {
			attachmentInput.remove(file);
		},
		[attachmentInput],
	);

	const handleSaveDraft = async () => {
		if (!mailboxId || isSending) return; setIsSavingDraft(true); setError(null);
		try {
			await saveDraftMutation.mutateAsync({ mailboxId, draft: {
				to,
				cc: cc || undefined,
				bcc: bcc || undefined,
				subject,
				body,
				in_reply_to: composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to || undefined,
				thread_id: composeOptions.originalEmail?.thread_id || composeOptions.draftEmail?.thread_id || undefined,
				draft_id: composeOptions.draftEmail?.id || undefined,
			} });
			toastManager.add({ title: "Draft saved!" });
		}
		catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save draft.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		}
		finally { setIsSavingDraft(false); }
	};

	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault(); if (isSending) return; setError(null);
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		const toValue = toEmailListValue(splitEmailList(to));
		if (toValue === undefined) { setError("Add at least one recipient."); return; }
		const ccRecipients = splitEmailList(cc); const bccRecipients = splitEmailList(bcc);
		const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
		const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
		const emailData = {
			to: toValue,
			cc: toEmailListValue(ccRecipients),
			bcc: toEmailListValue(bccRecipients),
			from,
			subject,
			html: body,
			text: htmlToPlainText(body),
		} satisfies SendEmailPayload;
		const draftId = composeOptions.draftEmail?.id; const mode = composeOptions.mode; const originalId = fromNullable(composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to);
		// The Option is resolved here at the usage site: no original message
		// to thread onto means every mode degrades to a plain send.
		const sendAction: SendAction = originalId.type === "some"
			? resolveSendAction(mode, originalId.value)
			: { kind: "new" };
		setIsSending(true); toastManager.add({ title: "Sending email..." });
		try {
			const payload: SendEmailPayload = attachmentFiles.length > 0
				? { ...emailData, attachments: await filesToSendAttachments(attachmentFiles) }
				: emailData;
			await dispatchSend({
				action: sendAction,
				mailboxId,
				email: payload,
				send: sendEmailMutation.mutateAsync,
				reply: replyMutation.mutateAsync,
				forward: forwardMutation.mutateAsync,
			});
			if (draftId) deleteEmailMutation.mutate({ mailboxId, id: draftId });
			toastManager.add({ title: "Email sent!" });
			onClose();
		} catch (err: unknown) { const message = (err instanceof Error ? err.message : null) || "Failed to send email."; setError(message); toastManager.add({ title: message, variant: "error" }); }
		finally { setIsSending(false); }
	};

	return { to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc, subject, setSubject, body, setBody, attachmentFiles, bindAttachmentInput: attachmentInput.bindRef, removeAttachment, error, setError, isSavingDraft, isSending, formTitle, handleSaveDraft, handleSend, closeCompose, closePanel };
}
