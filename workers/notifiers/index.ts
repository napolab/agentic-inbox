import { notifiers } from "./config";
import { buildDiscordMessage } from "./discord";
import { errorMessage } from "./format";
import { type AiLike, triageEmail, type Triage } from "./triage";
import type {
	MailboxFilter,
	NewEmailPayload,
	NotifierConfig,
	NotifierTarget,
	SecretSource,
} from "./types";
import {
	deliverWebPush,
	resolvePushStore,
	type PushSubscriptionsNamespaceLike,
	type WebPushSenderLike,
} from "./webpush";
import { sendWebPushNotification } from "./webpush-sender";

/**
 * The slice of `fetch` this module uses. Narrower than the platform type so a
 * test can supply a plain function; `globalThis.fetch` is assignable to it.
 */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export type NotifyFailure = {
	readonly type: NotifierConfig["type"];
	readonly reason: string;
};

/** What the notifier layer needs from the Worker environment. */
export type NotifierEnv = SecretSource & {
	readonly AI?: AiLike;
	readonly PUSH_SUBSCRIPTIONS?: PushSubscriptionsNamespaceLike;
};

export type NotifyDeps = {
	readonly configs?: readonly NotifierConfig[];
	readonly fetch?: FetchLike;
	readonly sendWebPush?: WebPushSenderLike;
};

const matchesMailbox = (filter: MailboxFilter, mailboxId: string): boolean => {
	if (filter === "*") return true;
	const needle = mailboxId.toLowerCase();
	return filter.some((candidate) => candidate.toLowerCase() === needle);
};

/**
 * Narrow the configured notifiers down to the ones that should fire for this
 * mailbox and have their webhook URL available.
 */
export const resolveTargets = (
	secrets: SecretSource,
	mailboxId: string,
	configs: readonly NotifierConfig[] = notifiers,
): NotifierTarget[] => {
	return configs
		.filter((config) => matchesMailbox(config.mailboxes, mailboxId))
		.flatMap((config) => {
			const secretValue = secrets[config.secret];
			if (!secretValue) return [];
			return [{ ...config, secretValue }];
		});
};

type WebhookRequest = {
	readonly url: string;
	readonly init: { method: string; headers: Record<string, string>; body: string };
};

/**
 * Map a discord target to the HTTP request that delivers it. Pure — the
 * single fetch lives in `deliver`, so this adapter stays testable without I/O.
 */
const buildDiscordRequest = (
	target: NotifierTarget & { type: "discord" },
	payload: NewEmailPayload,
	triage: Triage | null,
): WebhookRequest => ({
	url: target.secretValue,
	init: {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(buildDiscordMessage(payload, triage)),
	},
});

type DeliverIO = {
	readonly fetch: FetchLike;
	readonly sendWebPush: WebPushSenderLike;
};

const deliver = async (
	target: NotifierTarget,
	payload: NewEmailPayload,
	triage: Triage | null,
	env: NotifierEnv,
	io: DeliverIO,
): Promise<void> => {
	switch (target.type) {
		case "discord": {
			const { url, init } = buildDiscordRequest(target, payload, triage);
			const response = await io.fetch(url, init);
			if (!response.ok) throw new Error(`webhook responded ${response.status}`);
			return;
		}
		case "webpush":
			return deliverWebPush({
				payload,
				triage,
				privateKey: target.secretValue,
				publicKey: env.VAPID_PUBLIC_KEY,
				subject: env.VAPID_SUBJECT,
				store: env.PUSH_SUBSCRIPTIONS ? resolvePushStore(env.PUSH_SUBSCRIPTIONS) : undefined,
				send: io.sendWebPush,
			});
		default: {
			// Adding a NotifierConfig variant without a case above fails here at compile time.
			const exhaustive: never = target;
			throw new Error(`unhandled notifier type: ${JSON.stringify(exhaustive)}`);
		}
	}
};

/**
 * Fan out a new-mail notification to every configured target. Never throws:
 * delivery is best-effort and failures come back as data so the caller decides
 * how to surface them.
 */
export const notifyNewEmail = async (
	env: NotifierEnv,
	payload: NewEmailPayload,
	deps: NotifyDeps = {},
): Promise<NotifyFailure[]> => {
	const {
		configs = notifiers,
		// Bound on the way in. `fetch` is a native method, and `deliver` reaches it
		// as `io.fetch(...)` — an unbound reference would arrive with `io` as its
		// receiver and workerd rejects that with "Illegal invocation". A test that
		// injects a plain function never sees it, so only production breaks.
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
		sendWebPush = sendWebPushNotification,
	} = deps;
	const targets = resolveTargets(env, payload.mailboxId, configs);
	// Resolve first: summarizing mail that nobody is notified about is a billed
	// model call for nothing.
	if (targets.length === 0) return [];

	const triage = env.AI ? await triageEmail(env.AI, payload) : null;

	const outcomes = await Promise.all(
		targets.map(async (target): Promise<NotifyFailure | null> => {
			try {
				await deliver(target, payload, triage, env, { fetch: fetchImpl, sendWebPush });
				return null;
			} catch (error) {
				return { type: target.type, reason: errorMessage(error) };
			}
		}),
	);

	return outcomes.filter((outcome) => outcome !== null);
};
