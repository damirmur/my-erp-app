import { db, type LocalColumn, type LocalRecord } from '$lib/db/indexeddb';
import { API_SERVICES_TABLE } from '$lib/state/notifications';
import { ensureColumns, ensureTable, hasServerRows, seedRecord } from '$lib/state/seed';

// Модуль «API-запросы»: документ-каталог внешних запросов. Каждая запись =
// один внешний API-вызов: ссылка на сервис (каталог «Сервисы API») + входные
// параметры по умолчанию (jsonb «Параметры») + опциональный код действия.
//
// Вызов: #/r/{запрос}.execute({...}).json или кнопка «▶️ Выполнить».
// Параметры из ссылки переопределяют дефолты записи по ключу (mergeParams в
// actionRunner.ts). Если код действия не задан — запрос выполняется
// декларативно: apiCall(сервис, параметры) (см. runRecordAction).
//
// Таблицы создаются идемпотентно (код-сид) при старте приложения и в начале
// каждого цикла синхронизации — по паттерну модулей уведомлений/расписаний.

export const API_QUERY_TABLE = 'api_queries';

// Колонки каталога «API-запросы». «Сервис» — ссылка на каталог «Сервисы API»,
// «Параметры» — JSON с дефолтами (ключи подставляются в ${ключ} шаблона base_url).
function queryColumns(servicesId: string): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{
			name: 'service',
			title: 'Сервис',
			type: 'link',
			sort_order: 30,
			is_visible: true,
			related_table_id: servicesId
		},
		{ name: 'params', title: 'Параметры (JSON)', type: 'jsonb', sort_order: 40, is_visible: true },
		{
			name: 'description',
			title: 'Описание',
			type: 'textarea',
			sort_order: 50,
			is_visible: false
		}
	];
}

// Сид-пример: запрос «Погода» через сервис wttr.in (находится по имени).
// Идемпотентно — по name. Сидится только если каталог пуст.
async function seedDefaults(queryTableId: string, online: boolean): Promise<void> {
	const existing = await db.data_records.where('table_id').equals(queryTableId).toArray();
	if (existing.length > 0 || (await hasServerRows(queryTableId, online))) return;

	const weatherService = await db.data_records
		.filter((r) => r.data?.name === 'wttr.in — погода')
		.first();

	const now = new Date().toISOString();
	const row: LocalRecord = {
		id: crypto.randomUUID(),
		table_id: queryTableId,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		data: {
			number: '1',
			name: 'Погода (wttr.in)',
			service: weatherService?.id ?? '',
			params: { city: 'Orenburg', lang: 'ru' },
			description:
				'Пример API-запроса: погода по городу. Вызов: #/r/{запрос}.execute({city:Moscow}).json'
		},
		is_dirty: 1,
		updated_at: now
	};
	await seedRecord(row, online);
}

// Идемпотентное создание таблиц модуля «API-запросы». Вызывается из
// metadata.ensureSystemTables() — после ensureNotificationTables (нужен каталог
// «Сервисы API» для ссылки-колонки).
export async function ensureApiQueryTables(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const servicesId = (await db.meta_tables.where('name').equals(API_SERVICES_TABLE).first())?.id;
	if (!servicesId) return;

	const queryTableId = await ensureTable(API_QUERY_TABLE, 'API-запросы', 'document', {
		features: { run: true },
		runCode: ''
	});
	await ensureColumns(queryTableId, queryColumns(servicesId), online);

	// Офлайн-старт: сид-пример создаём сразу; онлайн-сид — после pullDataChanges
	// (см. seedApiQueryDefaults в runFullSync), когда сервисы уже в локальном кэше.
	if (!online) await seedDefaults(queryTableId, online);
}

// Сид каталога «API-запросы» ПОСЛЕ синхронизации: вызывается из runFullSync
// сразу после seedNotificationDefaults. К этому моменту в кэше уже есть сервисы
// из каталога «Сервисы API», поэтому ссылка-сид на wttr.in резолвится корректно.
export async function seedApiQueryDefaults(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;
	const queryTableId = (await db.meta_tables.where('name').equals(API_QUERY_TABLE).first())?.id;
	if (!queryTableId) return;
	await seedDefaults(queryTableId, online);
}
