// Gmail Takeout mbox → Agentic Inbox importer.
// Usage: pnpm run import:mbox -- --mbox path/to/All\ mail.mbox --domain example.com [--base-url https://inbox.example.com] [--dry-run] [--limit N]
// Env: IMPORT_TOKEN (Worker secret) is always required. For Cloudflare Access, provide EITHER
//   CF_ACCESS_TOKEN (a JWT from `cloudflared access token -app=https://inbox.example.com`)
//   OR the pair CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (an Access service token).
// NOTE: the server endpoint /api/v1/import has been removed after the original migration was
// cancelled; it must be restored (endpoint + IMPORT_TOKEN secret) before this script can do a live run.
// --dry-run works without it.
import { createReadStream, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export type Classified = { mailbox: string; folder: "inbox" | "sent" };

function headerValues(rawHeaders: string, name: string): string[] {
	// Unfold continuation lines, then collect every occurrence of the header.
	const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ");
	const re = new RegExp(`^${name}:[ \\t]*(.*)$`, "gim");
	const out: string[] = [];
	for (const m of unfolded.matchAll(re)) out.push(m[1]);
	return out;
}

function addressesIn(text: string, domain: string): string[] {
	const re = new RegExp(`[A-Za-z0-9._%+-]+@${domain.replace(/\./g, "\\.")}(?![A-Za-z0-9.-])`, "gi");
	return (text.match(re) || []).map((a) => a.toLowerCase());
}

export function classifyMessage(rawHeaders: string, domain: string): Classified | null {
	const labels = headerValues(rawHeaders, "X-Gmail-Labels").join(",");
	if (/(?:^|,)\s*(Spam|Trash|Draft|Chat)\s*(?:,|$)/i.test(labels)) return null;

	const fromOwn = addressesIn(headerValues(rawHeaders, "From").join(","), domain);
	if (fromOwn.length > 0) return { mailbox: fromOwn[0], folder: "sent" };

	const recipientFields = ["To", "Cc", "Bcc", "Delivered-To", "X-Original-To", "X-Forwarded-To"]
		.flatMap((h) => headerValues(rawHeaders, h));
	const own = addressesIn(recipientFields.join(","), domain);
	if (own.length > 0) return { mailbox: own[0], folder: "inbox" };
	return null;
}

export function unescapeMboxrd(message: string): string {
	return message.replace(/^>(>*From )/gm, "$1");
}

/** Yields raw messages (without the leading "From " separator line). */
export function* splitMbox(content: string): Generator<string> {
	const lines = content.split("\n");
	let current: string[] | null = null;
	for (const line of lines) {
		if (/^From /.test(line)) {
			if (current) yield current.join("\n");
			current = [];
		} else if (current) {
			current.push(line);
		}
	}
	if (current) yield current.join("\n");
}

function splitHeadersFromBody(message: string): string {
	const idx = message.search(/\r?\n\r?\n/);
	return idx === -1 ? message : message.slice(0, idx);
}

async function main() {
	const args = process.argv.slice(2);
	const opt = (name: string) => {
		const i = args.indexOf(`--${name}`);
		return i === -1 ? undefined : args[i + 1];
	};
	const mboxPath = opt("mbox");
	const baseUrl = opt("base-url") ?? "https://inbox.example.com";
	const dryRun = args.includes("--dry-run");
	const limit = opt("limit") ? Number(opt("limit")) : Infinity;
	const domain = opt("domain") ?? "example.com";
	if (!mboxPath) { console.error("--mbox <path> is required"); process.exit(1); }

	const token = process.env.IMPORT_TOKEN;
	const accessToken = process.env.CF_ACCESS_TOKEN;
	const accessId = process.env.CF_ACCESS_CLIENT_ID;
	const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;
	const hasServiceToken = Boolean(accessId && accessSecret);
	if (!dryRun && (!token || (!accessToken && !hasServiceToken))) {
		console.error(
			"IMPORT_TOKEN must be set, plus either CF_ACCESS_TOKEN or both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET",
		);
		process.exit(1);
	}

	const stats = { imported: 0, duplicates: 0, skipped: 0, failed: 0, seen: 0 };
	const routing = new Map<string, number>(); // dry-run summary: "mailbox/folder" -> count

	// Stream the mbox line-by-line: Takeout archives can be tens of GB.
	let current: string[] | null = null;
	const flush = async () => {
		if (!current || current.length === 0) return;
		const message = current.join("\n");
		current = null;
		if (stats.seen >= limit) return;

		const headers = splitHeadersFromBody(message);
		const cls = classifyMessage(headers, domain);
		if (!cls) { stats.skipped++; return; }
		stats.seen++;
		const key = `${cls.mailbox}/${cls.folder}`;
		routing.set(key, (routing.get(key) ?? 0) + 1);
		if (dryRun) {
			if (stats.seen % 1000 === 0) console.log(`progress: ${JSON.stringify(stats)}`);
			return;
		}

		const body = unescapeMboxrd(message);
		try {
			const authHeaders: Record<string, string> = accessToken
				? { "cf-access-token": accessToken }
				: { "CF-Access-Client-Id": accessId!, "CF-Access-Client-Secret": accessSecret! };
			const res = await fetch(
				`${baseUrl}/api/v1/import?mailbox=${encodeURIComponent(cls.mailbox)}&folder=${cls.folder}`,
				{
					method: "POST",
					headers: {
						"Authorization": `Bearer ${token}`,
						...authHeaders,
						"Content-Type": "message/rfc822",
					},
					body,
				},
			);
			if (res.status === 201) stats.imported++;
			else if (res.status === 200) stats.duplicates++;
			else throw new Error(`HTTP ${res.status}: ${await res.text()}`);
		} catch (e) {
			stats.failed++;
			const msgId = headerValues(headers, "Message-ID")[0] ?? "(none)";
			appendFileSync("scripts/failed.jsonl", JSON.stringify({ msgId, mailbox: cls.mailbox, folder: cls.folder, error: String(e) }) + "\n");
		}
		if ((stats.imported + stats.duplicates + stats.failed) % 100 === 0) {
			console.log(`progress: ${JSON.stringify(stats)}`);
		}
	};

	const rl = createInterface({ input: createReadStream(mboxPath), crlfDelay: Infinity });
	for await (const line of rl) {
		if (/^From /.test(line)) {
			await flush();
			current = [];
		} else if (current) {
			current.push(line);
		}
	}
	await flush();

	console.log("done:", JSON.stringify(stats, null, 2));
	if (dryRun) {
		const sorted = [...routing.entries()].sort((a, b) => b[1] - a[1]);
		for (const [key, count] of sorted) console.log(`${String(count).padStart(6)}  ${key}`);
	}
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1]?.endsWith("import-mbox.ts")) {
	main().catch((e) => { console.error(e); process.exit(1); });
}
