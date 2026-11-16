import type { NotifierConfig } from "./types";

/**
 * Where new-mail notifications go.
 *
 * Entries hold the *name* of the secret carrying the webhook URL, never the URL
 * itself — a webhook URL is a credential and would otherwise live in git history
 * forever. Set the value with `wrangler secret put <NAME>` (and in `.dev.vars`
 * for local development); an entry whose secret is unset is skipped silently.
 *
 * Adding a target:
 *   1. add the secret to `.dev.vars` and `.dev.vars.example`, then rerun
 *      `pnpm typecheck` so `wrangler types` emits it on the generated `Env`
 *   2. add an entry here
 *
 * Adding an adapter kind: add a variant to `NotifierConfig` in ./types.ts — the
 * dispatch `switch` in ./index.ts then fails typecheck until it handles it.
 */
export const notifiers = [
	{
		type: "discord",
		secret: "DISCORD_WEBHOOK_URL",
		mailboxes: "*",
	},
	{
		type: "webpush",
		secret: "VAPID_PRIVATE_KEY",
		mailboxes: "*",
	},
] as const satisfies readonly NotifierConfig[];
