import { supabase } from '$lib/db/supabase';
import { db, type LocalColumn } from '$lib/db/indexeddb';
import { getTableType } from '$lib/table-types';
import { ensureNotificationTables } from '$lib/state/notifications';
import { ensureSchedulerTables } from '$lib/state/scheduler';
import { ensureSettingsTable } from '$lib/state/settings';
import { ensureApiQueryTables } from '$lib/state/apiQueries';
import { ensureConstantsTable } from '$lib/state/constants';
import { ensureFlowTables } from '$lib/state/flows';
import { ensureBankStatementTables } from '$lib/state/bankStatements';

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
	{ name: 'link', title: 'Ссылка', type: 'string', sort_order: 3, is_visible: false },
	{
		name: 'event',
		title: 'Событие',
		type: 'string',
		sort_order: 4,
		is_visible: true
	},
	{
		name: 'description',
		title: 'Описание',
		type: 'string',
		sort_order: 5,
		is_visible: true
	}
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

		// Каталог «API-запросы»: внешние запросы (сервис + параметры-дефолты),
		// вызываемые по deep-link #/r/{id}.execute({...}).json или кнопкой ▶️.
		await ensureApiQueryTables();

		// Таблица «Константы»: одна таблица на все константы (много записей,
		// универсальное поле «Значение», периодичность через ТЧ «Периоды»).
		await ensureConstantsTable();

		// Таблица «Сценарии» (тип flow): граф как в n8n — узлы и связи в ТЧ,
		// исполнение через движок flowRunner (кнопка «▶️ Выполнить»).
		await ensureFlowTables();

		// Модуль «Банковские выписки»: каталоги банков и счетов, документ
		// «Выписки» с ТЧ «Операции» (импорт из PDF — кнопка «▶️ Выполнить»).
		await ensureBankStatementTables();

		// Таблица настроек приложения (порядок меню основного режима и т.п.).
		await ensureSettingsTable();
	}

	// Колонки истории: проверяет и создаёт недостающие на сервере (если онлайн)
	// и локально. Идемпотентно — добавляются только отсутствующие по name, поэтому
	// новые колонки (например, «Событие») появляются и у существующей таблицы.
	private async ensureHistoryColumns(tableId: string, online: boolean): Promise<void> {
		if (online) {
			try {
				const { data: existingCols } = await supabase
					.from('meta_columns')
					.select('name')
					.eq('table_id', tableId);
				const existingNames = new Set((existingCols ?? []).map((c) => c.name));
				const missing = HISTORY_COLUMNS.filter((c) => !existingNames.has(c.name));
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
		const missingLocal = HISTORY_COLUMNS.filter((c) => !localNames.has(c.name));
		if (missingLocal.length > 0) {
			await db.meta_columns.bulkPut(
				missingLocal.map((c) => ({ id: crypto.randomUUID(), table_id: tableId, ...c }))
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

	// Смена типа таблицы: обновляем и на сервере, и в локальном кэше
	// (иначе изменение затёр бы следующий pullMetadata).
	async updateTableType(tableId: string, type: string): Promise<boolean> {
		const { error } = await supabase.from('meta_tables').update({ type }).eq('id', tableId);
		if (error) {
			alert(`Ошибка смены типа: ${error.message}`);
			return false;
		}
		const local = await db.meta_tables.get(tableId);
		if (local) await db.meta_tables.put({ ...local, type });
		return true;
	}

	// Записи, чей статус не поддерживается новым типом, приводим к fallback
	// (первый статус нового типа). Postgres enum record_status допускает только
	// draft/posted/marked_for_deletion — остальные значения схлопываем в draft.
	async normalizeRecordStatuses(
		tableId: string,
		validStatuses: string[],
		fallback: string
	): Promise<void> {
		const ENUM = ['draft', 'posted', 'marked_for_deletion'] as const;
		type RecStatus = (typeof ENUM)[number];
		const safeFallback: RecStatus = (ENUM as readonly string[]).includes(fallback)
			? (fallback as RecStatus)
			: 'draft';
		// Из валидных статусов нового типа оставляем только те, что реально хранятся в enum
		const validEnum = validStatuses.filter((s) => (ENUM as readonly string[]).includes(s));

		if (validEnum.length === ENUM.length) {
			// Новый тип поддерживает все статусы — ничего нормализовывать не нужно
			return;
		}
		let q = supabase.from('data_records').update({ status: safeFallback }).eq('table_id', tableId);
		if (validEnum.length > 0) q = q.not('status', 'in', `(${validEnum.join(',')})`);
		const { error } = await q;
		if (error) alert(`Ошибка нормализации статусов: ${error.message}`);

		// Локальный кэш: записи с неизвестным статусом → fallback
		const valid = new Set(validStatuses);
		const records = await db.data_records.where('table_id').equals(tableId).toArray();
		const updates = records
			.filter((r) => !valid.has(r.status))
			.map((r) => ({ ...r, status: safeFallback }));
		if (updates.length > 0) await db.data_records.bulkPut(updates);
	}

	// Обновление синонима (заголовка) таблицы
	async updateTableTitle(tableId: string, title: string) {
		const { error } = await supabase.from('meta_tables').update({ title }).eq('id', tableId);
		if (error) alert(`Ошибка сохранения синонима: ${error.message}`);
	}

	// Переименование таблицы (поле `name`, используется как ключ: ссылки
	// #/t/{id|name}, поиск системных таблиц по name). Проверяем уникальность
	// на сервере (не считая саму таблицу) и пишем в локальный кэш — иначе
	// следующий pullMetadata затёр бы изменение.
	async updateTableName(tableId: string, name: string): Promise<boolean> {
		try {
			const { data: dup } = await supabase
				.from('meta_tables')
				.select('id')
				.eq('name', name)
				.neq('id', tableId)
				.limit(1);
			if (dup && dup.length > 0) {
				alert(`Имя "${name}" уже используется другой таблицей.`);
				return false;
			}
		} catch {
			// сервер недоступен — полагаемся на локальную проверку уникальности
		}
		const localRows = await db.meta_tables.where('name').equals(name).toArray();
		if (localRows.some((t) => t.id !== tableId)) {
			alert(`Имя "${name}" уже используется другой таблицей.`);
			return false;
		}
		const { error } = await supabase.from('meta_tables').update({ name }).eq('id', tableId);
		if (error) {
			alert(`Ошибка смены имени: ${error.message}`);
			return false;
		}
		const local = await db.meta_tables.get(tableId);
		if (local) await db.meta_tables.put({ ...local, name });
		return true;
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
