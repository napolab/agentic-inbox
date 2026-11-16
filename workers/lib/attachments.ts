// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";
import { MAX_TOTAL_ATTACHMENT_BYTES } from "../../shared/attachments";

/**
 * Decode standard base64 into raw bytes. Every caller that hands attachment
 * content onward (R2 storage, the send_email binding) needs bytes, not the
 * base64 text itself.
 */
export const base64ToBytes = (base64: string): Uint8Array =>
	Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		// Sanitize filename to prevent path traversal in R2 keys
		const safeFilename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
		const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
		const bytes = base64ToBytes(att.content);
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		});
	}
	return results;
}

/** Attachment as supplied by an MCP caller: base64 content plus metadata. */
export type OutgoingAttachmentInput = {
	filename: string;
	content: string;
	type?: string;
};

/** Attachment ready for both `sendEmail` and `storeAttachments`. */
export type OutgoingAttachment = {
	filename: string;
	content: string;
	type: string;
	disposition: "attachment";
};

export type OutgoingAttachmentsResult =
	| { ok: true; attachments: OutgoingAttachment[] }
	| { ok: false; error: string };

// A flat character class with the length check done separately: a grouped
// `(?:[..]{4})*` pattern overflows the regex stack on multi-MB input.
const BASE64_CHARSET_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL_PATTERN = /^data:[^,]*;base64,/i;
const WHITESPACE_PATTERN = /\s+/g;

const decodedByteLength = (base64: string): number => {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return (base64.length / 4) * 3 - padding;
};

const formatMB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

type SingleAttachmentResult =
	| { ok: true; attachment: OutgoingAttachment; bytes: number }
	| { ok: false; error: string };

const validateOne = (input: OutgoingAttachmentInput, index: number): SingleAttachmentResult => {
	const label = `attachments[${index}]${input.filename ? ` ("${input.filename}")` : ""}`;
	if (input.filename.trim() === "") {
		return { ok: false, error: `${label}: filename is empty. Provide a filename with an extension, e.g. "report.pdf".` };
	}
	if (DATA_URL_PATTERN.test(input.content)) {
		return {
			ok: false,
			error: `${label}: content is a data: URL. Pass only the base64 payload after "base64," and put the MIME type in "type".`,
		};
	}
	// Line-wrapped base64 (e.g. MIME 76-column output) is the same bytes; only the wrapping is dropped.
	const content = input.content.replace(WHITESPACE_PATTERN, "");
	if (content === "") {
		return { ok: false, error: `${label}: content is empty. Provide the file bytes as standard base64.` };
	}
	if (!BASE64_CHARSET_PATTERN.test(content) || content.length % 4 !== 0) {
		return {
			ok: false,
			error: `${label}: content is not valid standard base64 (A-Z a-z 0-9 + /, "=" padding, length a multiple of 4). base64url ("-" / "_") and unpadded input are not accepted.`,
		};
	}
	return {
		ok: true,
		bytes: decodedByteLength(content),
		attachment: {
			filename: input.filename,
			content,
			type: input.type?.trim() || "application/octet-stream",
			disposition: "attachment",
		},
	};
};

/**
 * Validate MCP-supplied attachments before anything is sent or stored.
 * Invalid input is rejected with a message the caller can act on — never
 * silently dropped — so a send never goes out missing a file.
 */
export const validateOutgoingAttachments = (
	inputs: OutgoingAttachmentInput[] | undefined,
): OutgoingAttachmentsResult => {
	if (!inputs?.length) return { ok: true, attachments: [] };

	const results = inputs.map(validateOne);
	const firstError = results.find((r) => !r.ok);
	if (firstError && !firstError.ok) return { ok: false, error: firstError.error };

	const valid = results.flatMap((r) => (r.ok ? [r] : []));
	const totalBytes = valid.reduce((sum, r) => sum + r.bytes, 0);
	if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
		const sizes = valid.map((r) => `${r.attachment.filename} ${formatMB(r.bytes)}`).join(", ");
		return {
			ok: false,
			error: `Attachments total ${formatMB(totalBytes)}, over the ${formatMB(MAX_TOTAL_ATTACHMENT_BYTES)} limit (${sizes}). Remove or shrink files, or send them across multiple emails.`,
		};
	}
	return { ok: true, attachments: valid.map((r) => r.attachment) };
};
