/**
 * Cross-mailbox inbox listing.
 *
 * Every mailbox lives in its own Durable Object, each paginating
 * independently, so a global "page N" has no per-mailbox offset. Instead we
 * page with a cursor: the last entry returned, in the total order
 * (date DESC, mailboxId ASC, id ASC). Each mailbox is asked for exactly the
 * rows strictly after the cursor via a per-mailbox `after` predicate
 * (searchAfterFor / buildAfterCondition), ordered date DESC, id ASC by the DO.
 * So no already-seen row is ever re-fetched, however many share a timestamp,
 * and ties on date neither repeat nor vanish. The cursor filter in
 * mergeMailboxPages is only a defensive second line.
 */

/**
 * Position filter understood by the mailbox DO's searchEmails.
 * - include: date <= d
 * - exclude: date < d
 * - after-id: date < d OR (date = d AND id > id)
 */
export type SearchAfter =
	| { date: string; ties: "include" }
	| { date: string; ties: "exclude" }
	| { date: string; ties: "after-id"; id: string };

export type MailboxEmail = {
	id: string;
	date: string;
	[key: string]: unknown;
};

export type InboxEntry = MailboxEmail & { mailboxId: string };

export type InboxCursor = { date: string; mailboxId: string; id: string };

export type MailboxPage = {
	mailboxId: string;
	/** Raw rows from the DO, already in date DESC order. */
	emails: MailboxEmail[];
	/** True when the DO returned fewer rows than requested. */
	exhausted: boolean;
};

export type MailboxFailure = { mailboxId: string; error: string };

export const INVALID_CURSOR_MESSAGE =
	"Invalid cursor. Pass the nextCursor value from a previous list_all_inbox_emails response verbatim, or omit it to start from the newest email.";

/** Total order: newest first, then mailboxId, then id — ties never collide. */
export function compareEntries(a: InboxCursor, b: InboxCursor): number {
	if (a.date !== b.date) return a.date > b.date ? -1 : 1;
	if (a.mailboxId !== b.mailboxId) return a.mailboxId < b.mailboxId ? -1 : 1;
	if (a.id !== b.id) return a.id < b.id ? -1 : 1;
	return 0;
}

/**
 * The rows of `mailboxId` that sort strictly after `cursor` in the total order.
 * A mailbox sorting after the cursor's mailbox comes later for equal dates, so
 * its tied rows are included; an earlier one comes first, so they are excluded.
 */
export function searchAfterFor(cursor: InboxCursor, mailboxId: string): SearchAfter {
	if (mailboxId > cursor.mailboxId) return { date: cursor.date, ties: "include" };
	if (mailboxId === cursor.mailboxId) {
		return { date: cursor.date, ties: "after-id", id: cursor.id };
	}
	return { date: cursor.date, ties: "exclude" };
}

/**
 * SQL condition for a SearchAfter. `addParam` registers a bound value and
 * returns its placeholder; `prefix` is a column prefix such as "e.".
 */
export function buildAfterCondition(
	after: SearchAfter,
	prefix: string,
	addParam: (value: string) => string,
): string {
	switch (after.ties) {
		case "include":
			return `${prefix}date <= ${addParam(after.date)}`;
		case "exclude":
			return `${prefix}date < ${addParam(after.date)}`;
		case "after-id": {
			const date = addParam(after.date);
			const id = addParam(after.id);
			return `(${prefix}date < ${date} OR (${prefix}date = ${date} AND ${prefix}id > ${id}))`;
		}
	}
}

export function encodeCursor(entry: InboxCursor): string {
	const json = JSON.stringify([entry.date, entry.mailboxId, entry.id]);
	return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

/** Returns null for anything that isn't a cursor produced by encodeCursor. */
export function decodeCursor(cursor: string): InboxCursor | null {
	try {
		const bytes = Uint8Array.from(atob(cursor), (c) => c.charCodeAt(0));
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!Array.isArray(parsed) || parsed.length !== 3) return null;
		const [date, mailboxId, id]: unknown[] = parsed;
		if (typeof date !== "string") return null;
		if (typeof mailboxId !== "string") return null;
		if (typeof id !== "string") return null;
		return { date, mailboxId, id };
	} catch {
		// malformed base64 / JSON
	}
	return null;
}

/**
 * Merge per-mailbox pages into one globally ordered page.
 *
 * Only entries up to the earliest "last row" of any non-exhausted mailbox are
 * safe to return: that mailbox may hold unseen rows sorting before anything
 * past its last row.
 */
export function mergeMailboxPages(
	pages: MailboxPage[],
	limit: number,
	cursor?: InboxCursor,
): { emails: InboxEntry[]; nextCursor: string | null } {
	const tag = (page: MailboxPage): InboxEntry[] =>
		page.emails.map((email) => ({ ...email, mailboxId: page.mailboxId }));

	const boundary = pages
		.filter((page) => !page.exhausted)
		.map((page) => tag(page).at(-1))
		.filter((entry): entry is InboxEntry => entry !== undefined)
		.sort(compareEntries)[0];

	const candidates = pages
		.flatMap(tag)
		.filter((entry) => !cursor || compareEntries(entry, cursor) > 0)
		.sort(compareEntries);

	const safe = boundary
		? candidates.filter((entry) => compareEntries(entry, boundary) <= 0)
		: candidates;
	const emails = safe.slice(0, limit);

	const hasMore =
		candidates.length > emails.length || pages.some((page) => !page.exhausted);
	const last = emails.at(-1);
	return {
		emails,
		nextCursor: hasMore && last ? encodeCursor(last) : null,
	};
}

/**
 * Split the settled per-mailbox fetches into usable pages and failures.
 *
 * Policy: one Durable Object erroring out (e.g. a cold start timeout) does not
 * fail the whole call. Fulfilled mailboxes are returned as pages; rejected ones
 * are reported in `failures` (`settled[i]` corresponds to `mailboxIds[i]`),
 * with `error` being the reason's `.message` for an Error, else `${reason}`.
 * Callers must not advance pagination when `failures` is non-empty (see
 * withholdCursorOnFailure).
 */
export function collectMailboxResults(
	mailboxIds: string[],
	settled: PromiseSettledResult<MailboxPage>[],
): { pages: MailboxPage[]; failures: MailboxFailure[] } {
	const pages = settled.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	const failures = settled.flatMap((result, index): MailboxFailure[] => {
		if (result.status === "fulfilled") return [];
		const reason: unknown = result.reason;
		return [
			{
				mailboxId: mailboxIds[index] ?? "",
				error: reason instanceof Error ? reason.message : `${reason}`,
			},
		];
	});
	return { pages, failures };
}

export const PARTIAL_RESULTS_HINT =
	"Some mailboxes failed to respond, so these results are partial and nextCursor is withheld to avoid skipping their emails. Retry the same call (same cursor) to get a complete page.";

/**
 * With any failed mailbox, pagination must not advance: that mailbox's emails
 * older than the merged cursor would be skipped forever.
 */
export function withholdCursorOnFailure(
	nextCursor: string | null,
	failures: MailboxFailure[],
): { nextCursor: string | null; hint?: string } {
	if (failures.length === 0) return { nextCursor };
	return { nextCursor: null, hint: PARTIAL_RESULTS_HINT };
}

/** Per-mailbox search as seen by the paging orchestration. */
export type MailboxSearch = (
	mailboxId: string,
	after: SearchAfter | undefined,
	fetchLimit: number,
) => Promise<MailboxEmail[]>;

/**
 * One page of the cross-mailbox listing: fan out, tolerate per-mailbox
 * failures, merge. Each mailbox is asked for `limit + 1` rows (capped at
 * `maxFetch`); fewer rows back means it is exhausted, so a full fetch proves
 * at least one more row exists and a non-null cursor is never followed by an
 * empty page.
 */
export async function listInboxPage(args: {
	mailboxIds: string[];
	search: MailboxSearch;
	limit: number;
	maxFetch: number;
	cursor?: InboxCursor;
}): Promise<{
	emails: InboxEntry[];
	nextCursor: string | null;
	hint?: string;
	failures: MailboxFailure[];
}> {
	const { mailboxIds, search, limit, maxFetch, cursor } = args;
	const fetchLimit = Math.min(limit + 1, maxFetch);
	const settled = await Promise.allSettled(
		mailboxIds.map(async (mailboxId): Promise<MailboxPage> => {
			const after = cursor ? searchAfterFor(cursor, mailboxId) : undefined;
			const emails = await search(mailboxId, after, fetchLimit);
			return { mailboxId, emails, exhausted: emails.length < fetchLimit };
		}),
	);
	const { pages, failures } = collectMailboxResults(mailboxIds, settled);
	const merged = mergeMailboxPages(pages, limit, cursor);
	return {
		emails: merged.emails,
		...withholdCursorOnFailure(merged.nextCursor, failures),
		failures,
	};
}
