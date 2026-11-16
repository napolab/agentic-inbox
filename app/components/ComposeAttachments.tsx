import { Button } from "@cloudflare/kumo";
import { PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useRef } from "react";
import { formatBytes } from "~/lib/utils";

interface AttachmentChipProps {
	file: File;
	disabled: boolean;
	onRemove: (file: File) => void;
}

function AttachmentChip({ file, disabled, onRemove }: AttachmentChipProps) {
	const handleRemove = useCallback(() => {
		onRemove(file);
	}, [onRemove, file]);

	return (
		<div className="flex items-center gap-2 rounded-md border border-kumo-line px-3 py-2 text-sm">
			<PaperclipIcon size={16} className="text-kumo-subtle shrink-0" />
			<span className="text-kumo-default font-medium truncate max-w-[140px]">{file.name}</span>
			<span className="text-kumo-subtle">{formatBytes(file.size)}</span>
			<button
				type="button"
				onClick={handleRemove}
				disabled={disabled}
				aria-label={`Remove ${file.name}`}
				className="text-kumo-subtle hover:text-kumo-default"
			>
				<XIcon size={14} />
			</button>
		</div>
	);
}

interface ComposeAttachmentsProps {
	files: File[];
	bindInputRef: (element: HTMLInputElement) => () => void;
	onRemoveFile: (file: File) => void;
	disabled: boolean;
}

export default function ComposeAttachments({
	files,
	bindInputRef,
	onRemoveFile,
	disabled,
}: ComposeAttachmentsProps) {
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Returning a cleanup (React 19 ref contract) means React never calls
	// this with null; the hook's cleanup must be chained, not swallowed.
	const bindRef = useCallback(
		(element: HTMLInputElement | null) => {
			if (element === null) return;
			inputRef.current = element;
			const cleanup = bindInputRef(element);
			return () => {
				inputRef.current = null;
				cleanup();
			};
		},
		[bindInputRef],
	);

	const handleAttachClick = useCallback(() => {
		inputRef.current?.click();
	}, []);

	// No onChange: useFileList owns the input's change events and applies
	// the injected merge policy when the user picks files.
	return (
		<div className="space-y-2">
			<input
				ref={bindRef}
				type="file"
				multiple
				className="hidden"
			/>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				icon={<PaperclipIcon size={14} />}
				disabled={disabled}
				onClick={handleAttachClick}
			>
				Attach files
			</Button>
			{files.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{files.map((file, index) => (
						<AttachmentChip
							key={`${file.name}-${index}`}
							file={file}
							disabled={disabled}
							onRemove={onRemoveFile}
						/>
					))}
				</div>
			)}
		</div>
	);
}
