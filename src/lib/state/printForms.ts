import { supabase } from '$lib/db/supabase';
import { db, type LocalColumn, type LocalRecord } from '$lib/db/indexeddb';
import { ensureColumns, ensureTable, hasServerRows, seedRecord } from '$lib/state/notifications';

// Модуль «Печатные формы»: реестр печатных форм (шаблонов HTML) для любых
// таблиц приложения. Каждая запись = одна печатная форма: привязка к целевой
// таблице (target_table), HTML-шаблон с плейсхолдерами (template_html),
// опциональный код заполнения (code — выполняется в песочнице и возвращает
// строку HTML или объект данных для шаблона), флаг «по умолчанию» (is_default,
// если форм несколько) и порядок сортировки.
//
// Раньше печатные формы хранились в отдельной raw-таблице print_forms
// (id, table_id, name, is_default, template_html), которая качалась в
// отдельную Dexie-таблицу и никогда не редактировалась из программы.
// Теперь это обычная системная таблица (data_records), как «API-запросы»:
// создаётся/редактируется в конструкторе, синхронизируется и работает офлайн.
//
// Печать: кнопка «🖨️ Печать» в списке/форме — если для таблицы нет ни одной
// печатной формы, кнопка скрыта; одна — прямая печать; несколько —
// выпадающий список, дефолт отмечен ✓. Рендер шаблона — printerService
// (src/lib/services/printer.ts).
//
// Таблица создаётся идемпотентно (код-сид) при старте приложения и в начале
// каждого цикла синхронизации — по паттерну модуля «API-запросы». Legacy-строки
// из старой raw-таблицы print_forms переносятся в новую (seedPrintFormDefaults).

export const PRINT_FORMS_TABLE = 'print_forms';

function printFormColumns(): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{
			name: 'target_table',
			title: 'Таблица',
			type: 'select',
			sort_order: 30,
			is_visible: true
		},
		{
			name: 'template_html',
			title: 'Шаблон HTML',
			type: 'textarea',
			sort_order: 40,
			is_visible: false
		},
		{
			name: 'code',
			title: 'Код заполнения',
			type: 'textarea',
			sort_order: 45,
			is_visible: false
		},
		{
			name: 'is_default',
			title: 'По умолчанию',
			type: 'boolean',
			sort_order: 50,
			is_visible: true
		},
		{
			name: 'delivery',
			title: 'Способы вывода (print,screen,send,download)',
			type: 'string',
			sort_order: 55,
			is_visible: false
		},
		{
			name: 'output_format',
			title: 'Формат вывода (html|svg)',
			type: 'string',
			sort_order: 56,
			is_visible: false
		},
		{
			name: 'summary',
			title: 'Выжимка для сообщения',
			type: 'textarea',
			sort_order: 57,
			is_visible: false
		},
		{ name: 'sort_order', title: 'Порядок', type: 'number', sort_order: 60, is_visible: true }
	];
}

// Идемпотентное создание таблицы «Печатные формы». Вызывается из
// metadata.ensureSystemTables(). Скрыта из основного режима (hiddenInMain),
// редактируется в конструкторе как обычный справочник/документ.
export async function ensurePrintFormsTable(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const tableId = await ensureTable(PRINT_FORMS_TABLE, 'Печатные формы', 'template', {
		hiddenInMain: true,
		features: { create: true, save: true, copy: true, post: false, print: false }
	});
	if (!tableId) return;

	// Сверка типа: таблица «Печатные формы» живёт в типе template («Шаблон»).
	// Ранние версии создавали её как document — приводим к template на сервере
	// и локально (идемпотентно).
	if (online) {
		try {
			await supabase.from('meta_tables').update({ type: 'template' }).eq('id', tableId);
		} catch {
			// повторится при следующем цикле
		}
	}
	const localTable = await db.meta_tables.get(tableId);
	if (localTable && localTable.type !== 'template') {
		await db.meta_tables.update(tableId, { type: 'template' });
	}

	await ensureColumns(tableId, printFormColumns(), online);
}

// Перенос legacy-строк из старой raw-таблицы print_forms (template_html) в
// новую системную таблицу (data_records). Вызывается из runFullSync ПОСЛЕ
// pullDataChanges (как другие сиды). Идемпотентно: копируются только строки,
// которых ещё нет в новой таблице (сверка по name + target_table); после
// переноса legacy-строки удаляются с сервера.
export async function seedPrintFormDefaults(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;
	const printFormsId = (await db.meta_tables.where('name').equals(PRINT_FORMS_TABLE).first())?.id;
	if (!printFormsId) return;

	// 1. Читаем legacy-строки (если сервер доступен)
	let legacyRows: {
		id: string;
		table_id: string | null;
		name: string;
		is_default: boolean;
		template_html: string;
	}[] = [];
	if (online) {
		try {
			const { data, error } = await supabase.from('print_forms').select('*');
			if (!error && data) legacyRows = data as typeof legacyRows;
		} catch {
			// сервер недоступен — миграция повторится при следующем цикле
		}
	}
	if (legacyRows.length > 0) {
		// 2. Уже перенесённые (по target_table + name) — локально и на сервере.
		// Проверка сервера защищает от дублей при нескольких устройствах.
		if (!(online && (await hasServerRows(printFormsId, online)))) {
			const existing = await db.data_records.where('table_id').equals(printFormsId).toArray();
			const existingKeys = new Set(
				existing.map((r) => `${r.data?.target_table ?? ''}|${r.data?.name ?? ''}`)
			);

			const now = new Date().toISOString();
			const migrated: LocalRecord[] = [];
			const migratedLegacyIds: string[] = [];
			for (const row of legacyRows) {
				const key = `${row.table_id ?? ''}|${row.name ?? ''}`;
				if (existingKeys.has(key)) continue;
				const rec: LocalRecord = {
					id: crypto.randomUUID(),
					table_id: printFormsId,
					status: 'draft',
					is_folder: false,
					parent_id: null,
					data: {
						number: String(migrated.length + 1),
						name: row.name ?? '',
						target_table: row.table_id ?? '',
						template_html: row.template_html ?? '',
						is_default: row.is_default === true,
						sort_order: migrated.length + 1
					},
					is_dirty: 1,
					updated_at: now
				};
				existingKeys.add(key);
				migrated.push(rec);
				migratedLegacyIds.push(row.id);
			}

			for (const rec of migrated) await seedRecord(rec, online);

			// 3. Перенесённые строки удаляем из legacy-таблицы (чтобы не мигрировать повторно)
			if (online && migratedLegacyIds.length > 0) {
				try {
					await supabase.from('print_forms').delete().in('id', migratedLegacyIds);
				} catch {
					// удаление повторится при следующем цикле
				}
			}
		}
	}
}
