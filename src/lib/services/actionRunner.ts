import { db, type LocalLine, type LocalRecord } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { linkApi } from '$lib/services/deeplink';

// Контекст, передаваемый в пользовательский код действия «Выполнить».
// Доступно из кода: record, records, lines, db, supabase, save(), log(), link, apiCall(), run().
export interface RunActionContext {
	record: LocalRecord | null; // Текущая запись (в форме — открытая; в списке — первая выбранная)
	records: LocalRecord[]; // Выбранные записи (в форме — [record])
	lines: LocalLine[]; // Строки табличных частей текущей записи (если есть)
	db: typeof db;
	supabase: typeof supabase;
	save: (record: LocalRecord, lines?: LocalLine[]) => Promise<void>;
	log: (...args: unknown[]) => void;
	link: typeof linkApi; // Генерация уникальных ссылок и получение значений по ним
	apiCall: typeof apiCall; // Вызов внешнего API по записи справочника «Сервисы API»
	run: (tableName: string, recordId: string) => Promise<unknown>; // Выполнить код действия другой таблицы
}

// Выполнение JS-кода действия в браузере. Код — тело async-функции.
// Переменные контекста (record, records, lines, db, supabase, save, log, link, apiCall, run)
// доступны в коде как локальные имена без префикса ctx.
export async function runActionCode(code: string, ctx: RunActionContext): Promise<unknown> {
	const paramNames = [
		'record',
		'records',
		'lines',
		'db',
		'supabase',
		'save',
		'log',
		'link',
		'apiCall',
		'run'
	];
	const values = paramNames.map((k) => (ctx as unknown as Record<string, unknown>)[k]);
	const fn = new Function(...paramNames, `return (async () => {\n${code}\n})();`);
	return await fn(...values);
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
		db,
		supabase,
		save: saveRecordWithLines,
		log: (...args) => console.log('[Выполнить]', ...args),
		link: linkApi,
		apiCall,
		run: runAnotherTable
	});
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
		res = await fetch(u.toString(), {
			method,
			headers: { 'Content-Type': 'application/json', ...headers },
			...(noBody ? {} : { body: JSON.stringify(body ?? {}) })
		});
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
// Серверная синхронизация произойдёт в ближайшем цикле sync.
export async function saveRecordWithLines(record: LocalRecord, lines?: LocalLine[]): Promise<void> {
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
}
