import { supabase } from '$lib/db/supabase';
import { db, type LocalColumn, type LocalRecord } from '$lib/db/indexeddb';

// Нейтральные утилиты идемпотентного сидинга таблиц. Не знают ни про один
// конкретный модуль (банки, уведомления, сценарии и т.д.) — только про
// meta_tables/meta_columns/data_records. Раньше жили в notifications.ts, откуда
// их импортировали все модули; вынесены, чтобы движок не зависел от уведомлений.

export type ColumnSeed = Omit<LocalColumn, 'id' | 'table_id'>;

// Создать таблицу (Supabase + локальный кэш), если её нет. Возвращает её id.
// Локально приводим к одной канонической строке по name (как «История»),
// чтобы уникальный индекс name в IndexedDB не выдавал ConstraintError.
export async function ensureTable(
	name: string,
	title: string,
	type: string,
	config: Record<string, any>,
	parentTableId: string | null = null
): Promise<string> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	let tableId: string | null = null;
	if (online) {
		try {
			const { data } = await supabase
				.from('meta_tables')
				.select('id')
				.eq('name', name)
				.order('id', { ascending: true })
				.limit(1);
			tableId = data?.[0]?.id ?? null;
		} catch {
			tableId = null;
		}
	}

	if (!tableId) {
		try {
			const { data, error } = await supabase
				.from('meta_tables')
				.insert([{ name, title, type, parent_table_id: parentTableId, config }])
				.select()
				.single();
			if (!error && data) tableId = data.id;
		} catch {
			tableId = null;
		}
	}

	// Серверные дубликаты имени: переносим их колонки и данные в каноническую
	// таблицу и удаляем, иначе pullMetadata (он очищает локальный кэш и тянет всё
	// с сервера) будет возвращать дубликат в кэш, и у записи появится лишняя
	// пустая табличная часть.
	if (tableId && online) {
		try {
			const { data: allRows } = await supabase.from('meta_tables').select('id').eq('name', name);
			const dups = (allRows ?? []).filter((t) => t.id !== tableId);
			for (const dup of dups) {
				await supabase.from('meta_columns').update({ table_id: tableId }).eq('table_id', dup.id);
				await supabase.from('data_records').update({ table_id: tableId }).eq('table_id', dup.id);
				await supabase.from('data_lines').update({ table_id: tableId }).eq('table_id', dup.id);
				await supabase.from('meta_tables').delete().eq('id', dup.id);
			}
		} catch {
			// сервер недоступен — дубликат уберётся при следующем цикле
		}
	}

	const localRows = await db.meta_tables.where('name').equals(name).toArray();
	const localCanonical = localRows.find((r) => r.id === tableId) ?? localRows[0] ?? null;
	const effectiveId = tableId ?? localCanonical?.id ?? crypto.randomUUID();

	await db.transaction(
		'rw',
		[db.meta_tables, db.meta_columns, db.data_records, db.data_lines],
		async () => {
			for (const row of localRows) {
				if (row.id === effectiveId) continue;
				await db.data_records.where('table_id').equals(row.id).modify({ table_id: effectiveId });
				await db.data_lines.where('table_id').equals(row.id).modify({ table_id: effectiveId });
				await db.meta_columns.where('table_id').equals(row.id).delete();
				await db.meta_tables.delete(row.id);
			}
			await db.meta_tables.put({
				id: effectiveId,
				name,
				title,
				type,
				parent_table_id: parentTableId,
				config
			});
		}
	);

	return effectiveId;
}

// Колонки таблицы: проверяет и создаёт недостающие на сервере (если онлайн)
// и локально. Идемпотентно — добавляются только отсутствующие по name, поэтому
// новые колонки (например, «Прокси») появляются и у уже существующей таблицы.
export async function ensureColumns(
	tableId: string,
	columns: ColumnSeed[],
	online: boolean
): Promise<void> {
	if (online) {
		try {
			const { data: existingCols } = await supabase
				.from('meta_columns')
				.select('name')
				.eq('table_id', tableId);
			const existingNames = new Set((existingCols ?? []).map((c) => c.name));
			const missing = columns.filter((c) => !existingNames.has(c.name));
			if (missing.length > 0) {
				await supabase
					.from('meta_columns')
					.insert(missing.map((c) => ({ table_id: tableId, ...c })));
			}
		} catch {
			// сервер недоступен — достаточно локальной копии
		}
	}

	const localCols = await db.meta_columns.where('table_id').equals(tableId).toArray();
	const localNames = new Set(localCols.map((c) => c.name));
	const missingLocal = columns.filter((c) => !localNames.has(c.name));
	if (missingLocal.length > 0) {
		await db.meta_columns.bulkPut(
			missingLocal.map((c) => ({ id: crypto.randomUUID(), table_id: tableId, ...c }))
		);
	}
}

// Запись в локальный кэш (и на сервер, если онлайн). is_dirty=1 — в ближайшем
// цикле синка запись уедет в Supabase через обычный pushLocalChanges.
export async function seedRecord(record: LocalRecord, online: boolean): Promise<void> {
	await db.data_records.put(record);
	if (online) {
		try {
			await supabase.from('data_records').upsert(record);
		} catch {
			// сервер недоступен — запись уедет при ближайшем синке
		}
	}
}

// Есть ли на сервере записи таблицы. Онлайн-сид сверяется с сервером, чтобы
// после очистки локального кэша не плодить дубликаты каналов/сервисов.
export async function hasServerRows(tableId: string, online: boolean): Promise<boolean> {
	if (!online) return false;
	try {
		const { count } = await supabase
			.from('data_records')
			.select('id', { count: 'exact', head: true })
			.eq('table_id', tableId);
		return (count ?? 0) > 0;
	} catch {
		return false; // сервер недоступен — сидим локально, уедет при ближайшем синке
	}
}

// id таблицы по name (сначала сервер, потом локальный кэш). Для «Контрагентов»:
// таблица существует на сервере, но в пустом локальном кэше её ещё может не быть.
export async function findTableIdByName(name: string): Promise<string | null> {
	const online = typeof navigator === 'undefined' || navigator.onLine;
	if (online) {
		try {
			const { data } = await supabase
				.from('meta_tables')
				.select('id')
				.eq('name', name)
				.order('id', { ascending: true })
				.limit(1);
			if (data?.[0]?.id) return data[0].id;
		} catch {
			// сервер недоступен
		}
	}
	const local = await db.meta_tables.where('name').equals(name).first();
	return local?.id ?? null;
}
