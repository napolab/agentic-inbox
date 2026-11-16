/**
 * Helpers for converting a plain-text email body to display HTML.
 *
 * Emails now store `body_html` and `body_text` as separate MIME parts
 * (classified at ingestion, or once in DB migration 9 for legacy rows).
 * Display code picks `body_html` when present and otherwise falls back to
 * `plainTextToHtml(body_text)` — no runtime format detection is needed here.
 */

const escapePlainText = (text: string): string => {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
};

// Capturing group so String.split interleaves [text, url, text, url, ...].
// Only http/https — never linkify javascript: or other schemes.
// Quote characters terminate the match so a shell-style `curl "<url>"` does not
// pull the closing quote into the href.
const URL_SPLIT_PATTERN = /(https?:\/\/[^\s<>"']+)/;

const countChar = (s: string, ch: string): number => s.split(ch).length - 1;

/**
 * Trim sentence punctuation that trails a pasted URL without being part of it.
 * Closing brackets are only trimmed when unbalanced, so wiki-style URLs such as
 * `https://en.wikipedia.org/wiki/Foo_(bar)` keep their trailing `)`.
 */
const trimTrailing = (url: string): string => {
	if (/[.,;:!?]$/.test(url)) return trimTrailing(url.slice(0, -1));
	if (url.endsWith(")") && countChar(url, "(") < countChar(url, ")")) {
		return trimTrailing(url.slice(0, -1));
	}
	if (url.endsWith("]") && countChar(url, "[") < countChar(url, "]")) {
		return trimTrailing(url.slice(0, -1));
	}
	return url;
};

const renderAnchor = (url: string): string => {
	const href = trimTrailing(url);
	const trailing = escapePlainText(url.slice(href.length));
	const escapedHref = escapePlainText(href);
	return `<a href="${escapedHref}" target="_blank" rel="noopener noreferrer">${escapedHref}</a>${trailing}`;
};

/**
 * Convert a plain-text email body to HTML that preserves line breaks and
 * literal angle-bracket content (e.g. `<john@example.com>`), while turning
 * http(s) URLs into clickable links. Newlines are kept as-is and rendered
 * by `white-space:pre-wrap`.
 */
export const plainTextToHtml = (text: string): string => {
	const parts = text
		.split(URL_SPLIT_PATTERN)
		.map((part, index) => (index % 2 === 1 ? renderAnchor(part) : escapePlainText(part)));
	return `<div style="white-space:pre-wrap">${parts.join("")}</div>`;
};