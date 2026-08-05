import {
	db,
	type LocalColumn,
	type LocalLine,
	type LocalRecord,
	type LocalTable
} from '$lib/db/indexeddb';

// Единая схема глубоких ссылок приложения (hash-часть URL).
//   #/t/{tableId}   — список таблицы (по id или имени)
//   #/r/{recordId}  — форма записи
//   #/l/{lineId}    — форма родительской записи с выделенной строкой табличной части
export type DeepLink =
	| { kind: 'list'; tableId: string }
	| { kind: 'record'; recordId: string }
	| { kind: 'line'; lineId: string };

export type ResolvedLink =
	| { kind: 'list'; table: LocalTable; columns: LocalColumn[]; records: LocalRecord[] }
	| {
			kind: 'record';
			table: LocalTable;
			columns: LocalColumn[];
			record: LocalRecord;
			lines: LocalLine[];
	  }
	| {
			kind: 'line';
			table: LocalTable;
			columns: LocalColumn[];
			record: LocalRecord;
			lines: LocalLine[];
			line: LocalLine;
			subTable: LocalTable | null;
	  };

// Разбор hash-части URL в структуру DeepLink. Принимает и полный URL, и только hash.
export function parseHash(hash: string): DeepLink | null {
	let h = hash.trim();
	const hashIdx = h.indexOf('#');
	if (hashIdx !== -1) h = h.slice(hashIdx + 1);
	h = h.replace(/^\//, '');
	const parts = h.split('/').filter(Boolean);
	if (parts.length < 2) return null;
	const [kind, rawId] = parts;
	let id = rawId;
	try {
		id = decodeURIComponent(rawId);
	} catch {
		// оставляем как есть, если невалидный percent-encoding
	}
	if (kind === 't') return { kind: 'list', tableId: id };
	if (kind === 'r') return { kind: 'record', recordId: id };
	if (kind === 'l') return { kind: 'line', lineId: id };
	return null;
}

// Сборка hash-части URL из структуры DeepLink.
export function buildUrl(link: DeepLink): string {
	switch (link.kind) {
		case 'list':
			return `#/t/${encodeURIComponent(link.tableId)}`;
		case 'record':
			return `#/r/${encodeURIComponent(link.recordId)}`;
		case 'line':
			return `#/l/${encodeURIComponent(link.lineId)}`;
	}
}

// Полный URL для копирования в буфер (hash-часть + текущий адрес приложения).
export function fullUrlFor(link: DeepLink | string): string {
	const hash = typeof link === 'string' ? link : buildUrl(link);
	return `${location.origin}${location.pathname}${location.search}${hash}`;
}

// Удобные обёртки для генерации ссылок.
export const buildListUrl = (tableId: string): string => buildUrl({ kind: 'list', tableId });
export const buildRecordUrl = (recordId: string): string => buildUrl({ kind: 'record', recordId });
export const buildLineUrl = (lineId: string): string => buildUrl({ kind: 'line', lineId });

// Поиск таблицы по id или уникальному имени (name).
async function findTable(idOrName: string): Promise<LocalTable | null> {
	const byId = await db.meta_tables.get(idOrName);
	if (byId) return byId;
	return (await db.meta_tables.where('name').equals(idOrName).first()) ?? null;
}

// Получение «значений» по ссылке: данные целиком из IndexedDB, без сети.
// Возвращает null, если объект (или его таблица) не найден.
export async function resolveLink(link: DeepLink): Promise<ResolvedLink | null> {
	try {
		if (link.kind === 'list') {
			const table = await findTable(link.tableId);
			if (!table) return null;
			const columns = await db.meta_columns.where('table_id').equals(table.id).sortBy('sort_order');
			const records = await db.data_records.where('table_id').equals(table.id).toArray();
			return { kind: 'list', table, columns, records };
		}

		if (link.kind === 'record') {
			const record = await db.data_records.get(link.recordId);
			if (!record) return null;
			const table = (await db.meta_tables.get(record.table_id)) ?? null;
			if (!table) return null;
			const columns = await db.meta_columns.where('table_id').equals(table.id).sortBy('sort_order');
			const lines = await db.data_lines.where('record_id').equals(record.id).toArray();
			return { kind: 'record', table, columns, record, lines };
		}

		const line = await db.data_lines.get(link.lineId);
		if (!line) return null;
		const record = line.record_id ? ((await db.data_records.get(line.record_id)) ?? null) : null;
		if (!record) return null;
		const table = (await db.meta_tables.get(record.table_id)) ?? null;
		if (!table) return null;
		const subTable = line.table_id ? ((await db.meta_tables.get(line.table_id)) ?? null) : null;
		const columns = await db.meta_columns.where('table_id').equals(table.id).sortBy('sort_order');
		const lines = await db.data_lines.where('record_id').equals(record.id).toArray();
		return { kind: 'line', table, columns, record, lines, line, subTable };
	} catch (err) {
		console.error('Ошибка разрешения ссылки:', err);
		return null;
	}
}

// Разбор и разрешение ссылки одним вызовом (удобно для runCode: link.get(href)).
export async function resolveUrl(hashOrUrl: string): Promise<ResolvedLink | null> {
	const link = parseHash(hashOrUrl);
	return link ? resolveLink(link) : null;
}

// Хелпер для пользовательского кода действий «Выполнить» (runActionCode).
// Доступен как переменная `link`:
//   link.url('record', recordId)  -> "#/r/..."   (сгенерировать ссылку)
//   link.table(idOrName)          -> "#/t/..."
//   link.line(lineId)             -> "#/l/..."
//   await link.get(href)          -> данные { table, columns, record, lines, ... }
export const linkApi = {
	url: (kind: DeepLink['kind'], id: string): string =>
		buildUrl(
			kind === 'list'
				? { kind, tableId: id }
				: kind === 'record'
					? { kind, recordId: id }
					: { kind, lineId: id }
		),
	table: (tableId: string): string => buildListUrl(tableId),
	record: (recordId: string): string => buildRecordUrl(recordId),
	line: (lineId: string): string => buildLineUrl(lineId),
	get: (hashOrUrl: string): Promise<ResolvedLink | null> => resolveUrl(hashOrUrl)
};
