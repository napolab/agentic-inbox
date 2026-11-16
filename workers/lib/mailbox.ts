// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
	};
};

/**
 * Create the mailbox R2 marker + default settings if it doesn't exist yet.
 * Used by catch-all receive and the import endpoint, where mailboxes appear
 * on first contact instead of via POST /api/v1/mailboxes.
 */
export async function ensureMailboxExists(env: Env, email: string): Promise<void> {
	const key = `mailboxes/${email}.json`;
	if (await env.BUCKET.head(key)) return;
	const defaultSettings = {
		fromName: email.split("@")[0],
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
	};
	await env.BUCKET.put(key, JSON.stringify(defaultSettings));
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(email));
	await stub.getFolders(); // initializes the DO's folder rows
}

/**
 * Whether the per-mailbox auto-draft agent should run on inbound mail.
 * Opt-in: true ONLY when `settings.autoDraft.enabled === true`; anything
 * absent or malformed means off.
 */
export function isAutoDraftEnabled(settings: unknown): boolean {
	if (typeof settings !== "object" || settings === null) return false;
	const autoDraft = (settings as { autoDraft?: unknown }).autoDraft;
	if (typeof autoDraft !== "object" || autoDraft === null) return false;
	return (autoDraft as { enabled?: unknown }).enabled === true;
}

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);
	
	await next();
});
