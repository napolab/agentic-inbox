// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { createPushStore, type PushStatus, type PushStore } from "~/lib/push-notifications";

export type { PushStatus } from "~/lib/push-notifications";

const PushStoreContext = createContext<PushStore | null>(null);

type PushNotificationsProviderProps = {
	readonly children: ReactNode;
	/** Override for tests or hosts whose service worker lives under another namespace. */
	readonly store?: PushStore;
};

/**
 * Owns the store instance and runs the one explicit `init` dispatch; the
 * headless core (app/lib/push-notifications.ts) stays React-free.
 */
export const PushNotificationsProvider = ({ children, store: storeProp }: PushNotificationsProviderProps) => {
	const [store] = useState(() => storeProp ?? createPushStore());

	useEffect(() => {
		void store.dispatch({ type: "init" });
	}, [store]);

	return <PushStoreContext.Provider value={store}>{children}</PushStoreContext.Provider>;
};

const getServerStatus = (): PushStatus => "pending";

export const usePushNotifications = () => {
	const store = useContext(PushStoreContext);
	if (store === null) {
		throw new Error("usePushNotifications must be used within a PushNotificationsProvider");
	}

	const status = useSyncExternalStore(store.subscribe, store.getStatus, getServerStatus);
	const enable = useCallback(() => store.dispatch({ type: "enable" }), [store]);
	const disable = useCallback(() => store.dispatch({ type: "disable" }), [store]);

	return { status, enable, disable };
};
