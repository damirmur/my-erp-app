import { supabase } from '$lib/db/supabase';
import { db, type LocalColumn } from '$lib/db/indexeddb';
import { ensureColumns, ensureTable } from '$lib/state/seed';

// Модуль «Печатные формы»: реестр печатных форм (шаблонов HTML) для любых
// таблиц приложения. Каждая запись = одна печатная форма: привязка к целевой
// таблице (target_table), HTML-шаблон с плейсхолдерами (template_html),
// опциональный код заполнения (code — выполняется в песочнице и возвращает
// строку HTML или объект данных для шаблона), флаг «по умолчанию» (is_default,
// если форм несколько) и порядок сортировки.
//
// Это обычная системная таблица (data_records), как «API-запросы»:
// создаётся/редактируется в конструкторе, синхронизируется и работает офлайн.
//
// Печать: кнопка «🖨️ Печать» в списке/форме — если для таблицы нет ни одной
// печатной формы, кнопка скрыта; одна — прямая печать; несколько —
// выпадающий список, дефолт отмечен ✓. Рендер шаблона — printerService
// (src/lib/services/printer.ts).

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
