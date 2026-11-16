// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	createPushStore,
	type PushAPILike,
	type PushPlatformLike,
	type PushRegistrationLike,
	type PushSubscriptionLike,
} from "./push-notifications";

const flushMicrotasks = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
};

const fakeSubscription = (endpoint: string) => {
	const calls = { unsubscribed: false };
	const subscription: PushSubscriptionLike = {
		endpoint,
		toJSON: () => ({ endpoint, keys: { p256dh: "k", auth: "a" } }),
		unsubscribe: async () => {
			calls.unsubscribed = true;
			return true;
		},
	};
	return { subscription, calls };
};

const fakeRegistration = (subscription: PushSubscriptionLike | null): PushRegistrationLike => ({
	getSubscription: async () => subscription,
	subscribe: async () => {
		if (subscription === null) throw new Error("no subscription to hand out");
		return subscription;
	},
});

type PlatformState = {
	permission: NotificationPermission;
	registration: PushRegistrationLike | undefined;
	registered: string[];
	permissionWatchers: Array<() => void>;
};

const fakePlatform = (
	initial: Partial<Pick<PlatformState, "permission" | "registration">> = {},
): { platform: PushPlatformLike; state: PlatformState } => {
	const state: PlatformState = {
		permission: initial.permission ?? "default",
		registration: initial.registration,
		registered: [],
		permissionWatchers: [],
	};
	const platform: PushPlatformLike = {
		isSupported: () => true,
		permission: () => state.permission,
		requestPermission: async () => state.permission,
		registerServiceWorker: async () => {
			state.registered.push("/sw.js");
		},
		readyRegistration: async () => {
			if (state.registration === undefined) throw new Error("no registration");
			return state.registration;
		},
		getRegistration: async () => state.registration,
		watchPermission: (onChange) => {
			state.permissionWatchers.push(onChange);
		},
	};
	return { platform, state };
};

const fakeAPI = () => {
	const calls = { saved: [] as unknown[], deleted: [] as string[] };
	const api: PushAPILike = {
		getVapidPublicKey: async () => ({ publicKey: "BFakePublicKey00" }),
		savePushSubscription: async (subscription) => {
			calls.saved.push(subscription);
		},
		deletePushSubscription: async (endpoint) => {
			calls.deleted.push(endpoint);
		},
	};
	return { api, calls };
};

test("init reports unsupported platforms and refuses further work", async () => {
	const { platform } = fakePlatform();
	const unsupported: PushPlatformLike = { ...platform, isSupported: () => false };
	const store = createPushStore({ platform: unsupported, api: fakeAPI().api });

	assert.equal(store.getStatus(), "pending");
	assert.equal(await store.dispatch({ type: "init" }), false);
	assert.equal(store.getStatus(), "unsupported");
});

test("init resolves subscribed when a subscription already exists", async () => {
	const { subscription } = fakeSubscription("https://push/existing");
	const { platform } = fakePlatform({ registration: fakeRegistration(subscription) });
	const store = createPushStore({ platform, api: fakeAPI().api });

	assert.equal(await store.dispatch({ type: "init" }), true);
	assert.equal(store.getStatus(), "subscribed");
});

test("init resolves prompt without a subscription and denied when blocked", async () => {
	const { platform } = fakePlatform({ registration: fakeRegistration(null) });
	const store = createPushStore({ platform, api: fakeAPI().api });
	await store.dispatch({ type: "init" });
	assert.equal(store.getStatus(), "prompt");

	const denied = fakePlatform({ permission: "denied" });
	const deniedStore = createPushStore({ platform: denied.platform, api: fakeAPI().api });
	await deniedStore.dispatch({ type: "init" });
	assert.equal(deniedStore.getStatus(), "denied");
});

test("enable registers the worker, saves the subscription, and notifies listeners", async () => {
	const { subscription } = fakeSubscription("https://push/new");
	const { platform, state } = fakePlatform({
		permission: "granted",
		registration: fakeRegistration(subscription),
	});
	const { api, calls } = fakeAPI();
	const store = createPushStore({ platform, api });
	const seen: string[] = [];
	store.subscribe(() => {
		seen.push(store.getStatus());
	});

	assert.equal(await store.dispatch({ type: "enable" }), true);
	assert.equal(store.getStatus(), "subscribed");
	assert.deepEqual(state.registered, ["/sw.js"]);
	assert.deepEqual(calls.saved, [
		{ endpoint: "https://push/new", keys: { p256dh: "k", auth: "a" } },
	]);
	assert.deepEqual(seen, ["subscribed"]);
});

test("enable stops without saving when permission is not granted", async () => {
	const { platform } = fakePlatform({ permission: "denied" });
	const { api, calls } = fakeAPI();
	const store = createPushStore({ platform, api });

	assert.equal(await store.dispatch({ type: "enable" }), false);
	assert.equal(store.getStatus(), "denied");
	assert.deepEqual(calls.saved, []);
});

test("disable deletes the stored subscription and unsubscribes the browser", async () => {
	const { subscription, calls: subscriptionCalls } = fakeSubscription("https://push/old");
	const { platform } = fakePlatform({ registration: fakeRegistration(subscription) });
	const { api, calls } = fakeAPI();
	const store = createPushStore({ platform, api });

	assert.equal(await store.dispatch({ type: "disable" }), true);
	assert.equal(store.getStatus(), "prompt");
	assert.deepEqual(calls.deleted, ["https://push/old"]);
	assert.equal(subscriptionCalls.unsubscribed, true);
});

test("unsubscribed listeners stop receiving notifications", async () => {
	const { platform } = fakePlatform({ registration: fakeRegistration(null) });
	const store = createPushStore({ platform, api: fakeAPI().api });
	const seen: string[] = [];
	const unsubscribe = store.subscribe(() => {
		seen.push(store.getStatus());
	});

	await store.dispatch({ type: "init" });
	assert.deepEqual(seen, ["prompt"]);

	unsubscribe();
	await store.dispatch({ type: "disable" });
	assert.deepEqual(seen, ["prompt"]);
});

test("a browser-side permission change refreshes the status", async () => {
	const denied = fakePlatform({ permission: "denied", registration: fakeRegistration(null) });
	const store = createPushStore({ platform: denied.platform, api: fakeAPI().api });

	await store.dispatch({ type: "init" });
	assert.equal(store.getStatus(), "denied");
	assert.equal(denied.state.permissionWatchers.length, 1);

	denied.state.permission = "default";
	const [watcher] = denied.state.permissionWatchers;
	if (watcher === undefined) throw new Error("watcher missing");
	watcher();
	await flushMicrotasks();
	assert.equal(store.getStatus(), "prompt");
});
