// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildWebPushMessage,
	deliverWebPush,
	type PushSubscriptionsLike,
	type StoredPushSubscription,
	type WebPushSendArgs,
} from "./webpush";
import type { NewEmailPayload } from "./types";

const payload = (overrides: Partial<NewEmailPayload> = {}): NewEmailPayload => ({
	mailboxId: "alerts@own.example",
	emailId: "11111111-2222-3333-4444-555555555555",
	sender: "sender@example.com",
	subject: "請求書のご送付",
	snippet: "お世話になっております。今月分の請求書を添付いたします。",
	receivedAt: "2026-08-17T11:00:00.000Z",
	...overrides,
});

const subscription = (endpoint: string): StoredPushSubscription => ({
	endpoint,
	keys: { p256dh: "p256dh-key", auth: "auth-key" },
});

const fakeStore = (initial: StoredPushSubscription[]) => {
	const removed: string[] = [];
	const store: PushSubscriptionsLike = {
		list: async () => initial,
		remove: async (endpoint) => {
			removed.push(endpoint);
		},
	};
	return { store, removed };
};

const vapidArgs = (store: PushSubscriptionsLike, send: (args: WebPushSendArgs) => Promise<void>) => ({
	payload: payload(),
	triage: null,
	privateKey: "private-key",
	publicKey: "public-key",
	subject: "mailto:test@example.com",
	store,
	send,
});

test("buildWebPushMessage uses subject, snippet, mailbox URL and email id tag", () => {
	const message = buildWebPushMessage(payload());
	assert.equal(message.title, "請求書のご送付");
	assert.equal(message.body, "お世話になっております。今月分の請求書を添付いたします。");
	assert.equal(message.url, "https://inbox.example.com/mailbox/alerts%40own.example/emails/inbox");
	assert.equal(message.tag, "11111111-2222-3333-4444-555555555555");
});

test("buildWebPushMessage prefers the AI summary and falls back on empty subject", () => {
	const message = buildWebPushMessage(payload({ subject: "" }), {
		importance: "high",
		summary: "請求書が届きました",
	});
	assert.equal(message.title, "(件名なし)");
	assert.equal(message.body, "請求書が届きました");
});

test("buildWebPushMessage truncates long title and body without splitting surrogates", () => {
	const message = buildWebPushMessage(
		payload({ subject: "😀".repeat(300), snippet: "あ".repeat(900) }),
	);
	assert.ok(message.title.length <= 200);
	assert.ok(message.body.length <= 500);
	assert.ok(message.title.endsWith("…"));
	assert.ok(message.title.isWellFormed());
	assert.ok(message.title.startsWith("😀"));
});

test("deliverWebPush sends the same encrypted body to every subscription", async () => {
	const sent: WebPushSendArgs[] = [];
	const { store } = fakeStore([subscription("https://push/1"), subscription("https://push/2")]);
	await deliverWebPush(vapidArgs(store, async (args) => {
		sent.push(args);
	}));
	assert.equal(sent.length, 2);
	assert.equal(sent[0]?.vapid.subject, "mailto:test@example.com");
	const parsed: unknown = JSON.parse(sent[0]?.body ?? "");
	assert.ok(typeof parsed === "object" && parsed !== null && "title" in parsed);
});

test("deliverWebPush does nothing when the store is empty", async () => {
	const { store } = fakeStore([]);
	const sent: WebPushSendArgs[] = [];
	await deliverWebPush(vapidArgs(store, async (args) => {
		sent.push(args);
	}));
	assert.equal(sent.length, 0);
});

test("deliverWebPush prunes 404/410 subscriptions without reporting failure", async () => {
	const { store, removed } = fakeStore([subscription("https://push/dead"), subscription("https://push/alive")]);
	await deliverWebPush(vapidArgs(store, async ({ subscription: sub }) => {
		if (sub.endpoint === "https://push/dead") throw { statusCode: 410 };
	}));
	assert.deepEqual(removed, ["https://push/dead"]);
});

test("deliverWebPush throws one aggregate error when a send fails", async () => {
	const { store, removed } = fakeStore([subscription("https://push/1"), subscription("https://push/2")]);
	await assert.rejects(
		deliverWebPush(vapidArgs(store, async ({ subscription: sub }) => {
			if (sub.endpoint === "https://push/2") throw { statusCode: 429 };
		})),
		/1\/2 subscriptions failed: push service responded 429/,
	);
	assert.deepEqual(removed, []);
});

test("deliverWebPush reports a prune failure instead of aborting sibling sends", async () => {
	const { store } = fakeStore([subscription("https://push/dead"), subscription("https://push/alive")]);
	const failingStore: PushSubscriptionsLike = {
		list: store.list,
		remove: async () => {
			throw new Error("kv unavailable");
		},
	};
	const sentTo: string[] = [];
	await assert.rejects(
		deliverWebPush(vapidArgs(failingStore, async ({ subscription: sub }) => {
			sentTo.push(sub.endpoint);
			if (sub.endpoint === "https://push/dead") throw { statusCode: 410 };
		})),
		/prune failed/,
	);
	assert.deepEqual(sentTo, ["https://push/dead", "https://push/alive"]);
});

test("deliverWebPush names the missing configuration piece", async () => {
	const { store } = fakeStore([subscription("https://push/1")]);
	const base = vapidArgs(store, async () => {});
	await assert.rejects(deliverWebPush({ ...base, publicKey: undefined }), /VAPID_PUBLIC_KEY/);
	await assert.rejects(deliverWebPush({ ...base, subject: undefined }), /VAPID_SUBJECT/);
	await assert.rejects(deliverWebPush({ ...base, store: undefined }), /PUSH_SUBSCRIPTIONS/);
});
