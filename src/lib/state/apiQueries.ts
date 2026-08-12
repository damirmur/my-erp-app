import { db, type LocalColumn } from '$lib/db/indexeddb';
import { API_SERVICES_TABLE } from '$lib/state/notifications';
import { ensureColumns, ensureTable } from '$lib/state/seed';

// Модуль «API-запросы»: документ-каталог внешних запросов. Каждая запись =
// один внешний API-вызов: ссылка на сервис (каталог «Сервисы API») + входные
// параметры по умолчанию (jsonb «Параметры») + опциональный код действия.
//
// Вызов: #/r/{запрос}.execute({...}).json или кнопка «▶️ Выполнить».
// Параметры из ссылки переопределяют дефолты записи по ключу (mergeParams в
// actionRunner.ts). Если код действия не задан — запрос выполняется
// декларативно: apiCall(сервис, параметры) (см. runRecordAction).
//
// Таблица создаётся идемпотентно (код-сид) при старте приложения и в начале
// каждого цикла синхронизации — по паттерну модулей уведомлений/сценариев.
// Конкретные запросы (сид-примеры) здесь не живут: это данные, их заводит
// пользователь в конструкторе.

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
}
