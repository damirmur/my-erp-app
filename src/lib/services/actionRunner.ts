import { db, type LocalLine, type LocalRecord } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';

// Контекст, передаваемый в пользовательский код действия «Выполнить».
// Доступно из кода: record, records, lines, db, supabase, save(), log().
export interface RunActionContext {
	record: LocalRecord | null; // Текущая запись (в форме — открытая; в списке — первая выбранная)
	records: LocalRecord[]; // Выбранные записи (в форме — [record])
	lines: LocalLine[]; // Строки табличных частей текущей записи (если есть)
	db: typeof db;
	supabase: typeof supabase;
	save: (record: LocalRecord, lines?: LocalLine[]) => Promise<void>;
	log: (...args: unknown[]) => void;
}

// Выполнение JS-кода действия в браузере. Код — тело async-функции.
// Переменные контекста (record, records, lines, db, supabase, save, log)
// доступны в коде как локальные имена без префикса ctx.
export async function runActionCode(code: string, ctx: RunActionContext): Promise<unknown> {
	const paramNames = ['record', 'records', 'lines', 'db', 'supabase', 'save', 'log'];
	const values = paramNames.map((k) => (ctx as unknown as Record<string, unknown>)[k]);
	const fn = new Function(...paramNames, `return (async () => {\n${code}\n})();`);
	return await fn(...values);
}

// Глубокая копия без Svelte-прокси и ссылок на реактивные объекты:
// IndexedDB не может структурировано клонировать $state-прокси (DataCloneError).
function toPlain(value: unknown): any {
	if (Array.isArray(value)) return value.map(toPlain);
	if (value instanceof Date) return new Date(value.getTime());
	if (value && typeof value === 'object') {
		const out: Record<string, any> = {};
		for (const key of Object.keys(value as Record<string, any>)) {
			out[key] = toPlain((value as Record<string, any>)[key]);
		}
		return out;
	}
	return value;
}

// Сохранение изменённой кодом записи: локально (is_dirty=1) + строки ТЧ.
// Серверная синхронизация произойдёт в ближайшем цикле sync.
export async function saveRecordWithLines(record: LocalRecord, lines?: LocalLine[]): Promise<void> {
	await db.transaction('rw', [db.data_records, db.data_lines], async () => {
		await db.data_records.put({
			...record,
			data: toPlain(record.data),
			is_dirty: 1,
			updated_at: new Date().toISOString()
		});
		if (lines) {
			await db.data_lines.bulkPut(
				lines.map((l) => ({
					...l,
					data: toPlain(l.data)
				}))
			);
		}
	});
}
