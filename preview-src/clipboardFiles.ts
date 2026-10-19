/** Prefer actual clipboard files; some hosts expose them only through items. */
export function clipboardFiles(data: Pick<DataTransfer, 'files' | 'items'>): File[] {
	const files = Array.from(data.files);
	return files.length ? files : Array.from(data.items)
		.filter(item => item.kind === 'file')
		.map(item => item.getAsFile()).filter((file): file is File => file !== null);
}

export function fileBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
		reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled.`));
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== 'string' || !result.includes(',')) { reject(new Error('Could not read clipboard file.')); return; }
			resolve(result.slice(result.indexOf(',') + 1));
		};
		reader.readAsDataURL(file);
	});
}
