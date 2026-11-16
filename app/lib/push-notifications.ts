// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import api from "../services/api";

export type PushStatus = "pending" | "unsupported" | "prompt" | "subscribed" | "denied";

export type PushCommand = { type: "init" } | { type: "enable" } | { type: "disable" };

/** The slice of PushSubscription the store touches — tests pass plain objects. */
export type PushSubscriptionLike = {
	readonly endpoint: string;
	toJSON(): unknown;
	unsubscribe(): Promise<boolean>;
};

/** The slice of ServiceWorkerRegistration.pushManager the store touches. */
export type PushRegistrationLike = {
	getSubscription(): Promise<PushSubscriptionLike | null>;
	subscribe(applicationServerKey: BufferSource): Promise<PushSubscriptionLike>;
};

/**
 * Everything the store needs from the browser. Kept narrow so the core stays
 * framework- and DOM-free: tests (and non-browser hosts) supply plain objects.
 */
export type PushPlatformLike = {
	isSupported(): boolean;
	permission(): NotificationPermission;
	requestPermission(): Promise<NotificationPermission>;
	registerServiceWorker(): Promise<void>;
	/** Registration once the worker is ACTIVE — subscribe() rejects on an installing worker. */
	readyRegistration(): Promise<PushRegistrationLike>;
	getRegistration(): Promise<PushRegistrationLike | undefined>;
	/** Best-effort: invoke onChange when the notification permission changes outside the app. */
	watchPermission(onChange: () => void): void;
};

/** The slice of the API client the store calls. */
export type PushAPILike = {
	getVapidPublicKey(): Promise<{ publicKey: string }>;
	savePushSubscription(subscription: unknown): Promise<void>;
	deletePushSubscription(endpoint: string): Promise<void>;
};

export type PushStoreDeps = {
	readonly platform: PushPlatformLike;
	readonly api: PushAPILike;
};

export type PushStore = {
	/** useSyncExternalStore contract: returns the unsubscribe function. */
	subscribe(listener: () => void): () => void;
	getStatus(): PushStatus;
	dispatch(command: PushCommand): Promise<boolean>;
};

/**
 * VAPID public keys are base64url; PushManager wants raw bytes.
 */
const urlBase64ToUint8Array = (base64url: string): Uint8Array => {
	const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
	const base64 = `${base64url}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	return Uint8Array.from(raw, (char) => char.charCodeAt(0));
};

/**
 * Headless, framework-free push-subscription state machine. React (or any
 * other host) observes it through subscribe/getStatus and drives it by
 * dispatching commands; all browser and network I/O arrives through deps.
 *
 * `enable` must be dispatched from a user gesture — browsers reject
 * permission prompts outside one. On iOS this only works from an installed
 * home-screen PWA (16.4+); a plain Safari tab reports "unsupported".
 */
export const createPushStore = (deps: PushStoreDeps = defaultBrowserDeps): PushStore => {
	const state: { status: PushStatus } = { status: "pending" };
	const listeners = new Set<() => void>();
	const watch = { started: false };

	const setStatus = (status: PushStatus): void => {
		if (state.status === status) return;
		state.status = status;
		for (const listener of listeners) listener();
	};

	/** Re-derive the status from the browser's current permission + subscription. */
	const refresh = async (): Promise<boolean> => {
		if (deps.platform.permission() === "denied") {
			setStatus("denied");
			return true;
		}
		const registration = await deps.platform.getRegistration();
		const subscription = await registration?.getSubscription();
		setStatus(subscription ? "subscribed" : "prompt");
		return true;
	};

	const init = async (): Promise<boolean> => {
		if (!deps.platform.isSupported()) {
			setStatus("unsupported");
			return false;
		}
		if (!watch.started) {
			watch.started = true;
			deps.platform.watchPermission(() => {
				void refresh();
			});
		}
		return refresh();
	};

	const enable = async (): Promise<boolean> => {
		if (!deps.platform.isSupported()) {
			setStatus("unsupported");
			return false;
		}
		await deps.platform.registerServiceWorker();
		const permission = await deps.platform.requestPermission();
		if (permission !== "granted") {
			setStatus(permission === "denied" ? "denied" : "prompt");
			return false;
		}
		const registration = await deps.platform.readyRegistration();
		const { publicKey } = await deps.api.getVapidPublicKey();
		// slice() produces a fresh, non-shared buffer: urlBase64ToUint8Array
		// returns Uint8Array<ArrayBufferLike>, while BufferSource requires a
		// plain ArrayBuffer (see workers/notifiers/webpush-sender.ts).
		const subscription = await registration.subscribe(urlBase64ToUint8Array(publicKey).slice());
		await deps.api.savePushSubscription(subscription.toJSON());
		setStatus("subscribed");
		return true;
	};

	const disable = async (): Promise<boolean> => {
		const registration = await deps.platform.getRegistration();
		const subscription = await registration?.getSubscription();
		if (!subscription) {
			setStatus("prompt");
			return true;
		}
		await deps.api.deletePushSubscription(subscription.endpoint);
		await subscription.unsubscribe();
		setStatus("prompt");
		return true;
	};

	return {
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getStatus: () => state.status,
		dispatch: (command) => {
			switch (command.type) {
				case "init":
					return init();
				case "enable":
					return enable();
				case "disable":
					return disable();
			}
		},
	};
};

export type BrowserPushPlatformOptions = {
	/** URL the service worker script is served from. */
	readonly serviceWorkerURL?: string;
	/** Registration scope — hosts mounted under a different namespace pass their own. */
	readonly scope?: string;
};

const wrapRegistration = (registration: ServiceWorkerRegistration): PushRegistrationLike => ({
	getSubscription: () => registration.pushManager.getSubscription(),
	subscribe: (applicationServerKey) =>
		registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }),
});

/**
 * The real-browser PushPlatformLike. Every property defers touching
 * window/navigator until called, so constructing it is SSR-safe.
 */
export const createBrowserPushPlatform = (
	options: BrowserPushPlatformOptions = {},
): PushPlatformLike => {
	const { serviceWorkerURL = "/sw.js", scope = "/" } = options;
	return {
		isSupported: () =>
			typeof window !== "undefined" &&
			"serviceWorker" in navigator &&
			"PushManager" in window &&
			"Notification" in window,
		permission: () => Notification.permission,
		requestPermission: () => Notification.requestPermission(),
		registerServiceWorker: async () => {
			await navigator.serviceWorker.register(serviceWorkerURL, { scope });
		},
		readyRegistration: async () => wrapRegistration(await navigator.serviceWorker.ready),
		getRegistration: async () => {
			const registration = await navigator.serviceWorker.getRegistration(scope);
			return registration ? wrapRegistration(registration) : undefined;
		},
		watchPermission: (onChange) => {
			const attach = async (): Promise<void> => {
				if (!("permissions" in navigator)) return;
				try {
					const status = await navigator.permissions.query({ name: "notifications" });
					status.onchange = onChange;
				} catch {
					// Permissions API unavailable for this permission — polling is not
					// worth it; the status still refreshes on init/enable/disable.
				}
			};
			void attach();
		},
	};
};

const defaultBrowserDeps: PushStoreDeps = {
	platform: createBrowserPushPlatform(),
	api,
};
