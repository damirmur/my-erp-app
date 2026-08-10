import { db, type LocalColumn } from '$lib/db/indexeddb';
import { ensureColumns, ensureTable } from '$lib/state/seed';

// Модуль «Константы»: одна таблица на все константы (type='constant',
// config.manyRecords=true — обычный список, запись = константа). Поле
// «Значение» — универсальное: у каждой константы свой тип (строка, число,
// дата, датавремя, ссылка и т.д.), тип выбирается при редактировании записи.
//
// Периодичность (config.periodic=true): у таблицы есть ТЧ «Периоды» (тип
// значения тоже универсальный) — у каждой константы свои строки периодов;
// значение в шапке блокируется, только когда у записи есть периоды
// (см. DynamicForm.hasPeriodLines), поэтому обычные и периодические константы
// могут жить в одной таблице.
//
// Таблица создаётся идемпотентно кодом (старт + начало каждого синка) — это
// НЕ виртуальная таблица: метаданные в meta_tables/meta_columns, записи
// синхронизируются с сервером как обычные данные.

export const CONSTANTS_TABLE = 'constants';

function constantsColumns(): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{ name: 'value', title: 'Значение', type: 'universal', sort_order: 30, is_visible: true },
		{
			name: 'description',
			title: 'Описание',
			type: 'textarea',
			sort_order: 40,
			is_visible: false
		}
	];
}

// Идемпотентное создание таблицы «Константы» и её ТЧ «Периоды».
// Вызывается из metadata.ensureSystemTables() — после каталога «API-запросы».
export async function ensureConstantsTable(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const tableId = await ensureTable(CONSTANTS_TABLE, 'Константы', 'constant', {
		features: { create: true },
		manyRecords: true,
		periodic: true
	});
	if (!tableId) return;
	await ensureColumns(tableId, constantsColumns(), online);

	// ТЧ «Периоды» для значений по датам (тип значения наследует универсальное).
	const periodsId = await ensureTable('constants_periods', 'Периоды', 'tabular', {}, tableId);
	if (periodsId) {
		await ensureColumns(
			periodsId,
			[
				{ name: 'period', title: 'Период', type: 'date', sort_order: 10, is_visible: true },
				{ name: 'value', title: 'Значение', type: 'universal', sort_order: 20, is_visible: true }
			],
			online
		);
	}
}
