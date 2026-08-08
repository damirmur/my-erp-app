import { db, type LocalLine, type LocalRecord } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { buildRecordUrl, linkApi } from '$lib/services/deeplink';
import { workspace } from '$lib/state/workspace.svelte';
import { flowHelper, type FlowStep } from '$lib/services/flowRunner';
import { importStatement } from '$lib/services/bankParser';
import { autoFillDocumentFields } from '$lib/services/numbers';

// Контекст, передаваемый в пользовательский код действия «Выполнить».
// Доступно из кода: record, records, lines, params, db, supabase, save(), log(),
// link, apiCall(), run(), flow(), importStatement(). В узлах сценария
// дополнительно: input (результат предыдущего узла), inputs (все входы по ролям).
// В коде-парсере банка (importStatement) дополнительно: text (текст PDF),
// rows (строки таблицы), helpers (утилиты num/amount/date/hint).
export interface RunActionContext {
	record: LocalRecord | null; // Текущая запись (в форме — открытая; в списке — первая выбранная)
	records: LocalRecord[]; // Выбранные записи (в форме — [record])
	lines: LocalLine[]; // Строки табличных частей текущей записи (если есть)
	params: Record<string, any>; // Входные параметры (API-режим: #/r/{id}.execute({...}).json)
	db: typeof db;
	supabase: typeof supabase;
	save: (record: LocalRecord, lines?: LocalLine[]) => Promise<void>;
	log: (...args: unknown[]) => void;
	link: typeof linkApi; // Генерация уникальных ссылок и получение значений по ним
	apiCall: typeof apiCall; // Вызов внешнего API по записи справочника «Сервисы API»
	run: (tableName: string, recordId: string) => Promise<unknown>; // Выполнить код действия другой таблицы
	input?: unknown; // В узлах сценария: результат предшествующего узла (роль flow/input)
	inputs?: Record<string, unknown>; // В узлах сценария: все входы по ролям связей
	flow?: (recordId: string, params?: Record<string, any>) => Promise<unknown>; // Выполнить сценарий
	importStatement?: typeof importStatement; // Импорт банковской выписки из PDF
	text?: string; // В коде-парсера банка: весь текст PDF
	rows?: unknown[]; // В коде-парсера банка: строки таблицы из координат
	helpers?: Record<string, any>; // В коде-парсера банка: утилиты num/amount/date/hint
}

// Выполнение JS-кода действия в браузере. Код — тело async-функции.
// Переменные контекста (record, records, lines, params, db, supabase, save,
// log, link, apiCall, run, flow, input, inputs) доступны в коде как локальные
// имена без префикса ctx.
export async function runActionCode(code: string, ctx: RunActionContext): Promise<unknown> {
	const paramNames = [
		'record',
		'records',
		'lines',
		'params',
		'db',
		'supabase',
		'save',
		'log',
		'link',
		'apiCall',
		'run',
		'flow',
		'input',
		'inputs',
		'importStatement',
		'text',
		'rows',
		'helpers'
	];
	const values = paramNames.map((k) => (ctx as unknown as Record<string, unknown>)[k]);
	const fn = new Function(...paramNames, `return (async () => {\n${code}\n})();`);
	return await fn(...values);
}

// Слияние входных параметров: дефолты из jsonb-поля «Параметры» записи
// (record.data.params) переопределяются параметрами из ссылки/кнопки по ключу.
// Для записей без дефолтов возвращает просто параметры вызова. Принимает params
// и как объект, и как JSON-строку (некоторые формы хранят jsonb строкой).
export function mergeParams(
	record: LocalRecord | null,
	linkParams: Record<string, any> = {}
): Record<string, any> {
	let defaults: Record<string, any> = {};
	const p = record?.data?.params;
	if (p && typeof p === 'object' && !Array.isArray(p)) {
		defaults = p;
	} else if (typeof p === 'string' && p.trim()) {
		try {
			const parsed = JSON.parse(p);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) defaults = parsed;
		} catch {
			// битый JSON — игнорируем
		}
	}
	return { ...defaults, ...(linkParams ?? {}) };
}

// Хелпер «Выполнить»: запускает код действия другой таблицы по её имени
// (например, run('notify_messages', id) — отправить созданное «Сообщение»).
export async function runAnotherTable(tableName: string, recordId: string): Promise<unknown> {
	const table = await db.meta_tables.where('name').equals(tableName).first();
	if (!table) throw new Error('Нет таблицы ' + tableName);
	const code = table.config?.runCode;
	if (!code?.trim()) throw new Error('У таблицы ' + tableName + ' не задан код действия');
	const record = await db.data_records.get(recordId);
	if (!record) throw new Error('Запись не найдена: ' + recordId);
	const lines = await db.data_lines.where('record_id').equals(recordId).toArray();
	return await runActionCode(code, {
		record,
		records: [record],
		lines,
		params: mergeParams(record),
		db,
		supabase,
		save: saveRecordWithLines,
		log: (...args) => console.log('[Выполнить]', ...args),
		link: linkApi,
		apiCall,
		run: runAnotherTable,
		flow: flowHelper,
		importStatement
	});
}

// API-режим: выполнить код действия таблицы по конкретной записи без открытия
// формы/списка (deep-link #/r/{id}.execute({...}).json или кнопка «▶️ Выполнить»).
// Параметры ссылки сливаются с дефолтами записи (jsonb «Параметры») через
// mergeParams и попадают в контекст как `params`; возвращаемое кодом значение —
// в result.value. Если код действия не задан — декларативный вызов apiCall
// (см. ниже). Никогда не бросает исключений (ошибки — в result.error).
export interface RunRecordResult {
	ok: boolean;
	value?: unknown;
	error?: string;
	steps?: FlowStep[];
	// Признак выполнения сценария (тип таблицы 'flow'): результат всегда пишется
	// в историю, а панель «API» открывается только при ошибке (см. workspace).
	isFlow?: boolean;
}

export async function runRecordAction(
	recordId: string,
	params: Record<string, any> = {}
): Promise<RunRecordResult> {
	// isFlow известен только после загрузки таблицы, но нужен и в catch (ошибка
	// сценария тоже должна попасть в историю) — поэтому выносим наружу.
	let isFlow = false;
	try {
		const record = await db.data_records.get(recordId);
		if (!record) return { ok: false, error: 'Запись не найдена: ' + recordId };
		const table = (await db.meta_tables.get(record.table_id)) ?? null;
		if (!table) return { ok: false, error: 'Таблица записи не найдена' };
		// Слияние дефолтов записи (jsonb «Параметры») с параметрами вызова
		params = mergeParams(record, params);
		isFlow = table.type === 'flow';

		// Тип «Сценарий» (flow): граф из ТЧ «Узлы»/«Связи» исполняется движком
		// flowRunner даже если у таблицы не задан свой runCode (см. сид flows.ts).
		if (isFlow && !table.config?.runCode?.trim()) {
			const value = await flowHelper(record.id, params);
			return { ok: true, value, steps: extractSteps(value), isFlow };
		}

		const code = table.config?.runCode;
		if (!code?.trim()) {
			// Декларативный режим без кода действия:
			// 1) «API-запрос» (каталог api_queries): есть ссылка «Сервис» на
			//    api_services → apiCall(сервис, params);
			// 2) запись-сервис: есть base_url → apiCall(запись, params).
			// Ссылка #/r/{id}.execute({...}).json становится готовым endpoint'ом.
			if (record.data?.service) {
				const serviceRecord = await db.data_records.get(String(record.data.service));
				if (!serviceRecord) {
					return { ok: false, error: 'Сервис API не найден по ссылке' };
				}
				const res = await apiCall(serviceRecord, params);
				return {
					ok: res.ok,
					value: res.data ?? res.raw,
					error: res.ok ? undefined : `HTTP ${res.status}: ${String(res.raw).slice(0, 300)}`
				};
			}
			if (record.data?.base_url) {
				const res = await apiCall(record, params);
				return {
					ok: res.ok,
					value: res.data ?? res.raw,
					error: res.ok ? undefined : `HTTP ${res.status}: ${String(res.raw).slice(0, 300)}`
				};
			}
			return {
				ok: false,
				error: `У таблицы «${table.title}» не задан код действия «Выполнить»`
			};
		}
		const lines = await db.data_lines.where('record_id').equals(record.id).toArray();
		const value = await runActionCode(code, {
			record,
			records: [record],
			lines,
			params,
			db,
			supabase,
			save: saveRecordWithLines,
			log: (...args) => console.log('[Выполнить API]', ...args),
			link: linkApi,
			apiCall,
			run: runAnotherTable,
			flow: flowHelper,
			importStatement
		});
		return { ok: true, value, steps: extractSteps(value), isFlow };
	} catch (e: any) {
		return { ok: false, error: e?.message ?? String(e), steps: (e as any)?.steps, isFlow };
	}
}

// Шаги сценария из результата выполнения (FlowRunResult содержит steps).
function extractSteps(value: unknown): FlowStep[] | undefined {
	const s = (value as any)?.steps;
	return Array.isArray(s) && s.length > 0 ? s : undefined;
}

// Шлюз astro3d по умолчанию (для старых записей с use_proxy=true). Для новых
// записей шлюз задаётся полем-ссылкой «Прокси» (base_url сервиса-шлюза).
const PROXY_URL = 'https://astro3d.ru/api/proxy';

export interface ApiCallResult {
	ok: boolean;
	status: number;
	data: any;
	raw: string;
}

// Вызов внешнего API по записи справочника «Сервисы API» (id записи или сама запись).
// service.data: { base_url (шаблон с ${param}), method, auth_type, auth_param, api_key,
// headers (JSON), proxy (ссылка на сервис-шлюз) }.
// - ${param} в base_url подставляются из params (значения URL-кодируются);
// - auth_type=query → auth_param=api_key в query, auth_type=header → в заголовок;
// - поле «Прокси» = ссылка на другой сервис (шлюз): запрос уходит на base_url шлюза
//   (например, astro3d.ru/api/proxy), ключ доступа шлюза — api_key сервиса-шлюза.
//   Пустое поле → прямой fetch из браузера (для старых записей use_proxy=true остаётся
//   шлюз astro3d по умолчанию).
// Возвращает { ok, status, data, raw } — разбор JSON с fallback на сырой текст.
export async function apiCall(
	service: string | LocalRecord,
	params: Record<string, any> = {},
	body?: unknown
): Promise<ApiCallResult> {
	const svc = typeof service === 'string' ? await db.data_records.get(service) : service;
	if (!svc) throw new Error('Сервис API не найден');
	const d = svc.data ?? {};

	let url = String(d.base_url || '');
	for (const [k, v] of Object.entries(params)) {
		url = url.split(`\${${k}}`).join(v == null ? '' : encodeURIComponent(String(v)));
	}
	if (!url) throw new Error('У сервиса не задан base_url');

	const method = String(d.method || 'POST').toUpperCase();
	const headers: Record<string, string> = {};
	try {
		Object.assign(
			headers,
			typeof d.headers === 'object' ? d.headers : JSON.parse(d.headers || '{}')
		);
	} catch {
		// битый JSON в headers игнорируем
	}

	const authType = String(d.auth_type || 'none');
	const authParam = String(d.auth_param || 'api_key');
	const authKey = d.api_key != null ? String(d.api_key) : '';
	const query: Record<string, string> = {};
	if (authType === 'query' && authKey) query[authParam] = authKey;
	if (authType === 'header' && authKey) headers[authParam] = authKey;

	// Шлюз: если заполнено поле-ссылка «Прокси», берём его запись — её base_url это
	// endpoint шлюза, api_key — ключ доступа к шлюзу.
	let proxySvc: LocalRecord | null = null;
	if (d.proxy) proxySvc = (await db.data_records.get(d.proxy)) ?? null;
	const useProxy = proxySvc ? true : d.use_proxy === true;

	const noBody = method === 'GET' || method === 'HEAD';
	let res: Response;
	try {
		if (useProxy) {
			const gatewayUrl = proxySvc?.data?.base_url || PROXY_URL;
			const gatewayKey = proxySvc?.data?.api_key || d.api_key || '';
			res = await fetch(gatewayUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					notify_key: gatewayKey,
					url,
					method,
					query,
					headers,
					...(noBody ? {} : { body })
				})
			});
		} else {
			const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : undefined);
			for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
			// Content-Type добавляем только при наличии тела: для простых GET/POST без
			// тела application/json спровоцировал бы CORS-preflight (и «Failed to fetch»).
			const requestHeaders = { ...headers };
			if (!noBody) requestHeaders['Content-Type'] = 'application/json';
			res = await fetch(u.toString(), {
				method,
				headers: requestHeaders,
				...(noBody ? {} : { body: JSON.stringify(body ?? {}) })
			});
		}
	} catch (e: any) {
		const custom = Object.keys(headers).filter((k) => k !== 'Content-Type');
		throw new Error(
			`Не удалось выполнить запрос ${method} ${url}` +
				(useProxy ? ' через шлюз' : ' (прямой fetch из браузера)') +
				`: ${e?.message ?? e}` +
				(useProxy
					? ''
					: custom.length > 0
						? `. Обычная причина — CORS: из-за пользовательских заголовков (${custom.join(', ')}) браузер шлёт preflight, который внешний API не поддерживает. Уберите лишние заголовки в поле «Заголовки» сервиса или укажите сервис-шлюз в поле «Прокси».`
						: '. Возможно, внешний API не разрешает CORS — укажите сервис-шлюз в поле «Прокси»')
		);
	}

	const raw = await res.text();
	let data: any = null;
	try {
		data = raw ? JSON.parse(raw) : null;
	} catch {
		data = null;
	}
	return { ok: res.ok, status: res.status, data, raw };
}

// Глубокая копия без Svelte-прокси и ссылок на реактивные объекты:
// IndexedDB не может структурировано клонировать $state-прокси (DataCloneError).
function toPlain(value: unknown): any {
	if (Array.isArray(value)) return value.map(toPlain);
	if (value instanceof Date) return new Date(value.getTime());
	if (value && typeof value === 'object') {
		const out: Record<string, any> = {};
		for (const key of Object.keys(value as Record<string, any>)) {
			out[key] = toPlain((value as Record<string, any>)[key]);
		}
		return out;
	}
	return value;
}

// Сохранение изменённой кодом записи: локально (is_dirty=1) + строки ТЧ.
// Серверная синхронизация произойдёт в ближайшем цикле sync. Перед записью
// документа автозаполняются служебные поля: пустая дата — сегодня, пустой
// номер — следующий в пределах года (см. numbers.ts).
export async function saveRecordWithLines(record: LocalRecord, lines?: LocalLine[]): Promise<void> {
	const autoData = await autoFillDocumentFields(record.table_id, record.data ?? {});
	record = { ...record, data: autoData };

	await db.transaction('rw', [db.data_records, db.data_lines], async () => {
		await db.data_records.put({
			...record,
			data: toPlain(record.data),
			is_dirty: 1,
			updated_at: new Date().toISOString()
		});
		if (lines) {
			await db.data_lines.bulkPut(
				lines.map((l) => ({
					...l,
					data: toPlain(l.data)
				}))
			);
		}
	});

	// Журнал изменений: факт сохранения из кода действия (save())
	try {
		const table = await db.meta_tables.get(record.table_id);
		if (table && table.type !== 'system') {
			const num = record.data?.number || record.data?.name || '';
			const title = num ? `${table.title} №${num}` : table.title;
			await workspace.recordHistory(record.table_id, title, buildRecordUrl(record.id), 'save');
		}
	} catch {
		// история — некритично
	}
}
