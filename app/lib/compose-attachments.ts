/**
 * Pure helpers for attaching files in the compose UI.
 *
 * The send API (SendEmailRequestSchema) takes base64-encoded attachment
 * content inline, so files are encoded client-side at send time.
 */

import { MAX_TOTAL_ATTACHMENT_BYTES } from "../../shared/attachments";

export type SendAttachment = {
	content: string; // base64 encoded
	filename: string;
	type: string;
	disposition: "attachment";
};

export type AddFilesResult =
	| { outcome: "ok"; files: File[] }
	| { outcome: "too_large"; attemptedBytes: number; limitBytes: number };

export function addFilesWithinLimit(current: File[], incoming: File[]): AddFilesResult {
	const files = [...current, ...incoming];
	const attemptedBytes = files.reduce((sum, file) => sum + file.size, 0);
	if (attemptedBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
		return { outcome: "too_large", attemptedBytes, limitBytes: MAX_TOTAL_ATTACHMENT_BYTES };
	}
	return { outcome: "ok", files };
}

export function bytesToBase64(bytes: Uint8Array): string {
	// Chunked to stay under the argument-count limit of String.fromCharCode.
	const CHUNK_SIZE = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
	}
	return btoa(binary);
}

async function fileToSendAttachment(file: File): Promise<SendAttachment> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	return {
		content: bytesToBase64(bytes),
		filename: file.name,
		type: file.type === "" ? "application/octet-stream" : file.type,
		disposition: "attachment",
	};
}

export async function filesToSendAttachments(files: File[]): Promise<SendAttachment[]> {
	return Promise.all(files.map(fileToSendAttachment));
}
