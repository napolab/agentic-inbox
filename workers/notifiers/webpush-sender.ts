// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { deserializeVapidKeys, sendPushNotification } from "web-push-browser";
import type { WebPushSenderLike } from "./webpush";

/**
 * HTTP-level push failure. Carries `statusCode` because the delivery layer
 * (workers/notifiers/webpush.ts statusCodeOf) prunes 404/410 subscriptions
 * by reading that field off the thrown error.
 */
class WebPushHTTPError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number) {
		super(`push service responded ${statusCode}`);
		this.name = "WebPushHTTPError";
		this.statusCode = statusCode;
	}
}

/**
 * One day: long enough to survive an offline phone, short enough that a
 * stale new-mail alert dies before it misleads. Passed explicitly so a
 * library-default change can never silently shorten it.
 */
const TTL_SECONDS = 86_400;

/** The library builds the JWT `sub` claim as `mailto:${email}`. */
const bareSubject = (subject: string): string =>
	subject.startsWith("mailto:") ? subject.slice("mailto:".length) : subject;

/**
 * Real sender: web-push-browser handles RFC 8291 aes128gcm payload
 * encryption and the VAPID JWT with pure WebCrypto — no Node compat
 * shims, so it loads identically in workerd, `pnpm dev`, and node:test.
 * NOTE: the private key must be the PKCS8/base64url serialization
 * produced by this library's own keygen (see .dev.vars.example).
 */
export const sendWebPushNotification: WebPushSenderLike = async ({ subscription, body, vapid }) => {
	const keyPair = await deserializeVapidKeys({
		publicKey: vapid.publicKey,
		privateKey: vapid.privateKey,
	});
	const response = await sendPushNotification(
		keyPair,
		{ endpoint: subscription.endpoint, keys: subscription.keys },
		bareSubject(vapid.subject),
		body,
		{ algorithm: "aes128gcm", ttl: TTL_SECONDS },
	);
	if (!response.ok) throw new WebPushHTTPError(response.status);
};
