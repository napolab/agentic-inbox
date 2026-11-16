import { useSyncExternalStore } from "react";

// Contract shared with the inline script in app/root.tsx: the key holds
// "light" | "dark"; an absent key means "system" (follow the OS).
const THEME_STORAGE_KEY = "theme";

export type Theme = "light" | "dark" | "system";

const isStoredTheme = (value: unknown): value is "light" | "dark" =>
	value === "light" || value === "dark";

export const isTheme = (value: unknown): value is Theme =>
	value === "system" || isStoredTheme(value);

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)");

const applyTheme = (theme: Theme) => {
	const dark =
		theme === "dark" || (theme === "system" && prefersDark().matches);
	if (dark) {
		document.documentElement.setAttribute("data-mode", "dark");
	} else {
		document.documentElement.removeAttribute("data-mode");
	}
};

// localStorage access can throw (e.g. SecurityError when site data is
// blocked); these mirror the try/catch posture of the inline FOUC script in
// app/root.tsx so a blocked store degrades to in-session switching instead
// of crashing the app.
const readStored = (): unknown => {
	try {
		return window.localStorage.getItem(THEME_STORAGE_KEY);
	} catch {
		return null;
	}
};

const writeStored = (next: Theme) => {
	try {
		if (next === "system") {
			window.localStorage.removeItem(THEME_STORAGE_KEY);
		} else {
			window.localStorage.setItem(THEME_STORAGE_KEY, next);
		}
	} catch {
		// Preference persistence unavailable; in-session switching still works.
	}
};

// Module-scope theme store, watched via useSyncExternalStore. All consumers
// share one snapshot, so the hook can mount in any number of places.
const listeners = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;
let cachedTheme: Theme | null = null;

const getSnapshot = (): Theme => {
	if (cachedTheme === null) {
		const stored = readStored();
		cachedTheme = isStoredTheme(stored) ? stored : "system";
	}
	return cachedTheme;
};

// SSR renders as "system"; after hydration React swaps in the client
// snapshot, so no mount-effect resync (or hydration mismatch) is needed.
const getServerSnapshot = (): Theme => "system";

// OS theme changes only matter in system mode, and they change the applied
// attribute, not the stored preference — so no listener notification.
const handleOsChange = () => {
	if (getSnapshot() !== "system") return;
	applyTheme("system");
};

const subscribe = (listener: () => void): (() => void) => {
	if (listeners.size === 0) {
		mediaQuery = prefersDark();
		mediaQuery.addEventListener("change", handleOsChange);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		mediaQuery?.removeEventListener("change", handleOsChange);
		mediaQuery = null;
	};
};

export const setTheme = (next: Theme) => {
	cachedTheme = next;
	writeStored(next);
	applyTheme(next);
	for (const listener of listeners) {
		listener();
	}
};

export function useTheme() {
	const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	return { theme, setTheme };
}
