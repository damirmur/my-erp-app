import { db, type LocalColumn, type LocalRecord } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { ensureColumns, ensureTable } from '$lib/state/notifications';

// Модуль «Банковские выписки»: импорт выписок из PDF (СберБанк Онлайн и другие
// банки). Таблицы создаются идемпотентно (код-сид) при старте приложения и в
// начале каждого цикла синхронизации — по паттерну модулей уведомлений/сценариев.
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
// Движок импорта — src/lib/services/bankParser.ts (importStatement).

export const BANKS_TABLE = 'banks';
export const BANK_ACCOUNTS_TABLE = 'bank_accounts';
export const BANK_STATEMENTS_TABLE = 'bank_statements';
export const BANK_OPERATIONS_TABLE = 'bank_statement_operations';

export const SBER_NAME = 'Сбербанк';
export const ALFA_NAME = 'Альфа-банк';

// Код действия по умолчанию таблицы «Выписки»: вызывает движок импорта.
export const BANK_STATEMENT_RUN_CODE = `// Импорт выписки из прикреплённого PDF: определяет банк (поле «Банк»,
// банк счёта или маркеры в тексте), выполняет код-парсер формата банка
// и заполняет шапку и табличную часть «Операции». Возвращает сводку импорта.
return await importStatement(record.id, params);`;

// Код-парсер выписки Сбербанка (СберБанк Онлайн) — шаблон для остальных банков.
// Выполняется в песочнице (runActionCode). Доступны: text (весь текст PDF),
// rows (строки таблицы из координат), helpers (num, amount, date, hint),
// record (запись-выписка), params, db, supabase, save, log.
// Возвращает { header, operations }.
export const SBER_PARSER_CODE = [
	'// Парсер выписки Сбербанка (СберБанк Онлайн). Вид выписки определяется по',
	'// заголовку: «Выписка по платёжному счёту» (счёт), «кредитной карте»,',
	'// «дебетовой карте». Операции: блок начинается строкой «дата время …»,',
	'// продолжение — строки с датой и кодом авторизации (описание) и переносы.',
	'// Сумма операции: «+» = приход, без знака = расход.',
	'',
	"const find = (re) => { const m = text.match(re); return m ? m[1].trim() : ''; };",
	'',
	'const header = {};',
	"if (text.includes('Выписка по платёжному счёту')) header.statement_type = 'Счёт';",
	"else if (text.includes('кредитной карт')) header.statement_type = 'Кредитная карта';",
	"else if (text.includes('дебетовой карт')) header.statement_type = 'Дебетовая карта';",
	"else header.statement_type = 'Счёт';",
	'',
	'header.owner = find(/Владелец счёта\\s*([^\\n]+)/);',
	"header.account_number = find(/Номер счёта\\s+([\\d\\s]+)/).replace(/\\s+/g, '');",
	'if (!header.account_number) {',
	'  const card = text.match(/Номер карт[ыа]?\\s*[^\\n]*?([\\d\\s*]+)/);',
	"  if (card) header.account_number = card[1].replace(/[\\s*]/g, '');",
	'}',
	'header.currency = find(/Валюта\\s+([^\\n]+)/);',
	'',
	'const period = text.match(/За период\\s+([\\d.]+)\\s*[—–-]\\s*([\\d.]+)/);',
	'if (period) { header.period_start = period[1]; header.period_end = period[2]; }',
	'',
	'const balances = [...text.matchAll(/Остаток на\\s+[\\d.]+\\s+([\\d\\s.,]+)/g)].map((m) => m[1]);',
	'if (balances.length) header.opening_balance = helpers.num(balances[0]);',
	'if (balances.length > 1) header.closing_balance = helpers.num(balances[balances.length - 1]);',
	'',
	'// Служебные строки страниц (колонтитулы, сноски) — не описания операций.',
	'const isGarbage = (line) =>',
	'  /^\\d+\\s*$/.test(line) ||',
	'  /^\\*+\\s*$/.test(line) ||',
	'  /^Продолжение на следующей странице/.test(line) ||',
	'  /^Выписка по платёжному счёту/.test(line) ||',
	'  /^Индивидуальная выписка/.test(line) ||',
	'  /^ДАТА ОПЕРАЦИИ/.test(line) ||',
	'  /^Дата обработки/.test(line) ||',
	'  /^и код авторизации/.test(line) ||',
	'  /^КАТЕГОРИЯ/.test(line) ||',
	'  /^Описание операции/.test(line) ||',
	'  /^СУММА В ВАЛЮТЕ СЧЁТА/.test(line) ||',
	'  /^СУММА В РУБЛЯХ/.test(line) ||',
	'  /^Сумма в валюте/.test(line) ||',
	'  /^операции/.test(line) ||',
	'  /^ОСТАТОК СРЕДСТВ/.test(line) ||',
	'  /^В валюте счёта/.test(line) ||',
	'  /^Для проверки подлинности документа/.test(line) ||',
	'  /^\\d\\. Зайдите/.test(line) ||',
	'  /^\\d\\. Нажмите/.test(line) ||',
	'  /^\\d\\. Получите/.test(line) ||',
	'  /^Действителен/.test(line) ||',
	'  /^\\* Предоставляя/.test(line) ||',
	'  /^до\\s+\\d{2}\\.\\d{2}\\.\\d{4}/.test(line);',
	'',
	'const ops = [];',
	'let cur = null;',
	'for (const row of rows) {',
	"  const line = row.cells.map((c) => c.text).join(' ');",
	'  // Финальный блок «Дата формирования документа» — конец операций.',
	'  if (/^Дата формирования документа/.test(line)) break;',
	'  if (isGarbage(line)) continue;',
	'  const start = line.match(/^(\\d{2}\\.\\d{2}\\.\\d{4})\\s+(\\d{2}:\\d{2})\\s+(.+)$/);',
	'  if (start) {',
	'    if (cur) ops.push(cur);',
	'    cur = {',
	'      op_date: helpers.date(start[1]),',
	'      op_time: start[2],',
	"      category: '',",
	'      amount: null,',
	'      balance: null,',
	"      description: ''",
	'    };',
	'    const rest = start[3];',
	'    const amt = rest.match(/([+\\-]?\\d+(?: \\d{3})*(?:,\\d+)?)\\s+(\\d+(?: \\d{3})*(?:,\\d+)?)$/);',
	'    if (amt) {',
	'      cur.balance = helpers.num(amt[2]);',
	'      cur.amount = helpers.amount(amt[1]);',
	'      cur.category = rest.slice(0, rest.length - amt[0].length).trim();',
	'    } else {',
	'      cur.category = rest.trim();',
	'    }',
	'  } else if (cur) {',
	'    const det = line.match(/^\\d{2}\\.\\d{2}\\.\\d{4}\\s+(\\d{6})\\s+(.+)$/);',
	'    if (det) {',
	'      cur.auth_code = det[1];',
	"      cur.description = (cur.description ? cur.description + ' ' : '') + det[2];",
	'    } else {',
	"      cur.description = (cur.description ? cur.description + ' ' : '') + line;",
	'    }',
	'  }',
	'}',
	'if (cur) ops.push(cur);',
	'',
	'const operations = ops.filter((o) => o.op_date || o.description || o.amount != null);',
	'return { header, operations };'
].join('\n');

// Код-парсер выписки Альфа-Банка («Выписка по счету»). Сумма — в конце строки
// операции с кодом валюты «RUR», знак явный: «−» расход, «+»/без знака — доход.
// Секция «Неподтвержденные операции» (строки «HOLD …») пропускается.
export const ALFA_PARSER_CODE = [
	'// Парсер выписки Альфа-Банка («Выписка по счету»).',
	'// Операции: строка «дата  код_операции  описание … СУММА RUR»;',
	'// продолжения описания — следующие строки до следующей даты+кода.',
	'// Сумма со знаком: отрицательная — расход, положительная — поступление.',
	'',
	"const find = (re) => { const m = text.match(re); return m ? m[1].trim() : ''; };",
	'',
	'const header = {};',
	"header.statement_type = 'Счёт';",
	"header.account_number = find(/Номер счета\\s+([\\d\\s]+)/).replace(/\\s+/g, '');",
	'header.owner = find(/Клиент\\s+([^\\n]+)/);',
	'header.currency = find(/Валюта счета\\s+([^\\n]+)/);',
	'',
	'const period = text.match(/За период с\\s+([\\d.]+)\\s+по\\s+([\\d.]+)/);',
	'if (period) { header.period_start = period[1]; header.period_end = period[2]; }',
	'',
	'const openM = text.match(/Входящий остаток\\s+([\\d\\s.,-]+)/);',
	'if (openM) header.opening_balance = helpers.num(openM[1]);',
	'const closeM = text.match(/Исходящий остаток\\s+([\\d\\s.,-]+)/);',
	'if (closeM) header.closing_balance = helpers.num(closeM[1]);',
	'',
	'// Служебные строки страниц (колонтитулы, подпись) — не описания операций.',
	'const isGarbage = (line) =>',
	'  /^Страница\\s+\\d+\\s+из\\s+\\d+/.test(line) ||',
	'  /^Т\\.Т\\./.test(line) ||',
	'  /^Уполномоченное лицо/.test(line) ||',
	'  /^\\(подпись сотрудника/.test(line) ||',
	'  /^Дата проводки/.test(line) ||',
	'  /^в валюте счета/.test(line) ||',
	'  /^Операции по счету/.test(line) ||',
	'  /^Выписка по счету/.test(line);',
	'',
	'const ops = [];',
	'let cur = null;',
	'let hold = false;',
	'for (const row of rows) {',
	"  const line = row.cells.map((c) => c.text).join(' ');",
	'  if (hold) continue;',
	'  if (/^HOLD\\b/.test(line)) { hold = true; continue; }',
	'  if (isGarbage(line)) continue;',
	'  const start = line.match(/^(\\d{2}\\.\\d{2}\\.\\d{4})\\s+([A-Za-z0-9_]+)\\s+(.+)$/);',
	'  if (start) {',
	'    if (cur) ops.push(cur);',
	"    cur = { op_date: helpers.date(start[1]), auth_code: start[2], category: '', amount: null, description: '' };",
	'    const rest = start[3];',
	'    const amt = rest.match(/(-?\\d+(?: \\d{3})*(?:,\\d+)?)\\s+RUR\\s*$/);',
	'    if (amt) {',
	'      cur.amount = helpers.num(amt[1]);',
	'      cur.description = rest.slice(0, rest.length - amt[0].length).trim();',
	'    } else {',
	'      cur.description = rest.trim();',
	'    }',
	'  } else if (cur) {',
	"    cur.description = (cur.description ? cur.description + ' ' : '') + line;",
	'  }',
	'}',
	'if (cur) ops.push(cur);',
	'',
	'const operations = ops.filter((o) => o.op_date || o.description || o.amount != null);',
	'return { header, operations };'
].join('\n');

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

	const operationsId = await ensureTable(
		BANK_OPERATIONS_TABLE,
		'Операции',
		'tabular',
		{},
		statementsId
	);
	if (operationsId) await ensureColumns(operationsId, operationColumns(), online);
}

// Найти запись банка по name (локально, при онлайне — и на сервере).
async function findBankByName(
	bankTableId: string,
	name: string,
	online: boolean
): Promise<LocalRecord | null> {
	const local = await db.data_records
		.where('table_id')
		.equals(bankTableId)
		.filter((r) => r.data?.name === name)
		.first();
	if (local) return local;
	if (!online) return null;
	try {
		const { data } = await supabase.from('data_records').select('*').eq('table_id', bankTableId);
		return (data ?? []).find((r: any) => r.data?.name === name) ?? null;
	} catch {
		return null;
	}
}

// Сид каталога «Банки»: записи «Сбербанк» и «Альфа-банк» с готовыми парсерами
// формата выписки. Идемпотентно по name. Заводской парсер обновляется до текущей
// версии только если запись не редактировалась вручную: сид проверяет, что код
// парсера начинается с заводского маркера-комментария, а описание не изменено.
async function seedBank(
	bankTableId: string,
	number: string,
	name: string,
	hints: string,
	parserCode: string,
	marker: string,
	description: string,
	online: boolean
): Promise<void> {
	const existing = await findBankByName(bankTableId, name, online);
	if (existing) {
		const code = String(existing.data?.parser_code ?? '');
		const isFactory =
			existing.data?.description === description && code.startsWith(marker) && code !== parserCode;
		if (isFactory) {
			const data = { ...existing.data, parser_code: parserCode };
			await db.data_records.put({
				...existing,
				data,
				is_dirty: 1,
				updated_at: new Date().toISOString()
			});
			if (online) {
				try {
					await supabase.from('data_records').upsert({
						id: existing.id,
						table_id: existing.table_id,
						status: existing.status,
						data,
						updated_at: new Date().toISOString(),
						is_folder: existing.is_folder ?? false,
						parent_id: existing.parent_id ?? null
					});
				} catch {
					// уедет при ближайшем синке
				}
			}
		}
		return;
	}

	const record: LocalRecord = {
		id: crypto.randomUUID(),
		table_id: bankTableId,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		data: { number, name, bank_hints: hints, parser_code: parserCode, description },
		is_dirty: 1,
		updated_at: new Date().toISOString()
	};
	await db.data_records.put(record);
	if (online) {
		try {
			const { is_dirty: _ignored, ...serverRecord } = record;
			await supabase.from('data_records').upsert(serverRecord);
		} catch {
			// уедет при ближайшем синке
		}
	}
}

export async function seedBankStatementDefaults(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;
	const bankTable = await db.meta_tables.where('name').equals(BANKS_TABLE).first();
	if (!bankTable) return;

	await seedBank(
		bankTable.id,
		'1',
		SBER_NAME,
		'СберБанк Онлайн\nwww.sberbank.ru',
		SBER_PARSER_CODE,
		'// Парсер выписки Сбербанка (СберБанк Онлайн).',
		'Импорт выписок СберБанк Онлайн: платёжный счёт, дебетовая и кредитная карта. Вид выписки определяется по заголовку PDF.',
		online
	);
	await seedBank(
		bankTable.id,
		'2',
		ALFA_NAME,
		'АЛЬФА-БАНК',
		ALFA_PARSER_CODE,
		'// Парсер выписки Альфа-Банка',
		'Импорт выписок Альфа-Банка («Выписка по счету»): операции «дата  код  описание … сумма RUR», секция неподтверждённых операций (HOLD) пропускается.',
		online
	);
}
