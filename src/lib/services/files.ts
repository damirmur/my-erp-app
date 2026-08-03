// Хелперы для файловых полей (FILE и ZIP-files).
// Данные хранятся base64-строкой прямо в jsonb-поле record.data.

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 МБ

export interface StoredFile {
	name: string;
	size: number;
	type: string;
	data: string; // base64
}

export interface StoredZip {
	name: string;
	files: { name: string; size: number }[];
	data: string; // base64 zip-архива
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
	const units = ['Б', 'КБ', 'МБ', 'ГБ'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Blob/File -> base64 (chunked, чтобы не упереться в лимит аргумента btoa)
export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== 'string') return reject(new Error('Не удалось прочитать файл'));
			const base64 = result.split(',')[1] ?? '';
			resolve(base64);
		};
		reader.onerror = () => reject(reader.error ?? new Error('Ошибка чтения файла'));
		reader.readAsDataURL(blob);
	});
}

// base64 -> Blob
export function base64ToBlob(base64: string, type = 'application/octet-stream'): Blob {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type });
}

// Скачивание Blob как файла
export function downloadBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function checkFileSize(file: File): string | null {
	if (file.size > MAX_FILE_SIZE) {
		return `Файл «${file.name}» слишком большой (${formatBytes(file.size)}). Максимум ${formatBytes(MAX_FILE_SIZE)}.`;
	}
	return null;
}

// Файл -> значение поля FILE
export async function fileToStoredFile(file: File): Promise<StoredFile> {
	const data = await blobToBase64(file);
	return { name: file.name, size: file.size, type: file.type || 'application/octet-stream', data };
}
