/**
 * Connects an MCP SDK Client to the real EmailMCP tool registrations over an
 * in-memory transport. Only Cloudflare bindings are faked; tool code, zod
 * schemas and the MCP SDK are the real ones from the repo under test.
 *
 * The repo under test is MCP_TEST_REPO (set by run.sh) so the same test file
 * can run against the working tree and a control ref.
 */
import { execSync } from "node:child_process";

export const REPO =
	process.env.MCP_TEST_REPO ?? execSync("git rev-parse --show-toplevel").toString().trim();

/** Import a module from the repo under test, e.g. repoImport("workers/lib/attachments.ts"). */
export const repoImport = (rel: string) => import(`${REPO}/${rel}`);

const { Client } = await repoImport("node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { InMemoryTransport } = await repoImport("node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js");
const { EmailMCP } = await repoImport("workers/mcp/index.ts");

export const MAILBOX = "me@own.example";

export type SentLog = {
	/** Messages passed to env.EMAIL.send */
	sent: any[];
	/** [key, bytes] passed to env.BUCKET.put */
	r2: [string, Uint8Array][];
	/** Every Mailbox DO method call as [method, args] */
	calls: [string, unknown[]][];
};

export type SetupOptions = {
	/** Emails returned by the fake DO's getEmail(id). */
	emails?: Record<string, unknown>[];
	/** Override or add Mailbox DO methods. Unmocked methods throw with their name. */
	stub?: Record<string, (...args: any[]) => unknown>;
	/** Response of env.AI.run. Default: throws (AI unavailable). MCP send/draft paths never call it. */
	ai?: (...args: any[]) => unknown;
	/** Extra/override env bindings. */
	env?: Record<string, unknown>;
};

export const setup = async (options: SetupOptions = {}) => {
	const log: SentLog = { sent: [], r2: [], calls: [] };
	const emails = new Map((options.emails ?? []).map((e) => [e.id as string, e]));
	const methods: Record<string, (...args: any[]) => unknown> = {
		checkSendRateLimit: async () => null,
		createEmail: async () => undefined,
		getEmail: async (id: string) => emails.get(id) ?? null,
		getEmails: async () => [...emails.values()],
		markThreadRead: async () => undefined,
		...options.stub,
	};
	const stub = new Proxy(
		{},
		{
			get: (_t, name: string) => {
				if (name === "then") return undefined;
				const fn = methods[name];
				if (!fn) throw new Error(`fake Mailbox DO: "${name}" is not mocked — pass it via setup({ stub: { ${name} } })`);
				return async (...args: unknown[]) => {
					log.calls.push([name, args]);
					return fn(...args);
				};
			},
		},
	);
	const env = {
		MAILBOX: { idFromName: () => "fake-id", get: () => stub },
		AI: { run: options.ai ?? (async () => { throw new Error("AI unavailable in test"); }) },
		// Like the real binding: it picks the Message-ID and returns it bracketed.
		EMAIL: { send: async (m: unknown) => { log.sent.push(m); return { messageId: `<delivered-${log.sent.length}@own.example>` }; } },
		BUCKET: {
			head: async (key: string) => (key === `mailboxes/${MAILBOX}.json` ? {} : null),
			put: async (key: string, bytes: Uint8Array) => { log.r2.push([key, bytes]); },
			get: async () => null,
			list: async () => ({ objects: [{ key: `mailboxes/${MAILBOX}.json` }] }),
		},
		...options.env,
	};

	const mcp = new EmailMCP();
	mcp.env = env;
	await mcp.init();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await mcp.server.connect(serverTransport);
	const client = new Client({ name: "mcp-protocol-test", version: "0.0.0" });
	await client.connect(clientTransport);

	/** callTool plus parsed JSON text (null when the text is not JSON). */
	const call = async (name: string, args: Record<string, unknown>) => {
		const res: any = await client.callTool({ name, arguments: args });
		const text: string = res.content?.[0]?.text ?? "";
		const json = (() => { try { return JSON.parse(text); } catch { return null; } })();
		return { isError: res.isError === true, text, json };
	};

	/** Mailbox DO calls to one method, as argument lists. */
	const callsTo = (method: string) => log.calls.filter(([m]) => m === method).map(([, args]) => args);

	return { client, call, log, callsTo, env };
};

export const b64 = (s: string) => Buffer.from(s).toString("base64");
