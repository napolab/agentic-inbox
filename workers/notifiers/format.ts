// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Origin the inbox UI is served from — see the `routes` entry in wrangler.jsonc.
 * Not a secret, so it stays a constant rather than a binding. Change it to your
 * own custom domain before deploying.
 */
const APP_ORIGIN = "https://inbox.example.com";

/**
 * Clamp to `limit` UTF-16 code units. Splitting is done over code points rather
 * than with `slice`, so an emoji straddling the cut never leaves a lone
 * surrogate behind — Discord rejects ill-formed strings.
 */
export const truncate = (text: string, limit: number): string => {
	if (text.length <= limit) return text;
	const kept = [...text].reduce(
		(acc, char) => (acc.length + char.length > limit - 1 ? acc : acc + char),
		"",
	);
	return `${kept}…`;
};

export const mailboxURL = (mailboxId: string): string =>
	`${APP_ORIGIN}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`;

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : `${error}`;
