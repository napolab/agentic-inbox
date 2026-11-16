// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Time-window thresholds for queries over the `emails.date` column.
 *
 * `date` is written with `new Date().toISOString()` -- "2026-08-17T00:05:00.000Z" --
 * whereas `datetime('now', ...)` returns "2026-08-17 11:11:19". SQLite has no date
 * type and compares the two as TEXT, where 'T'(0x54) > ' '(0x20). Every row sharing
 * the date part therefore passed a `date >= datetime('now', '-1 hour')` filter no
 * matter its time, silently widening every window to whole calendar days.
 *
 * So thresholds are computed in JS and bound as ISO strings: ISO compares against
 * ISO, and lexicographic order matches chronological order for a fixed format.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Start of a window ending at `now`, in the same format as the stored `date`. */
export const isoSince = (now: number, windowMs: number): string =>
	new Date(now - windowMs).toISOString();

export type SendRateLimit = {
	readonly windowMs: number;
	readonly max: number;
	readonly message: string;
};

/** Checked in order, so the narrowest window reports first. */
export const SEND_RATE_LIMITS: readonly SendRateLimit[] = [
	{ windowMs: HOUR_MS, max: 20, message: "Rate limit exceeded: max 20 emails per hour per mailbox" },
	{ windowMs: DAY_MS, max: 100, message: "Rate limit exceeded: max 100 emails per day per mailbox" },
];

/** `?1` = folder id, `?2` = window start (ISO). */
export const SENT_SINCE_COUNT_SQL = `SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= ?2`;

/** How far back `findThreadBySubject` scans for a matching thread. */
export const THREAD_LOOKBACK_MS = 7 * DAY_MS;
