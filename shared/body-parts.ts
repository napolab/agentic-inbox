// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Canonical plain-text derivation for the two MIME body columns.
 *
 * One implementation shared by the worker (LLM/MCP consumers, quoting) and
 * the app (compose quoting/forwarding) so the text handed to the model can
 * never disagree with the text the user sees.
 */

/** The two MIME parts of an email body; either may be null/absent. */
export type BodyParts = {
	body_html?: string | null;
	body_text?: string | null;
};

/**
 * Strip HTML tags and normalize whitespace to produce plain text.
 * Removes <style> and <script> blocks first to avoid injecting their
 * content into the output.
 */
export const stripHtmlToText = (html: string): string => {
	if (!html) return "";
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
};

/**
 * Plain-text rendering of an email for LLM/MCP consumers and quoting.
 *
 * The HTML part wins when present, matching the display preference: real
 * multipart mail frequently carries a degenerate text/plain stub ("This
 * message requires an HTML-capable client…"), and preferring it would hand
 * the model — and quoted replies — something the user never saw. Stripping
 * the HTML is lossy (whitespace collapses) but always the real message.
 */
export const deriveBodyText = (parts: BodyParts): string => {
	if (parts.body_html != null && parts.body_html !== "") {
		return stripHtmlToText(parts.body_html);
	}
	return parts.body_text ?? "";
};
