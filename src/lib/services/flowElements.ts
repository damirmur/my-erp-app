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
//
// Модули могут добавлять собственные типы элементов через registerFlowElement —
// движок не знает про них, но диспетчер/списки их учитывают.

export interface FlowElementDef {
	type: string;
	label: string;
	icon: string;
	hint: string;
}

export const FLOW_ELEMENTS: FlowElementDef[] = [
	{ type: 'start', label: 'Старт', icon: '▶', hint: 'Входные параметры сценария' },
	{ type: 'constant', label: 'Константа', icon: '📌', hint: '{ "name": "city" }' },
	{ type: 'get', label: 'Извлечь из JSON', icon: '🪝', hint: '{ "path": "city" }' },
	{ type: 'api', label: 'Запрос API', icon: '🌐', hint: 'Сервис (ссылка) + параметры' },
	{
		type: 'template',
		label: 'Шаблон текста',
		icon: '🖼',
		hint: '{ "template": "… ${current.temp_c}" }'
	},
	{ type: 'find', label: 'Найти запись', icon: '🔍', hint: '{ "table": "…", "where": {…} }' },
	{
		type: 'create',
		label: 'Создать запись',
		icon: '➕',
		hint: '{ "table": "…", "data": {…}, "lines": {…} }'
	},
	{
		type: 'run',
		label: 'Выполнить действие',
		icon: '🏃',
		hint: '{ "table": "…", "record": "${id}" }'
	},
	{ type: 'code', label: 'Код', icon: '🧩', hint: 'Произвольный JS (колонка «Код узла»)' },
	{
		type: 'agent',
		label: 'ИИ-агент',
		icon: '🤖',
		hint: '{ "model": "…", "prompt": "…", "data": {…} }'
	}
];

// Реестр внешних элементов (модули: банк, импорт и т.д.). Движок их не знает,
// но диспетчер runFlowElement и списки выбора учитывают.
export type FlowElementHandler = (e: FlowElementInput) => Promise<unknown>;

const externalElements = new Map<string, { def: FlowElementDef; handler: FlowElementHandler }>();

export function registerFlowElement(
	type: string,
	def: FlowElementDef,
	handler: FlowElementHandler
): void {
	externalElements.set(type, { def, handler });
}

function allElementDefs(): FlowElementDef[] {
	return [...FLOW_ELEMENTS, ...[...externalElements.values()].map((e) => e.def)];
}

export function flowElementLabel(type: string): string {
	return allElementDefs().find((e) => e.type === type)?.label ?? type;
}

export function flowElementIcon(type: string): string {
	return allElementDefs().find((e) => e.type === type)?.icon ?? '';
}

// Варианты выбора для колонок «Тип»: в ТЧ «Узлы» — колонка node_type,
// в каталоге «Элементы сценария» — element_type (тип поля «Выбор из списка»).
export function selectOptionsFor(
	tableName: string,
	columnName: string
): { value: string; label: string }[] {
	if (
		(tableName === 'flow_nodes' && columnName === 'node_type') ||
		(tableName === 'flow_elements' && columnName === 'element_type')
	) {
		return allElementDefs().map((e) => ({ value: e.type, label: e.label }));
	}
	if (tableName === 'flow_scenarios' && columnName === 'trigger_event') {
		return [
			{ value: 'save', label: 'При сохранении' },
			{ value: 'post', label: 'При проведении' },
			{ value: 'unpost', label: 'При отмене проведения' },
			{ value: 'delete', label: 'При удалении' }
		];
	}
	return [];
}

// Асинхронная версия выбора для колонок, чей список зависит от данных
// (например, target_table у печатных форм — все таблицы верхнего уровня).
export async function loadSelectOptions(
	tableName: string,
	columnName: string
): Promise<{ value: string; label: string }[]> {
	if (tableName === 'print_forms' && columnName === 'target_table') {
		const tables = await db.meta_tables.filter((t) => !t.parent_table_id).toArray();
		return tables
			.sort((a, b) => a.title.localeCompare(b.title))
			.map((t) => ({ value: t.id, label: t.title }));
	}
	return selectOptionsFor(tableName, columnName);
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
// Несуществующие пути заменяются пустой строкой. Если вся строка — одна точная
// подстановка (${путь}), значение сохраняет свой тип (массив/объект), иначе
// подставляется в строку. Это позволяет передавать массивы (например, в lines).
export function substitute(value: unknown, ctx: Record<string, any>): any {
	if (typeof value === 'string') {
		const exact = value.match(/^\$\{([^}]+)\}$/);
		if (exact) {
			const v = pathGet(ctx, exact[1].trim());
			if (v !== undefined) return v;
		}
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

// Ограничение времени ожидания запроса: офлайн-запуск сценария не должен висеть
// на fetch к недоступному серверу дольше заданного лимита.
function withTimeout<T>(prom: PromiseLike<T>, ms: number): Promise<T> {
	return Promise.race([
		Promise.resolve(prom),
		new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`таймаут (${ms} мс)`)), ms))
	]);
}

// Универсальный ретрай для элементов сценария: повторяет fn, пока она бросает,
// с нарастающей паузой delay * attempt. attempts=1 — без повторов. Механика
// принадлежит движку; включение/настройка для конкретного элемента — данные
// (параметры узла retry / retryDelay), т.к. повтор неидемпотентного вызова
// небезопасен по умолчанию. Итоговая ошибка при попытках > 1 помечается числом.
async function withRetry<T>(
	fn: (attempt: number) => Promise<T>,
	opts: { attempts?: number | string; delay?: number | string; label?: string }
): Promise<T> {
	const attempts = Math.max(1, Math.min(Number(opts.attempts) || 3, 10));
	const delay = Math.max(0, Number(opts.delay) || 1500);
	let lastErr: unknown = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn(attempt);
		} catch (e) {
			lastErr = e;
			if (attempt >= attempts) {
				if (attempts > 1 && e instanceof Error) {
					throw new Error(`${e.message} (после ${attempts} попыток)`);
				}
				throw e;
			}
			console.warn(
				`${opts.label ?? 'Повтор'}: ${e instanceof Error ? e.message : String(e)}, попытка ${attempt + 1}/${attempts}`
			);
			await new Promise((r) => setTimeout(r, delay * attempt));
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
	// Параметры ретрая из узла (данные): retry и retryDelay НЕ передаются в сам
	// запрос. По умолчанию повторов нет — повтор неидемпотентного вызова небезопасен.
	const retry = Number(resolved.retry);
	const retryDelay = Number(resolved.retryDelay);
	const { retry: _retry, retryDelay: _retryDelay, ...callParams } = resolved;
	const res = await withRetry(
		async () => {
			const r = await apiCall(service, callParams);
			if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(r.raw).slice(0, 300)}`);
			return r;
		},
		{
			attempts: retry > 0 ? retry : 1,
			delay: retryDelay > 0 ? retryDelay : 1500,
			label: 'Узел «Запрос API»'
		}
	).catch((e: any) => {
		throw new Error(`Узел «Запрос API»: ${e?.message ?? String(e)}`);
	});
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

async function elementFind({
	input,
	params,
	scenarioParams,
	scenario
}: FlowElementInput): Promise<unknown> {
	const ctx = subContext(input, scenarioParams);
	// Подстраховка: если параметры сценария не доехали в контекст движка
	// (например, data.params хранится строкой), берём их напрямую из записи
	// сценария — недостающие ключи добавляем, но не переопределяем.
	const directParams = scenario?.data?.params;
	let direct: Record<string, any> | null = null;
	if (directParams && typeof directParams === 'object' && !Array.isArray(directParams)) {
		direct = directParams;
	} else if (typeof directParams === 'string' && directParams.trim()) {
		try {
			const parsed = JSON.parse(directParams);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) direct = parsed;
		} catch {
			// битый JSON — игнорируем
		}
	}
	if (direct) {
		for (const [k, v] of Object.entries(direct)) {
			if (ctx[k] === undefined) ctx[k] = v;
		}
	}

	const p = substitute(params, ctx);
	const tableName = String(p.table ?? '');
	if (!tableName) throw new Error('Узел «Найти запись»: укажите table');
	const table = await db.meta_tables.where('name').equals(tableName).first();
	if (!table) throw new Error(`Узел «Найти запись»: нет таблицы «${tableName}»`);
	const tableId = table.id;
	const parentTableId = table.parent_table_id;
	const where = p.where && typeof p.where === 'object' && !Array.isArray(p.where) ? p.where : {};
	// Строки ТЧ (parent_table_id задан) ищем в data_lines, иначе — в data_records.
	// Ищем в обеих сразу: локальный кэш метаданных может отставать (parent_table_id
	// ещё не подтянут), тогда строки ТЧ лежат только в data_lines.
	const isLine = !!(parentTableId || p.line === true);
	// all: true — вернуть ВСЕ совпадения (массив), а не первое. Значения where,
	// являющиеся массивами, трактуются как «in» (запись подходит, если её значение
	// входит в список) — это позволяет искать контакты сразу нескольких объектов.
	const all = p.all === true;

	// map: { имя_в_результате: 'поле_источника' } — переложить найденные строки
	// в нужную форму (например, контакты → строки получателей { kontragent, channel }).
	function mapped(row: any): Record<string, any> {
		if (!p.map || typeof p.map !== 'object' || Array.isArray(p.map)) return row;
		const mapSpec: Record<string, string> = p.map;
		const out: Record<string, any> = {};
		for (const [k, srcKey] of Object.entries(mapSpec)) {
			out[k] = row[srcKey] ?? row.data?.[srcKey] ?? '';
		}
		return out;
	}

	function toResult(row: any): Record<string, any> {
		if (!p.map || typeof p.map !== 'object' || Array.isArray(p.map)) {
			return { id: row.id, record_id: row.record_id ?? null, ...(row.data ?? {}) };
		}
		return mapped(row);
	}

	function matches(row: any): boolean {
		for (const [k, v] of Object.entries(where)) {
			const rv = row[k] ?? row.data?.[k];
			const srv = String(rv ?? '');
			if (Array.isArray(v)) {
				if (!v.map(String).includes(srv)) return false;
			} else if (srv !== String(v ?? '')) return false;
		}
		return true;
	}

	async function searchLocal(): Promise<any[]> {
		const [lineRows, recordRows] = await Promise.all([
			db.data_lines.where('table_id').equals(tableId).toArray(),
			db.data_records.where('table_id').equals(tableId).toArray()
		]);
		return [...lineRows, ...recordRows].filter((row) => matches(row));
	}

	// 1. Локальный кэш (offline-first)
	let found: any[] = await searchLocal();

	// 2. Fallback на сервер: если локально не найдено — ищем напрямую в Supabase.
	// Пробуем всегда: navigator.onLine бывает неточным (ошибочно «false» при живом
	// интернете), а таймаут защищает офлайн-запуск от долгого ожидания. Короткая
	// пауза даёт шанс текущему синку докачать свежие строки.
	// Строки ТЧ живут в data_lines с table_id = id подчинённой таблицы. Id берём
	// с сервера по name (авторитетный); если локальный кэш метаданных отстаёт и id
	// разошлись — ищем по обоим.
	if (found.length === 0) {
		if (typeof window !== 'undefined') await new Promise((r) => setTimeout(r, 1200));
		found = await searchLocal();
		try {
			const serverTable = await withTimeout(
				supabase
					.from('meta_tables')
					.select('id,parent_table_id')
					.eq('name', tableName)
					.maybeSingle(),
				8000
			);
			const sid = serverTable.data?.id ?? tableId;
			const serverIsLine = !!(serverTable.data?.parent_table_id || p.line === true);
			const src = serverIsLine ? 'data_lines' : tableName;
			const q = supabase.from(src).select('*').limit(1000);
			if (serverIsLine) {
				if (sid !== tableId) q.in('table_id', [sid, tableId]);
				else q.eq('table_id', sid);
			}
			const { data, error } = await withTimeout(q, 8000);
			const serverRows: any[] = data ?? [];
			if (error) {
				console.warn(`Узел «Найти запись»: запрос к серверу не удался (${error.message})`);
			} else if (serverRows.length > 0) {
				const candidates = serverRows.map((r: any) => ({
					id: r.id,
					record_id: r.record_id ?? null,
					data: r.data ?? {}
				}));
				found = candidates.filter((row) => matches(row));
			}
			// Найденные строки доливаем в локальный кэш, чтобы последующие узлы
			// (например, «Отправить» → NOTIFY_RUN_CODE) видели контакты.
			if (found.length > 0 && serverIsLine) {
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
		} catch (e) {
			console.warn('Узел «Найти запись»: сервер недоступен, работаю по локальному кэшу', e);
		}
	}

	if (found.length === 0) {
		console.warn(
			`Узел «Найти запись»: в «${tableName}» ничего не найдено. where=`,
			JSON.stringify(where),
			'ctxKeys=',
			JSON.stringify(Object.keys(ctx)),
			'scenarioParams=',
			JSON.stringify(scenario?.data?.params ?? null)
		);
		throw new Error(`Узел «Найти запись»: в «${tableName}» ничего не найдено`);
	}

	if (all) return found.map(toResult);
	return toResult(found[0]);
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

// Резолв модели: id строки ТЧ каталога «Модели» (providers_llm → models, поле data.id
// = имя модели для API) либо имя модели напрямую.
async function resolveModel(model: unknown): Promise<string> {
	const m = String(model ?? '').trim();
	if (!m) throw new Error('Узел «ИИ-агент»: укажите model (имя или строка каталога «Модели»)');
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (uuid.test(m)) {
		let line = await db.data_lines.get(m);
		if (!line) {
			try {
				const { data } = await supabase.from('data_lines').select('data').eq('id', m).maybeSingle();
				if (data) line = data as any;
			} catch {
				// сервер недоступен — работаем по кэшу
			}
		}
		if (line) {
			const name = line.data?.id ?? line.data?.name ?? line.data?.model;
			if (name) return String(name);
		}
	}
	return m;
}

// Элемент «ИИ-агент»: OpenAI-совместимый chat/completions (routerai.ru и др.).
// Параметры:
//   model  — имя модели или id строки ТЧ «Модели» провайдера (data.id);
//   prompt — текст запроса (с ${...} подстановками, ${input} — вход узла);
//   data   — входные данные (JSON): если задан, присоединяется к prompt;
//            если нет — в качестве данных берётся вход узла (если prompt без ${input});
//   system — опциональный системный промпт;
//   temperature / max_tokens — опции вызова.
// Сервис (node.data.service): OpenAI-совместимый endpoint (base_url заканчивается
// на /chat/completions), авторизация api_key (для routerai — "Bearer <ключ>" в auth_type=header).
async function elementAgent({
	node,
	input,
	params,
	scenarioParams,
	apiCall
}: FlowElementInput): Promise<unknown> {
	const serviceId = node.data?.service ? String(node.data.service) : '';
	if (!serviceId) throw new Error('Узел «ИИ-агент»: укажите Сервис API');
	const service = await db.data_records.get(serviceId);
	if (!service) throw new Error('Узел «ИИ-агент»: сервис не найден');

	const ctx = subContext(input, scenarioParams);
	const p = substitute(params, ctx);
	const model = await resolveModel(p.model);

	// Точка вызова: если у сервиса base_url без /chat/completions — дополняем.
	let url = String(service.data?.base_url ?? '').replace(/\/+$/, '');
	if (!url) throw new Error('Узел «ИИ-агент»: у сервиса не задан base_url');
	if (!url.endsWith('/chat/completions')) url += '/chat/completions';
	const svc = { ...service, data: { ...service.data, base_url: url } };

	const system = p.system ? String(p.system) : '';
	let content = String(p.prompt ?? '');
	const hasData = p.data !== undefined && p.data !== null && p.data !== '';
	if (hasData) {
		content += '\n\n' + (typeof p.data === 'string' ? p.data : JSON.stringify(p.data, null, 2));
	}
	if (!content && input != null) {
		content = typeof input === 'string' ? String(input) : JSON.stringify(input, null, 2);
	}
	if (!content.trim()) throw new Error('Узел «ИИ-агент»: задайте prompt или data');

	const messages: { role: string; content: string }[] = [];
	if (system) messages.push({ role: 'system', content: system });
	messages.push({ role: 'user', content });

	const body: Record<string, any> = { model, messages };
	if (p.temperature != null) body.temperature = Number(p.temperature);
	if (p.max_tokens != null) body.max_tokens = Number(p.max_tokens);

	// Ретрай при сбое HTTP или пустом ответе модели (некоторые провайдеры
	// периодически отдают пустой content). Механика — универсальный withRetry;
	// число попыток/пауза переопределяются параметрами узла retry / retryDelay.
	const attempts = Number(p.retry) > 0 ? Number(p.retry) : 3;
	const delay = Number(p.retryDelay) > 0 ? Number(p.retryDelay) : 1500;
	const answer = await withRetry(
		async () => {
			const res = await apiCall(svc, {}, body);
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(res.raw).slice(0, 300)}`);
			const text = res.data?.choices?.[0]?.message?.content;
			if (text == null || String(text).trim() === '') throw new Error('пустой ответ модели');
			return text;
		},
		{ attempts, delay, label: 'Узел «ИИ-агент»' }
	).catch((e: any) => {
		throw new Error(`Узел «ИИ-агент»: ${e?.message ?? String(e)}`);
	});
	return answer;
}

// Запуск элемента по типу узла. Сначала встроенные, затем внешние (модули).
// Неизвестный тип — просто прокладывает вход.
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
		case 'agent':
			return elementAgent(e);
		default: {
			const ext = externalElements.get(type);
			if (ext) return ext.handler(e);
			return e.input ?? e.params;
		}
	}
}
