import { supabase } from '$lib/db/supabase';
import { db, type LocalColumn } from '$lib/db/indexeddb';
import { getTableType } from '$lib/table-types';
import { ensureNotificationTables } from '$lib/state/notifications';
import { ensureSchedulerTables } from '$lib/state/scheduler';

// Имя системной таблицы-истории действий. Уникально в meta_tables, используется
// для поиска таблицы и в recordHistory/clearHistory/сайдбаре.
export const HISTORY_TABLE_NAME = 'history';

// Колонки системной таблицы «История». В Supabase type — enum column_type,
// который не содержит 'datetime'/'birth', поэтому для времени используем 'date'
// (в data.opened_at храним полную ISO-метку; отображение и сортировка —
// в DynamicList).
const HISTORY_COLUMNS: Omit<LocalColumn, 'id' | 'table_id'>[] = [
	{ name: 'object_title', title: 'Объект', type: 'string', sort_order: 1, is_visible: true },
	{ name: 'opened_at', title: 'Когда', type: 'date', sort_order: 2, is_visible: true },
	{ name: 'link', title: 'Ссылка', type: 'string', sort_order: 3, is_visible: false }
];

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_|_$/g, '');
	return slug || `tbl_${Date.now().toString(36)}`;
}

class MetadataManager {
	// Гарантировать наличие системных таблиц (сейчас — только «История»).
	// Идемпотентно: ищет таблицу по name, создаёт в Supabase (если онлайн) и
	// всегда синхронизирует в локальный кэш IndexedDB (для офлайн-режима).
	// Вызывается при старте приложения и в начале каждого цикла синхронизации.
	async ensureSystemTables(): Promise<void> {
		const online = typeof navigator !== 'undefined' && navigator.onLine;

		// 1. Найти или создать таблицу в Supabase. Ищем по name; если на сервере
		// завелись дубликаты (старые версии) — берём первый, остальные подчистит
		// pullMetadata при загрузке.
		let tableId: string | null = null;
		try {
			const { data } = await supabase
				.from('meta_tables')
				.select('id')
				.eq('name', HISTORY_TABLE_NAME)
				.order('id', { ascending: true })
				.limit(1);
			tableId = data?.[0]?.id ?? null;
		} catch {
			tableId = null;
		}

		if (!tableId) {
			try {
				const { data, error } = await supabase
					.from('meta_tables')
					.insert([
						{
							name: HISTORY_TABLE_NAME,
							title: 'История',
							type: 'system',
							config: { hiddenInMain: true }
						}
					])
					.select()
					.single();
				if (!error && data) tableId = data.id;
			} catch {
				tableId = null;
			}
		}

		// Самоочистка: если на сервере завелись дубликаты history (старые версии
		// создавали их при каждом старте), удаляем лишние — но только те, у которых
		// нет реквизитов (иначе упрёмся во внешний ключ).
		if (online && tableId) {
			try {
				const { data: dupRows } = await supabase
					.from('meta_tables')
					.select('id')
					.eq('name', HISTORY_TABLE_NAME);
				const extras = (dupRows ?? []).map((r) => r.id).filter((id) => id !== tableId);
				if (extras.length > 0) {
					const { data: usedCols } = await supabase
						.from('meta_columns')
						.select('table_id')
						.in('table_id', extras);
					const used = new Set((usedCols ?? []).map((r) => r.table_id));
					const deletable = extras.filter((id) => !used.has(id));
					if (deletable.length > 0) await supabase.from('meta_tables').delete().in('id', deletable);
				}
			} catch {
				// не критично — дубликаты не сломают работу (их отфильтрует pullMetadata)
			}
		}

		// 2. Локальный кэш: приводим к одной канонической строке с name = 'history'.
		// Офлайн-сиды могли создать строку с другим id — их записи переносим на
		// каноническую, а дубликат удаляем. Иначе уникальный индекс name в
		// IndexedDB будет выдавать ConstraintError при каждой записи.
		const localRows = await db.meta_tables.where('name').equals(HISTORY_TABLE_NAME).toArray();
		const localCanonical = localRows.find((r) => r.id === tableId) ?? localRows[0] ?? null;
		const effectiveId = tableId ?? localCanonical?.id ?? crypto.randomUUID();

		await db.transaction('rw', [db.meta_tables, db.meta_columns, db.data_records], async () => {
			for (const row of localRows) {
				if (row.id === effectiveId) continue;
				// Сохраняем историю: переносим записи на каноническую таблицу
				await db.data_records.where('table_id').equals(row.id).modify({ table_id: effectiveId });
				// Дубликат метаданных и его реквизиты убираем
				await db.meta_columns.where('table_id').equals(row.id).delete();
				await db.meta_tables.delete(row.id);
			}
			await db.meta_tables.put({
				id: effectiveId,
				name: HISTORY_TABLE_NAME,
				title: 'История',
				type: 'system',
				config: { hiddenInMain: true }
			});
		});

		await this.ensureHistoryColumns(effectiveId, online);

		// Справочники и документ модуля уведомлений (провайдеры, каналы, получатели, сообщения).
		// Идемпотентно создаются так же, как «История»: при старте и перед каждым синком.
		await ensureNotificationTables();

		// Документ «Расписание» для периодической рассылки (например, погоды).
		// Исполняет Go-сервер 24/7; здесь создаются только метаданные таблиц.
		await ensureSchedulerTables();
	}

	// Колонки истории: проверяет и создаёт на сервере (если онлайн) и локально.
	private async ensureHistoryColumns(tableId: string, online: boolean): Promise<void> {
		if (online) {
			try {
				const { data: existingCols } = await supabase
					.from('meta_columns')
					.select('id')
					.eq('table_id', tableId);
				if (!existingCols || existingCols.length === 0) {
					await supabase
						.from('meta_columns')
						.insert(HISTORY_COLUMNS.map((c) => ({ table_id: tableId, ...c })));
				}
			} catch {
				// сервер недоступен — достаточно локальной копии
			}
		}

		const localCols = await db.meta_columns.where('table_id').equals(tableId).toArray();
		if (localCols.length === 0) {
			await db.meta_columns.bulkPut(
				HISTORY_COLUMNS.map((c) => ({ id: crypto.randomUUID(), table_id: tableId, ...c }))
			);
		}
	}

	async createNewTable(
		title: string,
		type: string,
		name?: string,
		parentTableId: string | null = null,
		config?: Record<string, any>
	): Promise<string | null> {
		const slug = name || slugify(title);
		const { data, error } = await supabase
			.from('meta_tables')
			.insert([
				{
					name: slug,
					title,
					type,
					parent_table_id: parentTableId,
					config: config ?? {}
				}
			])
			.select()
			.single();

		if (error) {
			alert(`Ошибка: ${error.message}`);
			return null;
		}

		if (data && !parentTableId) {
			const template = getTableType(type).fields ?? [];
			if (template.length > 0) {
				// Поля по шаблону типа (в т.ч. кастомные типы)
				await supabase.from('meta_columns').insert(
					template.map((f, i) => ({
						table_id: data.id,
						name: f.name,
						title: f.title,
						type: f.type,
						sort_order: i + 1
					}))
				);
			} else {
				// Базовые реквизиты создаем только для независимых объектов
				await supabase.from('meta_columns').insert([
					{
						table_id: data.id,
						name: 'number',
						title: type === 'document' ? 'Номер' : 'Код',
						type: 'string',
						sort_order: 1
					},
					{
						table_id: data.id,
						name: 'name',
						title: type === 'document' ? 'Содержание' : 'Наименование',
						type: 'string',
						sort_order: 2
					}
				]);
			}
		}
		return data ? data.id : null;
	}

	// Явное удаление реквизита объекта
	async deleteColumn(columnId: string) {
		const { error } = await supabase.from('meta_columns').delete().eq('id', columnId);
		if (error) alert(`Ошибка удаления поля: ${error.message}`);
		else alert('Реквизит успешно удален из метаданных!');
	}

	// Удаление реквизита без всплывающих уведомлений (для пакетного сохранения)
	async deleteColumnQuiet(columnId: string) {
		const { error } = await supabase.from('meta_columns').delete().eq('id', columnId);
		if (error) alert(`Ошибка удаления поля: ${error.message}`);
	}

	// Каскадное удаление таблицы вместе с её табличными частями, реквизитами и данными
	async deleteTableCascade(tableId: string) {
		const { data: subs } = await supabase
			.from('meta_tables')
			.select('id')
			.eq('parent_table_id', tableId);
		const subIds = (subs ?? []).map((s) => s.id);
		const allIds = [...subIds, tableId];

		// Данные (записи и табличные части) удаляем до метаданных — из-за внешних ключей,
		// а также из локального кэша, чтобы они не остались is_dirty и не сломали push
		const { error: lineErr } = await supabase.from('data_lines').delete().in('table_id', allIds);
		if (lineErr) alert(`Ошибка удаления строк ТЧ: ${lineErr.message}`);
		const { error: recErr } = await supabase.from('data_records').delete().in('table_id', allIds);
		if (recErr) alert(`Ошибка удаления данных: ${recErr.message}`);
		await db.data_lines.where('table_id').anyOf(allIds).delete();
		await db.data_records.where('table_id').anyOf(allIds).delete();

		for (const sid of subIds) {
			const { error } = await supabase.from('meta_columns').delete().eq('table_id', sid);
			if (error) alert(`Ошибка удаления реквизитов ТЧ: ${error.message}`);
		}
		const { error: colErr } = await supabase.from('meta_columns').delete().eq('table_id', tableId);
		if (colErr) alert(`Ошибка удаления реквизитов: ${colErr.message}`);

		const { error: subErr } = await supabase.from('meta_tables').delete().in('id', allIds);
		if (subErr) alert(`Ошибка удаления таблицы: ${subErr.message}`);
	}

	async saveOrUpdateColumn(
		tableId: string,
		colId: string | 'new',
		columnData: {
			name: string;
			title: string;
			type: string;
			sort_order: number;
			related_table_id?: string | null;
			is_visible?: boolean;
		}
	) {
		let result;
		if (colId === 'new') {
			result = await supabase.from('meta_columns').insert([{ table_id: tableId, ...columnData }]);
		} else {
			result = await supabase.from('meta_columns').update(columnData).eq('id', colId);
		}
		if (result.error) alert(`Ошибка сохранения реквизита: ${result.error.message}`);
	}

	// Переключение видимости реквизита в журнале (пишем сразу на сервер и в локальный кэш,
	// чтобы изменение не было затёрто следующим pullMetadata)
	async setColumnVisibility(colId: string, is_visible: boolean) {
		const { error } = await supabase.from('meta_columns').update({ is_visible }).eq('id', colId);
		if (error) {
			alert(`Ошибка сохранения видимости: ${error.message}`);
			return false;
		}
		const col = await db.meta_columns.get(colId);
		if (col) await db.meta_columns.put({ ...col, is_visible });
		return true;
	}

	async updateTableConfig(tableId: string, config: Record<string, any>): Promise<string | null> {
		const { error } = await supabase.from('meta_tables').update({ config }).eq('id', tableId);
		if (error) {
			alert(`Ошибка сохранения настроек: ${error.message}`);
			return null;
		}
		return tableId;
	}

	// Обновление синонима (заголовка) таблицы
	async updateTableTitle(tableId: string, title: string) {
		const { error } = await supabase.from('meta_tables').update({ title }).eq('id', tableId);
		if (error) alert(`Ошибка сохранения синонима: ${error.message}`);
	}

	async deleteTable(tableId: string) {
		// Удаляем и строки ТЧ таблицы (записей у подтаблиц не бывает),
		// чтобы они не остались в локальном кэше и не сломали push
		const { error: lineErr } = await supabase.from('data_lines').delete().eq('table_id', tableId);
		if (lineErr) alert(`Ошибка удаления строк ТЧ: ${lineErr.message}`);
		await db.data_lines.where('table_id').equals(tableId).delete();
		const { error } = await supabase.from('meta_tables').delete().eq('id', tableId);
		if (error) alert(`Ошибка удаления таблицы: ${error.message}`);
	}

	async deleteColumnsByTable(tableId: string) {
		const { error } = await supabase.from('meta_columns').delete().eq('table_id', tableId);
		if (error) alert(`Ошибка удаления колонок: ${error.message}`);
	}
}

export const metadata = new MetadataManager();
