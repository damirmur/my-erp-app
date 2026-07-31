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

// Сохранение изменённой кодом записи: локально (is_dirty=1) + строки ТЧ.
// Серверная синхронизация произойдёт в ближайшем цикле sync.
export async function saveRecordWithLines(record: LocalRecord, lines?: LocalLine[]): Promise<void> {
	await db.transaction('rw', [db.data_records, db.data_lines], async () => {
		await db.data_records.put({
			...record,
			is_dirty: 1,
			updated_at: new Date().toISOString()
		});
		if (lines) {
			await db.data_lines.bulkPut(lines.map((l) => ({ ...l })));
		}
	});
}
