import { db, type LocalLine, type LocalRecord } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import type { ApiCallResult } from '$lib/services/actionRunner';

// Каталог элементов сценария (аналог узлов n8n). Каждый элемент — готовый
// «преобразователь»: постоянная, извлечение из JSON, запрос API, шаблон текста,
// поиск записи, создание записи, запуск действия другой таблицы. Узел сценария
// выбирает элемент колонкой node_type и настраивает его полем params (jsonb).
//
// Подстановки ${путь}: в параметрах узла можно ссылаться на результат
// предыдущего узла (${input} — целиком, ${city} — ключ входного объекта,
// ${current.temp_c} — вложенный путь) и на входные параметры сценария.

export interface FlowElementDef {
	type: string;
	label: string;
	hint: string;
}

export const FLOW_ELEMENTS: FlowElementDef[] = [
	{ type: 'start', label: 'Старт', hint: 'Входные параметры сценария' },
	{ type: 'constant', label: 'Константа', hint: '{ "name": "city" }' },
	{ type: 'get', label: 'Извлечь из JSON', hint: '{ "path": "city" }' },
	{ type: 'api', label: 'Запрос API', hint: 'Сервис (ссылка) + параметры' },
	{ type: 'template', label: 'Шаблон текста', hint: '{ "template": "… ${current.temp_c}" }' },
	{ type: 'find', label: 'Найти запись', hint: '{ "table": "…", "where": {…} }' },
	{ type: 'create', label: 'Создать запись', hint: '{ "table": "…", "data": {…}, "lines": {…} }' },
	{ type: 'run', label: 'Выполнить действие', hint: '{ "table": "…", "record": "${id}" }' },
	{ type: 'code', label: 'Код', hint: 'Произвольный JS (колонка «Код узла»)' }
];

export function flowElementLabel(type: string): string {
	return FLOW_ELEMENTS.find((e) => e.type === type)?.label ?? type;
}

// Варианты выбора для колонки node_type ТЧ «Узлы» (тип поля «Выбор из списка»).
export function selectOptionsFor(
	tableName: string,
	columnName: string
): { value: string; label: string }[] {
	if (tableName === 'flow_nodes' && columnName === 'node_type') {
		return FLOW_ELEMENTS.map((e) => ({ value: e.type, label: e.label }));
	}
	return [];
}

// Доступ к значению по точечному пути (current.temp_c)
export function pathGet(obj: unknown, path: string): unknown {
	const parts = String(path).split('.').filter(Boolean);
	let cur: any = obj;
	for (const p of parts) {
		if (cur == null) return undefined;
		cur = cur[p];
	}
	return cur;
}

// Подстановка ${path} в строках и рекурсивно в объектах/массивах.
// Несуществующие пути заменяются пустой строкой.
export function substitute(value: unknown, ctx: Record<string, any>): any {
	if (typeof value === 'string') {
		return value.replace(/\$\{([^}]+)\}/g, (_, p: string) => {
			const v = pathGet(ctx, p.trim());
			if (v === undefined) return '';
			return typeof v === 'object' ? JSON.stringify(v) : String(v);
		});
	}
	if (Array.isArray(value)) return value.map((v) => substitute(v, ctx));
	if (value && typeof value === 'object') {
		const out: Record<string, any> = {};
		for (const k of Object.keys(value as Record<string, any>)) {
			out[k] = substitute((value as Record<string, any>)[k], ctx);
		}
		return out;
	}
	return value;
}

// Контекст подстановок для узла: входные параметры сценария + результат
// предыдущего узла (${input} целиком, ключи объекта — напрямую).
function subContext(input: unknown, scenarioParams: Record<string, any>): Record<string, any> {
	const ctx: Record<string, any> = { ...(scenarioParams ?? {}), input };
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		Object.assign(ctx, input);
	}
	return ctx;
}

// Значение константы: универсальное поле хранит { t, v } — отдаём v
function unwrapUniversal(v: unknown): unknown {
	if (v && typeof v === 'object' && typeof (v as any).t === 'string') return (v as any).v;
	return v;
}

export interface FlowElementInput {
	node: LocalLine;
	input: unknown;
	params: Record<string, any>;
	scenario: LocalRecord;
	scenarioLines: LocalLine[];
	scenarioParams: Record<string, any>;
	apiCall: (
		service: string | LocalRecord,
		params?: Record<string, any>,
		body?: unknown
	) => Promise<ApiCallResult>;
	runAnotherTable: (tableName: string, recordId: string) => Promise<unknown>;
	saveRecordWithLines: (record: LocalRecord, lines?: LocalLine[]) => Promise<void>;
}

// Реализации элементов. Каждый возвращает результат узла для следующих узлов.
async function elementConstant({ params }: FlowElementInput): Promise<unknown> {
	const name = String(params.name ?? '');
	if (!name) throw new Error('Узел «Константа»: укажите name');
	const constantsTable = await db.meta_tables.where('name').equals('constants').first();
	if (!constantsTable) throw new Error('Нет таблицы «Константы»');
	const rec = await db.data_records
		.where('table_id')
		.equals(constantsTable.id)
		.filter((r) => r.data?.name === name)
		.first();
	if (!rec) throw new Error(`Константа «${name}» не найдена`);
	return unwrapUniversal(rec.data?.value);
}

async function elementGet({ input, params }: FlowElementInput): Promise<unknown> {
	const path = String(params.path ?? '');
	if (!path) return input;
	// Нечего извлекать (строка/число) — пропускаем значение как есть.
	// Так узел работает и с константой-строкой, и с JSON-константой.
	if (input == null || typeof input !== 'object' || Array.isArray(input)) {
		return input ?? params;
	}
	const v = pathGet(input, path);
	// Путь не найден — отдаём вход целиком (узел не «съедает» данные)
	return v === undefined ? input : v;
}

async function elementApi({
	node,
	input,
	params,
	scenarioParams,
	apiCall
}: FlowElementInput): Promise<unknown> {
	const serviceId = node.data?.service ? String(node.data.service) : '';
	if (!serviceId) throw new Error('Узел «Запрос API»: укажите Сервис API');
	const service = await db.data_records.get(serviceId);
	if (!service) throw new Error('Узел «Запрос API»: сервис не найден');
	const ctx = subContext(input, scenarioParams);
	const resolved = substitute(params, ctx);
	const res = await apiCall(service, resolved);
	if (!res.ok) {
		throw new Error(`Узел «Запрос API»: HTTP ${res.status}: ${String(res.raw).slice(0, 300)}`);
	}
	return res.data ?? res.raw;
}

async function elementTemplate({
	input,
	params,
	scenarioParams
}: FlowElementInput): Promise<unknown> {
	const template = String(params.template ?? params.text ?? '');
	const ctx = subContext(input, scenarioParams);
	return substitute(template, ctx);
}

async function elementFind({ input, params, scenarioParams }: FlowElementInput): Promise<unknown> {
	const ctx = subContext(input, scenarioParams);
	const p = substitute(params, ctx);
	const tableName = String(p.table ?? '');
	if (!tableName) throw new Error('Узел «Найти запись»: укажите table');
	const table = await db.meta_tables.where('name').equals(tableName).first();
	if (!table) throw new Error(`Узел «Найти запись»: нет таблицы «${tableName}»`);
	const where = p.where && typeof p.where === 'object' && !Array.isArray(p.where) ? p.where : {};
	// Строки ТЧ (parent_table_id задан) ищем в data_lines, иначе — в data_records
	const isLine = !!(table.parent_table_id || p.line === true);

	function matches(row: any): boolean {
		for (const [k, v] of Object.entries(where)) {
			const rv = row[k] ?? row.data?.[k];
			if (String(rv ?? '') !== String(v ?? '')) return false;
		}
		return true;
	}

	// 1. Локальный кэш (offline-first)
	let rows: any[] = isLine
		? await db.data_lines.where('table_id').equals(table.id).toArray()
		: await db.data_records.where('table_id').equals(table.id).toArray();
	let match = rows.find((row) => matches(row));

	// 2. Fallback на сервер: если онлайн и локально пусто/не найдено — ищем
	// напрямую в Supabase. Строки ТЧ живут в data_lines с table_id = id
	// подчинённой таблицы. Id таблицы берём с сервера по name (авторитетный),
	// т.к. локальный кэш метаданных может отставать.
	if (!match && (typeof navigator === 'undefined' || navigator.onLine)) {
		try {
			const serverTable = await supabase
				.from('meta_tables')
				.select('id,parent_table_id')
				.eq('name', tableName)
				.maybeSingle();
			const sid = serverTable.data?.id ?? table.id;
			const serverIsLine = !!(serverTable.data?.parent_table_id || p.line === true);
			const src = serverIsLine ? 'data_lines' : tableName;
			const q = supabase.from(src).select('*').limit(1000);
			if (serverIsLine) q.eq('table_id', sid);
			const { data, error } = await q;
			const serverRows: any[] = data ?? [];
			if (!error && serverRows.length > 0) {
				const candidates = serverRows.map((r: any) => ({
					id: r.id,
					record_id: r.record_id ?? null,
					data: r.data ?? {}
				}));
				match = candidates.find((row) => matches(row));
			}
			// Найденные строки доливаем в локальный кэш, чтобы последующие узлы
			// (например, «Отправить» → NOTIFY_RUN_CODE) видели контакты.
			if (match && serverIsLine) {
				await db.data_lines.bulkPut(
					serverRows.map((r: any) => ({
						id: r.id,
						record_id: r.record_id ?? null,
						table_id: r.table_id ?? sid,
						data: r.data ?? {},
						sort_order: r.sort_order ?? 0
					}))
				);
			}
		} catch {
			// сервер недоступен — оставляем локальный результат
		}
	}

	if (!match) throw new Error(`Узел «Найти запись»: в «${tableName}» ничего не найдено`);
	return { id: match.id, record_id: match.record_id ?? null, ...(match.data ?? {}) };
}

async function elementCreate({
	input,
	params,
	scenarioParams,
	saveRecordWithLines
}: FlowElementInput): Promise<unknown> {
	const ctx = subContext(input, scenarioParams);
	const p = substitute(params, ctx);
	const tableName = String(p.table ?? '');
	if (!tableName) throw new Error('Узел «Создать запись»: укажите table');
	const table = await db.meta_tables.where('name').equals(tableName).first();
	if (!table) throw new Error(`Узел «Создать запись»: нет таблицы «${tableName}»`);

	const id = crypto.randomUUID();
	const data = p.data && typeof p.data === 'object' && !Array.isArray(p.data) ? p.data : {};
	const record: LocalRecord = {
		id,
		table_id: table.id,
		status: 'draft',
		data,
		is_dirty: 1,
		updated_at: new Date().toISOString()
	};

	const lines: LocalLine[] = [];
	const linesSpec =
		p.lines && typeof p.lines === 'object' && !Array.isArray(p.lines) ? p.lines : {};
	for (const [subName, rows] of Object.entries(linesSpec)) {
		const sub = await db.meta_tables.where('name').equals(subName).first();
		if (!sub || !Array.isArray(rows)) continue;
		rows.forEach((rowData: Record<string, any>, i: number) => {
			lines.push({
				id: crypto.randomUUID(),
				record_id: id,
				table_id: sub.id,
				data: rowData ?? {},
				sort_order: i
			});
		});
	}

	await saveRecordWithLines(record, lines);
	return { id, ...data };
}

async function elementRun({
	input,
	params,
	scenarioParams,
	runAnotherTable
}: FlowElementInput): Promise<unknown> {
	const ctx = subContext(input, scenarioParams);
	const p = substitute(params, ctx);
	const tableName = String(p.table ?? '');
	const recordId = String(p.record ?? '');
	if (!tableName || !recordId) throw new Error('Узел «Выполнить действие»: укажите table и record');
	return await runAnotherTable(tableName, recordId);
}

// Запуск элемента по типу узла. Неизвестный тип — просто прокладывает вход.
export async function runFlowElement(type: string, e: FlowElementInput): Promise<unknown> {
	switch (type) {
		case 'constant':
			return elementConstant(e);
		case 'get':
			return elementGet(e);
		case 'api':
			return elementApi(e);
		case 'template':
			return elementTemplate(e);
		case 'find':
			return elementFind(e);
		case 'create':
			return elementCreate(e);
		case 'run':
			return elementRun(e);
		default:
			return e.input ?? e.params;
	}
}
