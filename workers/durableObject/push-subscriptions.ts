// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type { StoredPushSubscription } from "../notifiers/webpush";

/**
 * Device push subscriptions. Singleton: always addressed via
 * idFromName("global") — subscriptions are per-device, not per-mailbox.
 */
export class PushSubscriptionsDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS subscriptions (
				endpoint   TEXT PRIMARY KEY,
				p256dh     TEXT NOT NULL,
				auth       TEXT NOT NULL,
				created_at TEXT NOT NULL
			)
		`);
	}

	upsert(subscription: StoredPushSubscription): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO subscriptions (endpoint, p256dh, auth, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
			subscription.endpoint,
			subscription.keys.p256dh,
			subscription.keys.auth,
			new Date().toISOString(),
		);
	}

	remove(endpoint: string): void {
		this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE endpoint = ?", endpoint);
	}

	list(): StoredPushSubscription[] {
		const rows = this.ctx.storage.sql
			.exec<{ endpoint: string; p256dh: string; auth: string }>(
				"SELECT endpoint, p256dh, auth FROM subscriptions",
			)
			.toArray();
		return rows.map((row) => ({
			endpoint: row.endpoint,
			keys: { p256dh: row.p256dh, auth: row.auth },
		}));
	}
}
