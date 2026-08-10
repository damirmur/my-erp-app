// Хелперы для файловых полей (FILE и ZIP-files).
// Содержимое файлов (base64) хранится в отдельном хранилище data_files
// (Dexie — локально, таблица data_files — на сервере). В record.data.jsonb
// у файлового поля остаётся только ссылка { name, size, type, fileId }.
import { db, type LocalFile } from '$lib/db/indexeddb';

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

// ---- Ссылки на вложения (data_files) вместо base64 в record.data ----

export interface FileRef {
	name: string;
	size: number;
	type?: string;
	fileId: string;
	files?: { name: string; size: number }[];
}

// Значение файлового поля — ссылка на data_files.
export function isFileRef(v: unknown): v is FileRef {
	return !!v && typeof v === 'object' && typeof (v as FileRef).fileId === 'string';
}

// Значение файлового поля ещё не вынесено в хранилище (inline base64 в data).
export function isInlineFileValue(v: unknown): v is StoredFile | StoredZip {
	if (!v || typeof v !== 'object') return false;
	const obj = v as Record<string, any>;
	return typeof obj.data === 'string' && obj.data.length > 0 && typeof obj.fileId !== 'string';
}

// MIME-тип значения файлового поля (у StoredZip его нет — это архив).
function fileTypeOf(v: StoredFile | StoredZip): string {
	if (Array.isArray((v as StoredZip).files)) return 'application/zip';
	return (v as StoredFile).type ?? 'application/octet-stream';
}

// Размер в байтах (у StoredZip нет size — оцениваем по длине base64).
function fileSizeOf(v: StoredFile | StoredZip): number {
	if (typeof (v as StoredFile).size === 'number') return (v as StoredFile).size;
	return Math.floor(v.data.length * 0.75);
}

// Ссылка на вынесенный файл (вместо base64 в record.data).
export function toFileRef(v: StoredFile | StoredZip, fileId: string): FileRef {
	const ref: FileRef = {
		name: v.name,
		size: fileSizeOf(v),
		type: fileTypeOf(v),
		fileId
	};
	if (Array.isArray((v as StoredZip).files)) ref.files = (v as StoredZip).files;
	return ref;
}

// Содержимое вложения из локального хранилища (null — если ещё не скачано).
export async function getFileContent(fileId: string): Promise<string | null> {
	if (!fileId) return null;
	const row = await db.data_files.get(fileId);
	return row?.content ?? null;
}

// Развернуть ссылку обратно в inline-значение (для UI и кода действий).
export async function hydrateFileValue(v: unknown): Promise<StoredFile | StoredZip | null> {
	if (!isFileRef(v)) return null;
	const content = await getFileContent(v.fileId);
	if (content == null) return null;
	const out: Record<string, any> = {
		name: v.name,
		size: v.size,
		type: v.type ?? 'application/octet-stream',
		data: content
	};
	if (Array.isArray(v.files)) out.files = v.files;
	return (Array.isArray(v.files) ? out : out) as StoredFile | StoredZip;
}

// Скопировать объект, заменив ссылки на вложения их содержимым (для кода
// действий «Выполнить»: record.data.file.data должен быть доступен как раньше).
export async function hydrateFilesInObject(obj: Record<string, any>): Promise<Record<string, any>> {
	const out: Record<string, any> = { ...obj };
	for (const key of Object.keys(out)) {
		const v = out[key];
		if (!isFileRef(v)) continue;
		const hydrated = await hydrateFileValue(v);
		if (hydrated) out[key] = hydrated;
	}
	return out;
}

// Вынести inline-вложения записи в хранилище data_files. Возвращает копию
// record.data, где у файловых полей вместо base64 — ссылка { fileId }.
// Идемпотентно: неизменённые файлы переиспользуют существующий fileId
// (сверка по содержимому колонки), удалённые — вычищаются из хранилища.
export async function externalizeFilesInObject(
	obj: Record<string, any>,
	recordId: string
): Promise<Record<string, any>> {
	const out: Record<string, any> = { ...obj };
	if (!recordId) return out;

	const existing = await db.data_files.where('record_id').equals(recordId).toArray();
	const byColumn = new Map(existing.map((f) => [f.column_id, f]));
	const keptIds = new Set<string>();
	const toPut: LocalFile[] = [];
	const now = new Date().toISOString();

	for (const key of Object.keys(out)) {
		const v = out[key];
		if (isFileRef(v)) {
			// Уже ссылка: хранилище должно сохранить содержимое.
			if (v.fileId && (await db.data_files.get(v.fileId))) keptIds.add(v.fileId);
			continue;
		}
		if (!isInlineFileValue(v)) continue;

		const prev = byColumn.get(key);
		const fileId = prev && prev.content === v.data ? prev.id : crypto.randomUUID();
		toPut.push({
			id: fileId,
			record_id: recordId,
			column_id: key,
			name: v.name,
			size: fileSizeOf(v),
			type: fileTypeOf(v),
			content: v.data,
			updated_at: now
		});
		keptIds.add(fileId);
		out[key] = toFileRef(v, fileId);
	}

	if (toPut.length > 0) await db.data_files.bulkPut(toPut);
	const orphans = existing.filter((f) => !keptIds.has(f.id)).map((f) => f.id);
	if (orphans.length > 0) await db.data_files.bulkDelete(orphans);
	return out;
}

// Клонирование вложений для копии записи: каждому файлу — новый fileId (копия
// и оригинал независимы). Принимает данные с ref- или inline-значениями,
// возвращает копию с новыми ссылками на хранилище.
export async function copyFilesInObject(
	obj: Record<string, any>,
	recordId: string
): Promise<Record<string, any>> {
	const out: Record<string, any> = { ...obj };
	for (const key of Object.keys(out)) {
		const v = out[key];
		if (isInlineFileValue(v)) {
			const fileId = crypto.randomUUID();
			await db.data_files.put({
				id: fileId,
				record_id: recordId,
				column_id: key,
				name: v.name,
				size: fileSizeOf(v),
				type: fileTypeOf(v),
				content: v.data,
				updated_at: new Date().toISOString()
			});
			out[key] = toFileRef(v, fileId);
		} else if (isFileRef(v)) {
			const content = await getFileContent(v.fileId);
			if (content == null) continue;
			const fileId = crypto.randomUUID();
			await db.data_files.put({
				id: fileId,
				record_id: recordId,
				column_id: key,
				name: v.name,
				size: v.size,
				type: v.type ?? 'application/octet-stream',
				content,
				updated_at: new Date().toISOString()
			});
			out[key] = { ...v, fileId };
		}
	}
	return out;
}
