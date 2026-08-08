import { db, type LocalLine, type LocalRecord } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { extractPdfText } from '$lib/services/pdfText';
import { linkApi } from '$lib/services/deeplink';
import {
	apiCall,
	runActionCode,
	runAnotherTable,
	saveRecordWithLines,
	type RunActionContext
} from '$lib/services/actionRunner';
import { BANKS_TABLE, BANK_ACCOUNTS_TABLE, BANK_OPERATIONS_TABLE } from '$lib/state/bankStatements';
import type { StoredFile } from '$lib/services/files';

// Движок импорта банковских выписок из PDF.
//
// Поток: запись «Выписки» (с прикреплённым PDF в поле file) → извлечение текста
// pdf.js (координатная экстракция строк таблицы) → определение банка (поле
// «Банк», банк счёта, или автораспознавание по маркерам bank_hints) → выполнение
// кода-парсера формата банка (поле parser_code, песочница как runCode) →
// заполнение шапки выписки и ТЧ «Операции» с дедупликацией по ключу
// (дата|время|код авторизации|сумма).
//
// Код-парсер банка — тело async-функции, контекст: text (весь текст PDF),
// rows (строки таблицы), helpers, record, params, db, supabase, save, log, link,
// apiCall, run, flow. Возвращает { header, operations }.

// Хелперы для кода-парсера банка.
export interface ParserHelpers {
	// Число из строки с пробелами-разделителями: '47 643,12' → 47643.12
	// (знак «−» учитывается, «+» игнорируется).
	num: (s: unknown) => number | null;
	// Сумма операции: «+3 000,00» → 3000 (приход), «3 000,00» → −3000 (расход).
	amount: (s: unknown) => number | null;
	// Дата: '24.07.2026' → '2026-07-24' (и '2026-07-24' проходит как есть).
	date: (s: unknown) => string;
	// Проверка маркера в тексте выписки.
	hint: (substr: string) => boolean;
}

export interface StatementHeader {
	statement_type?: string;
	account_number?: string;
	owner?: string;
	currency?: string;
	period_start?: string;
	period_end?: string;
	opening_balance?: number | string;
	closing_balance?: number | string;
}

export interface StatementOperation {
	op_date?: string;
	op_time?: string;
	auth_code?: string;
	category?: string;
	description?: string;
	amount?: number;
	balance?: number;
	extra?: Record<string, unknown>;
}

export interface ImportResult {
	ok: boolean;
	bank?: string;
	account?: string;
	statement_type?: string;
	period?: string;
	operations: number;
	new: number;
	skipped: number;
	opening?: number | null;
	closing?: number | null;
	error?: string;
}

function clean(s: unknown): string {
	return String(s ?? '')
		.replace(/\u00a0/g, ' ')
		.trim();
}

// '47 643,12' → 47643.12; '−3 000,00' → −3000; '+3 000,00' → 3000.
export function parseRuNumber(s: unknown): number | null {
	const t = clean(s);
	if (!t) return null;
	const neg = t.startsWith('-') || t.startsWith('−');
	const core = t
		.replace(/^[+\-−]/, '')
		.replace(/\s+/g, '')
		.replace(',', '.');
	const n = parseFloat(core);
	if (!Number.isFinite(n)) return null;
	return neg ? -Math.abs(n) : Math.abs(n);
}

// Сумма операции: явный «+» — приход (положительная), явный «−» — расход,
// без знака — расход по умолчанию (у Сбера приход помечается «+»).
export function parseRuAmount(s: unknown): number | null {
	const t = clean(s);
	if (!t) return null;
	if (t.startsWith('+')) return parseRuNumber(t.slice(1));
	if (t.startsWith('-') || t.startsWith('−')) return parseRuNumber(t);
	const n = parseRuNumber(t);
	return n === null ? null : -Math.abs(n);
}

// '24.07.2026' / '2026-07-24' → 'YYYY-MM-DD'.
export function toDate(s: unknown): string {
	const t = clean(s);
	let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
	if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
	m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
	return t;
}

function numOr(x: unknown): number | string | undefined {
	if (x == null) return undefined;
	if (typeof x === 'number') return x;
	const parsed = parseRuNumber(x);
	if (parsed !== null) return parsed;
	const t = String(x).trim();
	return t || undefined;
}

// Автораспознавание банка по маркерам bank_hints в тексте выписки.
async function detectBank(text: string): Promise<LocalRecord | null> {
	const bankTable = await db.meta_tables.where('name').equals(BANKS_TABLE).first();
	if (!bankTable) return null;
	const banks = await db.data_records.where('table_id').equals(bankTable.id).toArray();
	let best: LocalRecord | null = null;
	let bestCount = 0;
	for (const b of banks) {
		const hints = String(b.data?.bank_hints ?? '')
			.split('\n')
			.map((h) => h.trim())
			.filter(Boolean);
		if (hints.length === 0) continue;
		const count = hints.reduce((acc, h) => (text.includes(h) ? acc + 1 : acc), 0);
		if (count > bestCount) {
			bestCount = count;
			best = b;
		}
	}
	return bestCount > 0 ? best : null;
}

// Ключ дедупликации операции: дата|время|код авторизации|сумма.
function dedupeKey(op: Record<string, any>): string {
	return `${op.op_date ?? ''}|${op.op_time ?? ''}|${op.auth_code ?? ''}|${op.amount ?? ''}`;
}

// Нормализация строки операции из кода-парсера.
function normalizeOperation(raw: any): Record<string, any> | null {
	if (!raw || typeof raw !== 'object') return null;
	const op: Record<string, any> = {};
	if (raw.op_date) op.op_date = toDate(raw.op_date);
	if (raw.op_time != null) op.op_time = String(raw.op_time);
	if (raw.auth_code != null) op.auth_code = String(raw.auth_code);
	if (raw.category != null) op.category = String(raw.category);
	if (raw.description != null) op.description = String(raw.description);
	if (raw.amount != null) {
		op.amount = typeof raw.amount === 'number' ? raw.amount : parseRuAmount(raw.amount);
	}
	if (raw.balance != null) {
		op.balance = typeof raw.balance === 'number' ? raw.balance : parseRuNumber(raw.balance);
	}
	if (raw.extra && typeof raw.extra === 'object') op.extra = raw.extra;
	if (!op.op_date && !op.description && op.amount == null) return null;
	return op;
}

// Импорт выписки по id записи (runCode «▶️ Выполнить» или #/r/{id}.execute().json).
export async function importStatement(
	recordId: string,
	params: Record<string, any> = {}
): Promise<ImportResult> {
	const record = await db.data_records.get(recordId);
	if (!record) throw new Error('Запись выписки не найдена: ' + recordId);

	const file = record.data?.file as StoredFile | undefined;
	if (!file || !file.data) {
		throw new Error('К выписке не прикреплён файл PDF (поле «Файл PDF»)');
	}

	const { text, rows } = await extractPdfText(file);

	// 1. Банк: поле выписки → банк счёта → автораспознавание по маркерам.
	let bank: LocalRecord | null = null;
	if (record.data?.bank) bank = (await db.data_records.get(String(record.data.bank))) ?? null;
	if (!bank && record.data?.account) {
		const acc = await db.data_records.get(String(record.data.account));
		if (acc?.data?.bank) bank = (await db.data_records.get(String(acc.data.bank))) ?? null;
	}
	if (!bank) bank = await detectBank(text);
	if (!bank) {
		throw new Error(
			'Банк не определён. Укажите поле «Банк» на выписке, банк счёта или добавьте маркеры в каталоге «Банки».'
		);
	}
	const parserCode = String(bank.data?.parser_code ?? '').trim();
	if (!parserCode) {
		throw new Error(
			`У банка «${bank.data?.name ?? ''}» не задан код парсера (поле «Код парсера»).`
		);
	}

	// 2. Код-парсер формата банка в песочнице.
	const helpers: ParserHelpers = {
		num: parseRuNumber,
		amount: parseRuAmount,
		date: toDate,
		hint: (h: string) => text.includes(h)
	};
	const ctx: RunActionContext = {
		record,
		records: [record],
		lines: [],
		params,
		db,
		supabase,
		save: saveRecordWithLines,
		log: (...args) => console.log('[Импорт выписки]', ...args),
		link: linkApi,
		apiCall,
		run: runAnotherTable,
		text,
		rows,
		helpers
	};
	let parsed: any;
	try {
		parsed = await runActionCode(parserCode, ctx);
	} catch (e: any) {
		throw new Error(`Ошибка в коде парсера банка «${bank.data?.name ?? ''}»: ${e?.message ?? e}`);
	}

	// 3. Нормализация результата парсера: { header, operations }.
	let header: StatementHeader = {};
	let rawOps: any[] = [];
	if (parsed && typeof parsed === 'object') {
		if (Array.isArray(parsed)) {
			rawOps = parsed;
		} else {
			if (parsed.header && typeof parsed.header === 'object') header = parsed.header;
			if (Array.isArray(parsed.operations)) rawOps = parsed.operations;
		}
	}
	const operations = rawOps.map(normalizeOperation).filter(Boolean) as Record<string, any>[];

	// 4. Шапка выписки.
	const data = { ...(record.data ?? {}) };
	// Автоопределённый банк проставляем в реквизит, чтобы следующий импорт
	// не полагался на распознавание по маркерам.
	if (!data.bank) data.bank = bank.id;
	if (header.statement_type) data.statement_type = String(header.statement_type);
	if (header.owner) data.owner = String(header.owner);
	if (header.account_number)
		data.account_number = String(header.account_number).replace(/\s+/g, '');
	if (header.currency) data.currency = String(header.currency);
	if (header.period_start) data.period_start = toDate(header.period_start);
	if (header.period_end) data.period_end = toDate(header.period_end);
	if (header.opening_balance != null) data.opening_balance = numOr(header.opening_balance);
	if (header.closing_balance != null) data.closing_balance = numOr(header.closing_balance);

	// 5. «Банковский счёт»: если у выписки ещё нет ссылки на счёт, находим его
	// в каталоге (по банку + номеру счёта) или создаём автоматически и привязываем.
	if (data.account_number && !data.account) {
		const accountNumber = String(data.account_number);
		const accountsTable = await db.meta_tables.where('name').equals(BANK_ACCOUNTS_TABLE).first();
		if (accountsTable) {
			const existingAccount = await db.data_records
				.where('table_id')
				.equals(accountsTable.id)
				.filter(
					(a) =>
						String(a.data?.account_number ?? '') === accountNumber &&
						(a.data?.bank ?? '') === bank.id
				)
				.first();
			if (existingAccount) {
				data.account = existingAccount.id;
			} else {
				const count = await db.data_records.where('table_id').equals(accountsTable.id).count();
				const now = new Date().toISOString();
				const account: LocalRecord = {
					id: crypto.randomUUID(),
					table_id: accountsTable.id,
					status: 'draft',
					is_folder: false,
					parent_id: null,
					data: {
						number: String(count + 1),
						name: data.owner ? `Счёт ${accountNumber} (${data.owner})` : `Счёт ${accountNumber}`,
						bank: bank.id,
						account_number: accountNumber,
						currency: data.currency ? String(data.currency) : '',
						owner: data.owner ? String(data.owner) : ''
					},
					is_dirty: 1,
					updated_at: now
				};
				await db.data_records.put(account);
				data.account = account.id;
				if (typeof navigator === 'undefined' || navigator.onLine) {
					try {
						const { is_dirty: _ignored, ...serverAccount } = account;
						await supabase.from('data_records').upsert(serverAccount);
					} catch {
						// уедет при ближайшем синке
					}
				}
			}
		}
	}

	// 6. Дедупликация: повторный импорт не дублирует уже существующие операции.
	const opsTable = await db.meta_tables.where('name').equals(BANK_OPERATIONS_TABLE).first();
	if (!opsTable) throw new Error('Нет таблицы «Операции» (ТЧ выписки)');
	const existingLines = (await db.data_lines.where('record_id').equals(recordId).toArray()).filter(
		(l) => l.table_id === opsTable.id
	);
	const seen = new Set(existingLines.map((l) => dedupeKey((l.data ?? {}) as Record<string, any>)));

	const newLines: LocalLine[] = [];
	let skipped = 0;
	for (const op of operations) {
		const key = dedupeKey(op);
		if (seen.has(key)) {
			skipped++;
			continue;
		}
		seen.add(key);
		newLines.push({
			id: crypto.randomUUID(),
			record_id: recordId,
			table_id: opsTable.id,
			data: op,
			sort_order: existingLines.length + newLines.length + 1
		});
	}

	// 7. Сохранение шапки + новых строк.
	data.operations_count = operations.length;
	delete data.last_error;
	data.last_result = [
		newLines.length > 0 ? `импортировано ${newLines.length}` : '',
		skipped > 0 ? `пропущено дублей ${skipped}` : ''
	]
		.filter(Boolean)
		.join(', ');
	const updated: LocalRecord = { ...record, data };
	await saveRecordWithLines(updated, newLines);

	return {
		ok: true,
		bank: String(bank.data?.name ?? ''),
		account: data.account_number ? String(data.account_number) : undefined,
		statement_type: data.statement_type ? String(data.statement_type) : undefined,
		period: data.period_start ? `${data.period_start} — ${data.period_end ?? '…'}` : undefined,
		operations: operations.length,
		new: newLines.length,
		skipped,
		opening: typeof data.opening_balance === 'number' ? data.opening_balance : null,
		closing: typeof data.closing_balance === 'number' ? data.closing_balance : null
	};
}
