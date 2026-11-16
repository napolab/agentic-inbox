// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { PushSubscriptionSchema } from "./schemas";

test("PushSubscriptionSchema accepts a browser PushSubscriptionJSON", () => {
	const result = PushSubscriptionSchema.safeParse({
		endpoint: "https://fcm.googleapis.com/fcm/send/abc",
		expirationTime: null,
		keys: { p256dh: "BPub", auth: "authsecret" },
	});
	assert.equal(result.success, true);
});

test("PushSubscriptionSchema rejects non-https endpoints and missing keys", () => {
	assert.equal(
		PushSubscriptionSchema.safeParse({
			endpoint: "http://insecure.example.com/x",
			keys: { p256dh: "BPub", auth: "authsecret" },
		}).success,
		false,
	);
	assert.equal(
		PushSubscriptionSchema.safeParse({
			endpoint: "https://fcm.googleapis.com/fcm/send/abc",
			keys: { p256dh: "", auth: "authsecret" },
		}).success,
		false,
	);
	assert.equal(PushSubscriptionSchema.safeParse(null).success, false);
});

test("PushSubscriptionSchema rejects non-base64url key characters", () => {
	assert.equal(
		PushSubscriptionSchema.safeParse({
			endpoint: "https://fcm.googleapis.com/fcm/send/abc",
			keys: { p256dh: "BPub+key", auth: "authsecret" },
		}).success,
		false,
	);
	assert.equal(
		PushSubscriptionSchema.safeParse({
			endpoint: "https://fcm.googleapis.com/fcm/send/abc",
			keys: { p256dh: "BPub", auth: "auth=secret=" },
		}).success,
		false,
	);
});
