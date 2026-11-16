import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDiscordMessage } from "./discord";
import { notifyNewEmail, resolveTargets } from "./index";
import type { NewEmailPayload, NotifierConfig } from "./types";
import type { PushSubscriptionsLike, StoredPushSubscription, WebPushSendArgs } from "./webpush";

const payload = (overrides: Partial<NewEmailPayload> = {}): NewEmailPayload => ({
	mailboxId: "alerts@own.example",
	emailId: "11111111-2222-3333-4444-555555555555",
	sender: "sender@example.com",
	subject: "請求書のご送付",
	snippet: "お世話になっております。今月分の請求書を添付いたします。",
	receivedAt: "2026-08-17T11:00:00.000Z",
	...overrides,
});

const discord = (overrides: Partial<NotifierConfig> = {}): NotifierConfig => ({
	type: "discord",
	secret: "DISCORD_WEBHOOK_URL",
	mailboxes: "*",
	...overrides,
});

test('resolveTargets pairs a "*" entry with the url held in its secret', () => {
	const targets = resolveTargets(
		{ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" },
		"hello@own.example",
		[discord()],
	);

	assert.deepEqual(targets, [
		{
			type: "discord",
			secret: "DISCORD_WEBHOOK_URL",
			mailboxes: "*",
			secretValue: "https://discord.com/api/webhooks/1/abc",
		},
	]);
});

test("resolveTargets drops entries whose mailbox list excludes the recipient", () => {
	const config = [discord({ mailboxes: ["alerts@own.example"] })];

	assert.deepEqual(
		resolveTargets({ DISCORD_WEBHOOK_URL: "https://hook" }, "hello@own.example", config),
		[],
	);
	assert.equal(
		resolveTargets({ DISCORD_WEBHOOK_URL: "https://hook" }, "alerts@own.example", config)
			.length,
		1,
	);
});

test("resolveTargets matches mailboxes case-insensitively", () => {
	// Mailbox ids are lowercased on receive, but a config written by hand is not.
	const targets = resolveTargets({ DISCORD_WEBHOOK_URL: "https://hook" }, "alerts@own.example", [
		discord({ mailboxes: ["ALERTS@Own.example"] }),
	]);

	assert.equal(targets.length, 1);
});

test("resolveTargets drops entries whose secret is unset or empty", () => {
	assert.deepEqual(resolveTargets({}, "hello@own.example", [discord()]), []);
	assert.deepEqual(
		resolveTargets({ DISCORD_WEBHOOK_URL: "" }, "hello@own.example", [discord()]),
		[],
	);
});

test("buildDiscordMessage carries the sender, the subject and a link to the mailbox", () => {
	const message = buildDiscordMessage(payload());
	const serialized = JSON.stringify(message);

	assert.ok(serialized.includes("請求書のご送付"), "subject is missing");
	assert.ok(serialized.includes("sender@example.com"), "sender is missing");
	assert.ok(
		serialized.includes("https://inbox.example.com/mailbox/alerts%40own.example/emails/inbox"),
		"deep link to the mailbox is missing",
	);
});

test("buildDiscordMessage substitutes a placeholder for an empty subject", () => {
	// Discord rejects an embed whose title is an empty string, and mail with no
	// Subject header is common enough (bounces, some automated senders) to hit.
	const serialized = JSON.stringify(buildDiscordMessage(payload({ subject: "" })));

	assert.ok(!serialized.includes('"title":""'), "empty title would be rejected by Discord");
	assert.ok(serialized.includes("(件名なし)"), "placeholder title is missing");
});

test("buildDiscordMessage truncates fields to Discord's documented limits", () => {
	// Discord rejects the whole message with 400 if any field exceeds its limit
	// (title 256, description 4096), which would drop the notification silently.
	const [embed] = buildDiscordMessage(
		payload({ subject: "件".repeat(500), snippet: "本".repeat(6000) }),
	).embeds!;

	assert.ok(embed.title!.length <= 256, `title was ${embed.title!.length} chars`);
	assert.ok(embed.description!.length <= 4096, `description was ${embed.description!.length} chars`);
	assert.ok(embed.title!.endsWith("…"), "truncation should be visible to the reader");
});

test("buildDiscordMessage does not split a surrogate pair when truncating", () => {
	// "🎉" is two UTF-16 code units, so a naive slice at an odd index leaves a
	// lone surrogate — an ill-formed string that Discord rejects.
	const [embed] = buildDiscordMessage(payload({ subject: "🎉".repeat(300) })).embeds!;
	const withoutValidPairs = embed.title!.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");

	assert.ok(!/[\uD800-\uDFFF]/.test(withoutValidPairs), "title contains a lone surrogate");
	assert.ok(embed.title!.length <= 256, `title was ${embed.title!.length} chars`);
});

type RecordedCall = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

const recordingFetch = (responses: readonly (Response | Error)[] = []) => {
	const calls: RecordedCall[] = [];
	const fetchLike = async (url: string, init: RecordedCall["init"]) => {
		calls.push({ url, init });
		const next = responses[calls.length - 1];
		if (next instanceof Error) throw next;
		return next ?? { ok: true, status: 204 };
	};
	return { calls, fetchLike };
};

test("notifyNewEmail posts the built message to every configured target", async () => {
	const { calls, fetchLike } = recordingFetch();

	const failures = await notifyNewEmail({ DISCORD_WEBHOOK_URL: "https://hook" }, payload(), {
		configs: [discord(), discord()],
		fetch: fetchLike,
	});

	assert.deepEqual(failures, []);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, "https://hook");
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers["Content-Type"], "application/json");
	assert.ok(JSON.parse(calls[0].init.body).embeds[0].title.includes("請求書"));
});

test("notifyNewEmail reports a rejected delivery without holding back the others", async () => {
	const { calls, fetchLike } = recordingFetch([new Error("network down")]);

	const failures = await notifyNewEmail({ DISCORD_WEBHOOK_URL: "https://hook" }, payload(), {
		configs: [discord(), discord()],
		fetch: fetchLike,
	});

	assert.equal(calls.length, 2, "the second target must still be attempted");
	assert.equal(failures.length, 1);
	assert.equal(failures[0].type, "discord");
	assert.ok(failures[0].reason.includes("network down"));
});

test("notifyNewEmail reports a non-2xx webhook response as a failure", async () => {
	// Discord answers 400 for a malformed embed; without this the notification
	// would vanish with no trace at all.
	const { fetchLike } = recordingFetch([new Response("bad embed", { status: 400 })]);

	const failures = await notifyNewEmail({ DISCORD_WEBHOOK_URL: "https://hook" }, payload(), {
		configs: [discord()],
		fetch: fetchLike,
	});

	assert.equal(failures.length, 1);
	assert.ok(failures[0].reason.includes("400"));
});

test("notifyNewEmail does nothing when no target is configured", async () => {
	const { calls, fetchLike } = recordingFetch();

	const failures = await notifyNewEmail({}, payload(), { configs: [discord()], fetch: fetchLike });

	assert.deepEqual(calls, []);
	assert.deepEqual(failures, []);
});

test("buildDiscordMessage prefers the AI summary over the raw excerpt", () => {
	const [embed] = buildDiscordMessage(payload(), {
		summary: "8/25 が期限の請求書",
		importance: "high",
	}).embeds!;

	assert.equal(embed.description, "8/25 が期限の請求書");
	assert.equal(embed.color, 0xe74c3c);
});

test("buildDiscordMessage colours the embed by importance", () => {
	const colorFor = (importance: "high" | "normal" | "low") =>
		buildDiscordMessage(payload(), { summary: "s", importance }).embeds![0].color;

	assert.equal(colorFor("normal"), 0x5865f2);
	assert.equal(colorFor("low"), 0x99aab5);
});

test("buildDiscordMessage falls back to the excerpt and a neutral colour without triage", () => {
	// An unavailable summary must not read as "unimportant" — that is how a
	// deadline gets missed.
	const [embed] = buildDiscordMessage(payload(), null).embeds!;

	assert.equal(embed.description, payload().snippet);
	assert.equal(embed.color, 0x5865f2);
});

const aiReturning = (value: unknown) => ({
	calls: [] as unknown[],
	run(model: string, input: Record<string, unknown>) {
		this.calls.push({ model, input });
		return Promise.resolve(value);
	},
});

test("notifyNewEmail decorates the delivered message with the AI triage", async () => {
	const { calls, fetchLike } = recordingFetch();
	const ai = aiReturning({ response: { summary: "8/25 が期限の請求書", importance: "high" } });

	await notifyNewEmail({ DISCORD_WEBHOOK_URL: "https://hook", AI: ai }, payload(), {
		configs: [discord()],
		fetch: fetchLike,
	});

	const [embed] = JSON.parse(calls[0].init.body).embeds;
	assert.equal(embed.description, "8/25 が期限の請求書");
	assert.equal(embed.color, 0xe74c3c);
});

test("notifyNewEmail delivers without a summary when no AI binding is present", async () => {
	const { calls, fetchLike } = recordingFetch();

	const failures = await notifyNewEmail({ DISCORD_WEBHOOK_URL: "https://hook" }, payload(), {
		configs: [discord()],
		fetch: fetchLike,
	});

	assert.deepEqual(failures, []);
	assert.equal(JSON.parse(calls[0].init.body).embeds[0].description, payload().snippet);
});

test("notifyNewEmail spends no model call when nothing is listening", async () => {
	// Inference is billed per call, so an unconfigured deployment (a fork, a
	// local dev run) must not pay to summarize mail nobody is notified about.
	const { fetchLike } = recordingFetch();
	const ai = aiReturning({ response: { summary: "s", importance: "low" } });

	await notifyNewEmail({ AI: ai }, payload(), { configs: [discord()], fetch: fetchLike });

	assert.deepEqual(ai.calls, []);
});

const webpushConfig = (): NotifierConfig => ({
	type: "webpush",
	secret: "VAPID_PRIVATE_KEY",
	mailboxes: "*",
});

const pushEnv = (store: PushSubscriptionsLike) => ({
	VAPID_PRIVATE_KEY: "private-key",
	VAPID_PUBLIC_KEY: "public-key",
	VAPID_SUBJECT: "mailto:test@example.com",
	PUSH_SUBSCRIPTIONS: {
		idFromName: (name: string) => name,
		get: () => store,
	},
});

test("notifyNewEmail delivers webpush to every stored subscription", async () => {
	const sent: WebPushSendArgs[] = [];
	const subscriptions: StoredPushSubscription[] = [
		{ endpoint: "https://push/1", keys: { p256dh: "k", auth: "a" } },
	];
	const failures = await notifyNewEmail(
		pushEnv({ list: async () => subscriptions, remove: async () => {} }),
		payload(),
		{
			configs: [webpushConfig()],
			sendWebPush: async (args) => {
				sent.push(args);
			},
		},
	);
	assert.deepEqual(failures, []);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.vapid.privateKey, "private-key");
});

test("notifyNewEmail reports one aggregated webpush failure and Discord still delivers", async () => {
	const fetchLike = async () => ({ ok: true, status: 204 });
	const failures = await notifyNewEmail(
		{
			...pushEnv({
				list: async () => [{ endpoint: "https://push/1", keys: { p256dh: "k", auth: "a" } }],
				remove: async () => {},
			}),
			DISCORD_WEBHOOK_URL: "https://hook",
		},
		payload(),
		{
			configs: [discord(), webpushConfig()],
			fetch: fetchLike,
			sendWebPush: async () => {
				throw { statusCode: 500 };
			},
		},
	);
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.type, "webpush");
	assert.match(failures[0]?.reason ?? "", /1\/1 subscriptions failed/);
});

test("notifyNewEmail skips webpush entirely when VAPID_PRIVATE_KEY is unset", async () => {
	const failures = await notifyNewEmail({}, payload(), {
		configs: [webpushConfig()],
		sendWebPush: async () => {
			throw new Error("must not be called");
		},
	});
	assert.deepEqual(failures, []);
});

test("notifyNewEmail invokes the platform fetch with a receiver it accepts", async () => {
	// workerd's `fetch` is a native method: invoking it with any receiver other
	// than the global object throws "Illegal invocation". Every other test here
	// injects `deps.fetch`, so this is the only one exercising the default that
	// production actually runs — the path that shipped broken (discord went
	// silent while web push, which calls a plain module function, kept working).
	const original = globalThis.fetch;
	const calls: string[] = [];
	// Stands in for the native binding: same receiver check, no network.
	// eslint-disable-next-line func-style -- needs a dynamic `this` to model the native receiver check
	const nativeLike = function (this: unknown, url: string) {
		if (this !== undefined && this !== globalThis) {
			throw new TypeError(
				"Illegal invocation: function called with incorrect `this` reference.",
			);
		}
		calls.push(url);
		return Promise.resolve({ ok: true, status: 204 });
	};
	Object.defineProperty(globalThis, "fetch", { value: nativeLike, configurable: true });

	try {
		const failures = await notifyNewEmail({ DISCORD_WEBHOOK_URL: "https://hook" }, payload(), {
			configs: [discord()],
		});

		assert.deepEqual(failures, [], "the platform fetch must not be rejected by its own receiver check");
		assert.deepEqual(calls, ["https://hook"]);
	} finally {
		Object.defineProperty(globalThis, "fetch", { value: original, configurable: true });
	}
});
