import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { createFileList, unpackFileList } from "~/lib/filelist";

// Lazy so importing this module never touches DataTransfer during SSR.
let emptyFileList: FileList | undefined;
function getEmptyFileList(): FileList {
	emptyFileList ??= createFileList([]);
	return emptyFileList;
}

export type FileListWrite =
	| { outcome: "ok"; files: FileList }
	| { outcome: "no_bind" };

/**
 * Decides the next selection when the user picks files. `accepted` is
 * the selection before the pick; `picked` is what the file dialog
 * returned. Return the full selection to keep.
 */
export type MergePicks = (accepted: File[], picked: File[]) => File[];

// Native <input type="file"> semantics: a pick replaces the selection.
const replacePicks: MergePicks = (_accepted, picked) => picked;

/**
 * Treats a file input element as the single source of truth for its
 * selected files. Reads subscribe via useSyncExternalStore; writes
 * (set/remove/clear) rebuild the FileList with DataTransfer and notify
 * subscribers directly — no synthetic DOM events, so the only change
 * events on the element are native picks. `bindRef` (a React 19
 * callback ref with cleanup) owns the element and its change listener:
 * on a pick, `merge` decides the next selection (default: replace,
 * like a plain file input) and it is written back. `merge` is read
 * through a latest ref, so any function — stable or not — works.
 *
 * Adapted from flat-developer/purchase-system's use-file-list
 * (neverthrow Result → outcome union, RefObject → callback ref for
 * conditionally mounted inputs, injectable merge policy, null server
 * snapshot because DataTransfer does not exist in workerd).
 */
export function useFileList(merge: MergePicks = replacePicks) {
	const elementRef = useRef<HTMLInputElement | null>(null);
	const listenersRef = useRef(new Set<() => void>());
	const acceptedRef = useRef<File[]>([]);
	const mergeRef = useRef(merge);
	mergeRef.current = merge;

	const notify = useCallback(() => {
		for (const listener of listenersRef.current) listener();
	}, []);

	const bindRef = useCallback(
		(element: HTMLInputElement) => {
			elementRef.current = element;
			// A newly bound input starts from its own (empty) selection.
			acceptedRef.current = unpackFileList(element.files);
			const onNativeChange = () => {
				const picked = unpackFileList(element.files);
				const next = mergeRef.current(acceptedRef.current, picked);
				element.files = createFileList(next);
				acceptedRef.current = next;
				notify();
			};
			element.addEventListener("change", onNativeChange);
			notify();
			return () => {
				element.removeEventListener("change", onNativeChange);
				elementRef.current = null;
				notify();
			};
		},
		[notify],
	);

	const subscribe = useCallback((onStoreChange: () => void) => {
		listenersRef.current.add(onStoreChange);
		return () => {
			listenersRef.current.delete(onStoreChange);
		};
	}, []);
	const files = useSyncExternalStore(
		subscribe,
		() => elementRef.current?.files ?? getEmptyFileList(),
		() => null,
	);

	const set = useCallback(
		(next: File[]): FileListWrite => {
			const element = elementRef.current;
			if (element === null) return { outcome: "no_bind" };
			element.files = createFileList(next);
			acceptedRef.current = next;
			notify();
			return { outcome: "ok", files: element.files };
		},
		[notify],
	);

	const remove = useCallback(
		(file: File): FileListWrite => {
			const element = elementRef.current;
			if (element === null) return { outcome: "no_bind" };
			return set(unpackFileList(element.files).filter((f) => f !== file));
		},
		[set],
	);

	const clear = useCallback((): FileListWrite => set([]), [set]);

	return useMemo(
		() => ({ bindRef, files, set, remove, clear }),
		[bindRef, files, set, remove, clear],
	);
}
