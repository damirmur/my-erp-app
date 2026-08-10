import { supabase } from '$lib/db/supabase';
import { db, type LocalColumn, type LocalTable } from '$lib/db/indexeddb';
import { ensureColumns, ensureTable } from '$lib/state/seed';

// Модуль «Банковские выписки»: импорт выписок из PDF. Таблицы создаются
// идемпотентно (код-сид) при старте приложения и в начале каждого цикла
// синхронизации — по паттерну модулей уведомлений/сценариев.
//
//   «Банки»      (banks): каталог банков. У каждой записи — маркеры распознавания
//                (bank_hints) и код-парсер формата выписки (parser_code, JS в
//                песочнице как runCode). Новый банк = новая запись без пересборки.
//   «Счета»      (bank_accounts): каталог банковских счетов (банк, номер, валюта).
//   «Выписки»    (bank_statements): документ с прикреплённым PDF (file), банком,
//                периодом, остатками и ТЧ «Операции». «▶️ Выполнить» запускает
//                импорт (config.runCode = BANK_STATEMENT_RUN_CODE).
//   «Операции»   (bank_statement_operations): строки ТЧ — одна операция на строку.
//
// Конкретные банки и их парсеры — данные в каталоге «Банки» (поле parser_code),
// код-сида по банкам здесь нет. Движок импорта — src/lib/services/bankParser.ts
// (importStatement): берёт parser_code из записи банка и выполняет в песочнице.

export const BANKS_TABLE = 'banks';
export const BANK_ACCOUNTS_TABLE = 'bank_accounts';
export const BANK_STATEMENTS_TABLE = 'bank_statements';
export const BANK_OPERATIONS_TABLE = 'bank_statement_operations';

// Код действия по умолчанию таблицы «Выписки»: вызывает движок импорта.
export const BANK_STATEMENT_RUN_CODE = `// Импорт выписки из прикреплённого PDF: определяет банк (поле «Банк»,
// банк счёта или маркеры в тексте), выполняет код-парсер формата банка
// и заполняет шапку и табличную часть «Операции». Возвращает сводку импорта.
return await importStatement(record.id, params);`;

type ColumnSeed = Omit<LocalColumn, 'id' | 'table_id'>;

// Колонки каталога «Банки». bank_hints — маркеры распознавания банка по тексту
// PDF (по одному в строке); parser_code — код-парсер формата выписки.
function bankColumns(): ColumnSeed[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{
			name: 'bank_hints',
			title: 'Маркеры распознавания',
			type: 'textarea',
			sort_order: 30,
			is_visible: false
		},
		{
			name: 'parser_code',
			title: 'Код парсера',
			type: 'textarea',
			sort_order: 40,
			is_visible: false
		},
		{ name: 'description', title: 'Описание', type: 'textarea', sort_order: 50, is_visible: false }
	];
}

// Колонки каталога «Банковские счета».
function accountColumns(banksId: string): ColumnSeed[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{
			name: 'bank',
			title: 'Банк',
			type: 'link',
			sort_order: 30,
			is_visible: true,
			related_table_id: banksId
		},
		{
			name: 'account_number',
			title: 'Номер счёта',
			type: 'string',
			sort_order: 40,
			is_visible: true
		},
		{ name: 'currency', title: 'Валюта', type: 'string', sort_order: 50, is_visible: false },
		{ name: 'owner', title: 'Владелец', type: 'string', sort_order: 60, is_visible: false },
		{ name: 'description', title: 'Описание', type: 'textarea', sort_order: 70, is_visible: false }
	];
}

// Колонки документа «Выписки». file — прикреплённый PDF (разбор на «▶️ Выполнить»).
function statementColumns(accountsId: string, banksId: string): ColumnSeed[] {
	return [
		{ name: 'number', title: 'Номер', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'date', title: 'Дата', type: 'date', sort_order: 20, is_visible: true },
		{
			name: 'account',
			title: 'Счёт',
			type: 'link',
			sort_order: 25,
			is_visible: true,
			related_table_id: accountsId
		},
		{
			name: 'bank',
			title: 'Банк',
			type: 'link',
			sort_order: 27,
			is_visible: true,
			related_table_id: banksId
		},
		{
			name: 'statement_type',
			title: 'Вид выписки',
			type: 'string',
			sort_order: 28,
			is_visible: false
		},
		{ name: 'file', title: 'Файл PDF', type: 'file', sort_order: 30, is_visible: true },
		{
			name: 'period_start',
			title: 'Начало периода',
			type: 'date',
			sort_order: 40,
			is_visible: false
		},
		{ name: 'period_end', title: 'Конец периода', type: 'date', sort_order: 50, is_visible: false },
		{
			name: 'opening_balance',
			title: 'Входящий остаток',
			type: 'number',
			sort_order: 60,
			is_visible: false
		},
		{
			name: 'closing_balance',
			title: 'Исходящий остаток',
			type: 'number',
			sort_order: 70,
			is_visible: false
		},
		{ name: 'currency', title: 'Валюта', type: 'string', sort_order: 80, is_visible: false },
		{
			name: 'operations_count',
			title: 'Операций',
			type: 'number',
			sort_order: 90,
			is_visible: false
		},
		{ name: 'last_result', title: 'Результат', type: 'string', sort_order: 100, is_visible: false },
		{ name: 'last_error', title: 'Ошибка', type: 'textarea', sort_order: 110, is_visible: false }
	];
}

// Колонки ТЧ «Операции»: сумма со знаком («+» — приход, без знака — расход),
// остаток в валюте счёта после операции, extra — запасные поля формата.
function operationColumns(): ColumnSeed[] {
	return [
		{ name: 'op_date', title: 'Дата', type: 'date', sort_order: 10, is_visible: true },
		{ name: 'op_time', title: 'Время', type: 'string', sort_order: 20, is_visible: true },
		{
			name: 'auth_code',
			title: 'Код авторизации',
			type: 'string',
			sort_order: 30,
			is_visible: false
		},
		{ name: 'category', title: 'Категория', type: 'string', sort_order: 40, is_visible: true },
		{ name: 'description', title: 'Описание', type: 'string', sort_order: 50, is_visible: true },
		{ name: 'amount', title: 'Сумма', type: 'number', sort_order: 60, is_visible: true },
		{ name: 'balance', title: 'Остаток', type: 'number', sort_order: 70, is_visible: true },
		{ name: 'extra', title: 'Доп. данные', type: 'jsonb', sort_order: 80, is_visible: false }
	];
}

// Идемпотентное создание таблиц модуля «Банковские выписки». Вызывается из
// metadata.ensureSystemTables() — после ensureFlowTables (не зависит от них,
// порядок для единообразия).
export async function ensureBankStatementTables(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const banksId = await ensureTable(BANKS_TABLE, 'Банки', 'directory', {
		features: { create: true, save: true, copy: true, delete: true, run: false }
	});
	if (banksId) await ensureColumns(banksId, bankColumns(), online);

	const accountsId = await ensureTable(BANK_ACCOUNTS_TABLE, 'Банковские счета', 'directory', {
		features: { create: true, save: true, copy: true, delete: true, run: false }
	});
	if (accountsId) await ensureColumns(accountsId, accountColumns(banksId), online);

	const statementsId = await ensureTable(BANK_STATEMENTS_TABLE, 'Выписки', 'document', {
		features: { create: true, save: true, copy: true, delete: true, run: true },
		runCode: BANK_STATEMENT_RUN_CODE
	});
	if (!statementsId) return;
	await ensureColumns(statementsId, statementColumns(accountsId, banksId), online);

	// Сверка типа и конфига у существующих установок: ранние версии создавали
	// «Выписки» справочником (type='directory'). Приводим к документу
	// идемпотентно — записи, ТЧ и вложения не трогаем (они привязаны по id).
	const expectedConfig = {
		features: { create: true, save: true, copy: true, delete: true, run: true },
		runCode: BANK_STATEMENT_RUN_CODE
	};
	if (online) {
		try {
			const { data: serverTable } = await supabase
				.from('meta_tables')
				.select('type,config')
				.eq('id', statementsId)
				.single();
			const needsType = serverTable?.type !== 'document';
			const needsConfig =
				serverTable?.config?.features?.run !== true ||
				serverTable?.config?.runCode !== BANK_STATEMENT_RUN_CODE;
			if (needsType) {
				await supabase.from('meta_tables').update({ type: 'document' }).eq('id', statementsId);
			}
			if (needsConfig) {
				const merged = { ...(serverTable?.config ?? {}), ...expectedConfig };
				await supabase
					.from('meta_tables')
					.update({ config: { ...merged, features: { ...merged.features, run: true } } })
					.eq('id', statementsId);
			}
		} catch {
			// сервер недоступен — достаточно локального обновления
		}
	}
	const localTable = await db.meta_tables.get(statementsId);
	if (localTable) {
		const patch: Partial<LocalTable> = {};
		if (localTable.type !== 'document') patch.type = 'document';
		const cfg = localTable.config ?? {};
		if (cfg.features?.run !== true || cfg.runCode !== BANK_STATEMENT_RUN_CODE) {
			patch.config = {
				...cfg,
				features: { ...cfg.features, run: true },
				runCode: BANK_STATEMENT_RUN_CODE
			};
		}
		if (Object.keys(patch).length > 0) await db.meta_tables.update(statementsId, patch);
	}

	const operationsId = await ensureTable(
		BANK_OPERATIONS_TABLE,
		'Операции',
		'tabular',
		{},
		statementsId
	);
	if (operationsId) await ensureColumns(operationsId, operationColumns(), online);
}
