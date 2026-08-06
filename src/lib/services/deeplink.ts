import {
	db,
	type LocalColumn,
	type LocalLine,
	type LocalRecord,
	type LocalTable
} from '$lib/db/indexeddb';

// Единая схема глубоких ссылок приложения (hash-часть URL).
//   #/t/{tableId}          — список таблицы (по id или имени)
//   #/r/{recordId}         — форма записи
//   #/l/{lineId}           — форма родительской записи с выделенной строкой табличной части
//   #/t/{tableId}.json     — список таблицы как JSON (API-режим, без открытия формы)
//   #/r/{recordId}.json    — запись (+ строки ТЧ) как JSON (API-режим)
//   #/r/{recordId}.execute.json          — выполнить код действия таблицы по записи, результат JSON
//   #/r/{recordId}.execute({a:1}).json   — то же, с входными параметрами (доступны как `params`)
export type DeepLink =
	| { kind: 'list'; tableId: string }
	| { kind: 'listJson'; tableId: string }
	| { kind: 'record'; recordId: string }
	| { kind: 'recordJson'; recordId: string }
	| { kind: 'execute'; recordId: string; params: Record<string, any> }
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

// Разбор JS-подобного объектного литерала из ссылки в объект параметров.
// Принимает и строгий JSON ({"city":"Orenburg"}), и краткую запись с ключами
// и строковыми значениями без кавычек ({city:Orenburg}). Безопасен: без eval.
export function parseParamsLiteral(src: string): Record<string, any> {
	const text = (src ?? '').trim();
	if (!text) return {};
	let pos = 0;

	function skipWs() {
		while (pos < text.length && /\s/.test(text[pos])) pos++;
	}

	function parseString(quote: string): string {
		pos++; // открывающая кавычка
		let out = '';
		while (pos < text.length && text[pos] !== quote) {
			if (text[pos] === '\\' && pos + 1 < text.length) {
				out += text[pos + 1];
				pos += 2;
			} else {
				out += text[pos];
				pos++;
			}
		}
		pos++; // закрывающая кавычка
		return out;
	}

	function parseValue(): any {
		skipWs();
		const ch = text[pos];
		if (ch === '{') return parseObject();
		if (ch === '[') return parseArray();
		if (ch === '"' || ch === "'") return parseString(ch);
		const start = pos;
		while (pos < text.length && !/[\s,}\]:]/.test(text[pos])) pos++;
		const raw = text.slice(start, pos);
		if (raw === 'true') return true;
		if (raw === 'false') return false;
		if (raw === 'null' || raw === '') return null;
		if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
		return raw; // голый идентификатор — строка
	}

	function parseObject(): Record<string, any> {
		pos++; // {
		const obj: Record<string, any> = {};
		skipWs();
		if (text[pos] === '}') {
			pos++;
			return obj;
		}
		for (;;) {
			const key = parseValue();
			skipWs();
			if (text[pos] === ':') pos++;
			obj[String(key)] = parseValue();
			skipWs();
			if (text[pos] === ',') {
				pos++;
				continue;
			}
			if (text[pos] === '}') {
				pos++;
				break;
			}
			break;
		}
		return obj;
	}

	function parseArray(): any[] {
		pos++; // [
		const arr: any[] = [];
		skipWs();
		if (text[pos] === ']') {
			pos++;
			return arr;
		}
		for (;;) {
			arr.push(parseValue());
			skipWs();
			if (text[pos] === ',') {
				pos++;
				continue;
			}
			if (text[pos] === ']') {
				pos++;
				break;
			}
			break;
		}
		return arr;
	}

	try {
		const value = parseValue();
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

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
	if (kind === 't') {
		const listJson = id.match(/^(.*)\.json$/);
		return listJson ? { kind: 'listJson', tableId: listJson[1] } : { kind: 'list', tableId: id };
	}
	if (kind === 'r') {
		const execute = id.match(/^(.*)\.execute(?:\(([^)]*)\))?\.json$/);
		if (execute) {
			return {
				kind: 'execute',
				recordId: execute[1],
				params: parseParamsLiteral(execute[2] ?? '')
			};
		}
		const recordJson = id.match(/^(.*)\.json$/);
		return recordJson
			? { kind: 'recordJson', recordId: recordJson[1] }
			: { kind: 'record', recordId: id };
	}
	if (kind === 'l') return { kind: 'line', lineId: id };
	return null;
}

// Сборка hash-части URL из структуры DeepLink.
export function buildUrl(link: DeepLink): string {
	switch (link.kind) {
		case 'list':
			return `#/t/${encodeURIComponent(link.tableId)}`;
		case 'listJson':
			return `#/t/${encodeURIComponent(link.tableId)}.json`;
		case 'record':
			return `#/r/${encodeURIComponent(link.recordId)}`;
		case 'recordJson':
			return `#/r/${encodeURIComponent(link.recordId)}.json`;
		case 'execute':
			return `#/r/${encodeURIComponent(link.recordId)}.execute(${JSON.stringify(link.params)}).json`;
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
export const buildListJsonUrl = (tableId: string): string =>
	buildUrl({ kind: 'listJson', tableId });
export const buildRecordJsonUrl = (recordId: string): string =>
	buildUrl({ kind: 'recordJson', recordId });
export const buildExecuteUrl = (recordId: string, params: Record<string, any> = {}): string =>
	buildUrl({ kind: 'execute', recordId, params });

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

		// Новые API-виды (#/t/{id}.json, #/r/{id}.json, #/r/{id}.execute(...).json)
		// в resolveLink не разрешаются — для них есть runApiCommand (apiCommand.ts).
		if (link.kind !== 'line') return null;

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
//   link.execute(recordId, params?) -> "#/r/{id}.execute({...}).json"
//   link.recordJson(recordId)     -> "#/r/{id}.json"
//   link.listJson(tableId)        -> "#/t/{id}.json"
//   await link.get(href)          -> данные { table, columns, record, lines, ... }
export const linkApi = {
	url: (kind: DeepLink['kind'], id: string): string => buildUrl(linkFor(kind, id)),
	table: (tableId: string): string => buildListUrl(tableId),
	record: (recordId: string): string => buildRecordUrl(recordId),
	line: (lineId: string): string => buildLineUrl(lineId),
	execute: (recordId: string, params: Record<string, any> = {}): string =>
		buildExecuteUrl(recordId, params),
	recordJson: (recordId: string): string => buildRecordJsonUrl(recordId),
	listJson: (tableId: string): string => buildListJsonUrl(tableId),
	get: (hashOrUrl: string): Promise<ResolvedLink | null> => resolveUrl(hashOrUrl)
};

function linkFor(kind: DeepLink['kind'], id: string): DeepLink {
	switch (kind) {
		case 'list':
			return { kind, tableId: id };
		case 'listJson':
			return { kind, tableId: id };
		case 'record':
			return { kind, recordId: id };
		case 'recordJson':
			return { kind, recordId: id };
		case 'execute':
			return { kind, recordId: id, params: {} };
		case 'line':
			return { kind, lineId: id };
	}
}
