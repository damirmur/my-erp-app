import { db, type LocalColumn } from '$lib/db/indexeddb';
import { ensureColumns, ensureTable } from '$lib/state/seed';

// Модуль «Пакеты решений»: системная таблица solution_packs (type template,
// скрыта из основного режима). Каждая запись — JSON-описание целого модуля
// (схема + каталоги + сценарии + печатные формы) в колонке definition;
// применение — действие «▶️ Выполнить» (config.runCode вызывает универсальный
// примитив applySolution из services/solutionPacks.ts, песочница).
export const SOLUTION_PACKS_TABLE = 'solution_packs';

// Код действия записи пакета: применяет record.data.definition (идемпотентно).
// Пробный прогон без записи в базу: параметр dryRun=1 в ссылке/коде действия.
export const APPLY_SOLUTION_RUN_CODE = `// Установка пакета решений (applySolution в песочнице).
// Пробный прогон: выполнить со ссылкой #/r/...?dryRun=1.
return await applySolution(record.data?.definition, {
	dryRun: params?.dryRun === 1 || params?.dryRun === true || params?.dryRun === '1'
});`;

function solutionColumns(): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{ name: 'description', title: 'Описание', type: 'textarea', sort_order: 30, is_visible: false },
		{
			name: 'definition',
			title: 'Определение (JSON)',
			type: 'jsonb',
			sort_order: 40,
			is_visible: false
		},
		{ name: 'applied_at', title: 'Применён', type: 'date', sort_order: 50, is_visible: true }
	];
}

// Идемпотентное создание таблицы пакетов. Вызывается из
// metadata.ensureSystemTables() (модуль 'solutions', группа core).
export async function ensureSolutionPacksTable(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const tableId = await ensureTable(SOLUTION_PACKS_TABLE, 'Пакеты решений', 'template', {
		hiddenInMain: true,
		features: {
			create: true,
			save: true,
			copy: true,
			delete: true,
			post: false,
			print: false,
			run: true
		},
		runCode: APPLY_SOLUTION_RUN_CODE
	});
	if (!tableId) return;

	await ensureColumns(tableId, solutionColumns(), online);
}
