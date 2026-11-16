// Push-only service worker: no fetch handler, no Cache Storage — this app
// deliberately does not cache mail offline. Payload shape comes from
// workers/notifiers/webpush.ts (WebPushMessage).

const parsePayload = (event) => {
	const fallback = { title: "New mail", body: "", tag: undefined, url: "/" };
	if (!event.data) return fallback;
	try {
		const json = event.data.json();
		return {
			title: json.title || fallback.title,
			body: json.body || "",
			tag: json.tag,
			url: json.url || "/",
		};
	} catch {
		return fallback;
	}
};

self.addEventListener("push", (event) => {
	const message = parsePayload(event);
	event.waitUntil(
		self.registration.showNotification(message.title, {
			body: message.body,
			tag: message.tag,
			icon: "/icon-192.png",
			data: { url: message.url },
		}),
	);
});

const focusOrOpen = async (url) => {
	const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	const existing = clientList.find(
		(client) => new URL(client.url).origin === self.location.origin,
	);
	if (existing) {
		await existing.focus();
		const samePath = new URL(existing.url).pathname === new URL(url, self.location.origin).pathname;
		if (!samePath && "navigate" in existing) {
			try {
				await existing.navigate(url);
			} catch {
				// Uncontrolled clients (opened before this SW activated) reject
				// navigate(); focusing the tab is still a reasonable outcome.
			}
		}
		return;
	}
	await self.clients.openWindow(url);
};

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = (event.notification.data && event.notification.data.url) || "/";
	event.waitUntil(focusOrOpen(url));
});

const resubscribe = async (event) => {
	const oldOptions = event.oldSubscription && event.oldSubscription.options;
	const applicationServerKey = oldOptions && oldOptions.applicationServerKey;
	if (!applicationServerKey) return;
	const subscription = await self.registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey,
	});
	await fetch("/api/v1/push/subscriptions", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(subscription.toJSON()),
	});
};

self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil(resubscribe(event));
});
