import type { Env } from "../types";

/**
 * Keys of `Env` that carry a string value. Config entries reference a secret by
 * name rather than embedding its value, and this type makes the reference
 * checked: a name that isn't declared on `Env` (workers/types.ts) fails
 * typecheck instead of silently resolving to `undefined` at runtime.
 */
export type SecretKey = {
	[K in keyof Env]: Env[K] extends string | undefined ? K : never;
}[keyof Env] &
	string;

/**
 * The subset of `Env` the notifier layer reads. Narrower than `Env` so tests can
 * pass a plain object literal instead of faking R2 buckets and DO namespaces.
 */
export type SecretSource = { readonly [K in SecretKey]?: string | undefined };

/** Which mailboxes an entry applies to. `"*"` means every mailbox (catch-all). */
export type MailboxFilter = "*" | readonly string[];

type NotifierConfigBase = {
	/** Name of the `Env` secret holding this target's webhook URL. */
	readonly secret: SecretKey;
	readonly mailboxes: MailboxFilter;
};

export type DiscordNotifierConfig = NotifierConfigBase & {
	readonly type: "discord";
};

export type WebPushNotifierConfig = NotifierConfigBase & {
	readonly type: "webpush";
};

/**
 * Add a variant here when adding an adapter. The `switch` in ./index.ts is
 * exhaustive, so a new variant surfaces as a typecheck failure at the dispatch
 * site rather than as a silently dropped notification.
 */
export type NotifierConfig = DiscordNotifierConfig | WebPushNotifierConfig;

/**
 * A config entry that matched the mailbox and had its secret configured.
 * `secretValue` is the resolved secret — the webhook URL for discord, the
 * VAPID private key for webpush.
 */
export type NotifierTarget = NotifierConfig & { readonly secretValue: string };

export type NewEmailPayload = {
	readonly mailboxId: string;
	readonly emailId: string;
	readonly sender: string;
	readonly subject: string;
	readonly snippet: string;
	readonly receivedAt: string;
};
