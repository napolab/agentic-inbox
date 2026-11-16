/**
 * FileList helpers built on DataTransfer, so an <input type="file">
 * element can serve as the single source of truth for selected files.
 * Browser-only: DataTransfer does not exist in workerd or Node.
 */

export function unpackFileList(fileList: FileList | null): File[] {
	const files: File[] = [];
	for (const file of fileList ?? []) {
		files.push(file);
	}
	return files;
}

export function createFileList(files: File[]): FileList {
	const dt = new DataTransfer();
	for (const file of files) {
		dt.items.add(file);
	}
	return dt.files;
}
