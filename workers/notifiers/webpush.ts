// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { errorMessage, mailboxURL, truncate } from "./format";
import type { Triage } from "./triage";
import type { NewEmailPayload } from "./types";

/** PushSubscriptionJSON as the browser's pushManager.subscribe().toJSON() produces it. */
export type StoredPushSubscription = {
	readonly endpoint: string;
	readonly keys: { readonly p256dh: string; readonly auth: string };
};

/** The slice of the PushSubscriptionsDO stub this module uses — tests pass plain objects. */
export type PushSubscriptionsLike = {
	list(): Promise<StoredPushSubscription[]>;
	remove(endpoint: string): Promise<void>;
};

/** The slice of DurableObjectNamespace this module uses to resolve the singleton. */
export type PushSubscriptionsNamespaceLike<Id = unknown> = {
	idFromName(name: string): Id;
	get(id: Id): PushSubscriptionsLike;
};

export const resolvePushStore = <Id>(
	namespace: PushSubscriptionsNamespaceLike<Id>,
): PushSubscriptionsLike => namespace.get(namespace.idFromName("global"));

/** Whole payload must stay under the ~4KB Web Push limit; these keep it far below. */
const LIMIT = { title: 200, body: 500 } as const;

export type WebPushMessage = {
	readonly title: string;
	readonly body: string;
	readonly url: string;
	readonly tag: string;
};

export type WebPushSendArgs = {
	readonly subscription: StoredPushSubscription;
	readonly body: string;
	readonly vapid: {
		readonly subject: string;
		readonly publicKey: string;
		readonly privateKey: string;
	};
};

/**
 * One encrypted send. HTTP-level failures must reject with an object carrying
 * `statusCode` (webpush-sender.ts's WebPushHTTPError does) so expired
 * subscriptions are recognizable.
 */
export type WebPushSenderLike = (args: WebPushSendArgs) => Promise<void>;

/**
 * Like the Discord embed, title/URL always come from the real mail so a
 * summary steered by a malicious sender cannot misrepresent the source.
 */
export const buildWebPushMessage = (
	payload: NewEmailPayload,
	triage: Triage | null = null,
): WebPushMessage => ({
	title: truncate(payload.subject || "(件名なし)", LIMIT.title),
	body: truncate(triage?.summary ?? payload.snippet, LIMIT.body),
	url: mailboxURL(payload.mailboxId),
	tag: payload.emailId,
});

const statusCodeOf = (error: unknown): number | null => {
	if (typeof error !== "object" || error === null) return null;
	if (!("statusCode" in error)) return null;
	return typeof error.statusCode === "number" ? error.statusCode : null;
};

export type DeliverWebPushArgs = {
	readonly payload: NewEmailPayload;
	readonly triage: Triage | null;
	readonly privateKey: string;
	readonly publicKey: string | undefined;
	readonly subject: string | undefined;
	readonly store: PushSubscriptionsLike | undefined;
	readonly send: WebPushSenderLike;
};

/**
 * Fan one notification out to every stored subscription. Expired endpoints
 * (404/410) are pruned as routine maintenance, not failures. Anything else
 * failing throws ONE aggregate Error so the caller's per-target catch turns
 * it into a single NotifyFailure (keeping the failure list bounded).
 */
export const deliverWebPush = async (args: DeliverWebPushArgs): Promise<void> => {
	const { payload, triage, privateKey, publicKey, subject, store, send } = args;
	if (!publicKey) throw new Error("VAPID_PUBLIC_KEY is not set");
	if (!subject) throw new Error("VAPID_SUBJECT is not set");
	if (!store) throw new Error("PUSH_SUBSCRIPTIONS binding is not available");

	const subscriptions = await store.list();
	if (subscriptions.length === 0) return;

	const body = JSON.stringify(buildWebPushMessage(payload, triage));
	const vapid = { subject, publicKey, privateKey };

	const sendToSubscription = async (
		subscription: StoredPushSubscription,
	): Promise<string | null> => {
		try {
			await send({ subscription, body, vapid });
			return null;
		} catch (error) {
			const status = statusCodeOf(error);
			if (status === 404 || status === 410) {
				try {
					await store.remove(subscription.endpoint);
					return null;
				} catch (removeError) {
					return `prune failed: ${errorMessage(removeError)}`;
				}
			}
			return status === null ? errorMessage(error) : `push service responded ${status}`;
		}
	};

	const outcomes = await Promise.all(subscriptions.map(sendToSubscription));
	const failures = outcomes.filter((outcome) => outcome !== null);
	if (failures.length > 0) {
		throw new Error(`${failures.length}/${subscriptions.length} subscriptions failed: ${failures[0]}`);
	}
};
