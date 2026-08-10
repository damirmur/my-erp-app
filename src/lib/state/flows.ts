import { db, type LocalColumn } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { API_SERVICES_TABLE, ensureColumns, ensureTable } from '$lib/state/notifications';

// Модуль «Сценарии»: таблица (тип 'flow') с графом как в n8n. Одна запись =
// одна схема; узлы и связи — табличные части этой записи, поэтому сценарий
// самодостаточен (копируется/удаляется вместе с графом).
//
//   «Узлы»   (flow_nodes): name, element (ссылка на каталог flow_elements),
//            node_type (start/action/condition/api), params (jsonb — переопределения),
//            code (текст узла), service (ссылка на api_services)
//   «Связи»  (flow_links): from_node, to_node (Ссылка на строку ТЧ «Узлы»),
//            role (flow | parallel | input), label
//   «Элементы сценария» (flow_elements): каталог переиспользуемых узлов
//            (тип + сервис + параметры/код). Узел ссылается на элемент и может
//            переопределять его параметры/код/тип — движок сливает их.
//
// Исполнение — кнопка «▶️ Выполнить»: движок flowRunner.ts запускается либо
// через config.runCode (дефолт), либо напрямую по типу таблицы (runRecordAction).
// Таблицы создаются идемпотентно (код-сид) при старте и в начале каждого синка.

export const FLOW_TABLE = 'flow_scenarios';
export const FLOW_NODES_TABLE = 'flow_nodes';
export const FLOW_LINKS_TABLE = 'flow_links';
export const FLOW_ELEMENTS_TABLE = 'flow_elements';

// Код действия по умолчанию: вызывает движок сценария. Доступен пользователю
// в конфигураторе как обычный runCode, но тип 'flow' выполняется и без него.
export const FLOW_RUN_CODE = `// Выполнение сценария: граф из ТЧ «Узлы» и «Связи»
return await flow(record.id, params);`;

// Колонки сценария: params — визуальный редактор «Параметры (список)»: объект
// { ключ: [id, ...] } (например, { kontragents: [uuid, ...] }). Значения —
// ссылки на записи любых таблиц (универсальный поиск, см. paramslist).
function scenarioColumns(): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{
			name: 'description',
			title: 'Описание',
			type: 'textarea',
			sort_order: 30,
			is_visible: false
		},
		{
			name: 'params',
			title: 'Параметры',
			type: 'paramslist',
			sort_order: 40,
			is_visible: true
		}
	];
}

// Колонки узла: собственные параметры/код — переопределения поверх выбранного
// элемента каталога; поля, которых нет в узле, берутся из элемента.
function nodeColumns(
	servicesId: string,
	elementsId: string
): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 10, is_visible: true },
		{
			name: 'element',
			title: 'Элемент',
			type: 'link',
			sort_order: 15,
			is_visible: true,
			related_table_id: elementsId
		},
		{
			name: 'node_type',
			title: 'Тип узла',
			type: 'select',
			sort_order: 20,
			is_visible: true
		},
		{
			name: 'service',
			title: 'Сервис API',
			type: 'link',
			sort_order: 30,
			is_visible: true,
			related_table_id: servicesId
		},
		{ name: 'params', title: 'Параметры (JSON)', type: 'jsonb', sort_order: 40, is_visible: true },
		{ name: 'code', title: 'Код узла', type: 'textarea', sort_order: 50, is_visible: false }
	];
}

// Каталог переиспользуемых элементов сценария: запись = готовый узел
// (тип + сервис + параметры/код). Сценарии ссылаются на элементы и могут
// переопределять параметры и код на уровне узла.
function elementColumns(servicesId: string): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 10, is_visible: true },
		{
			name: 'icon',
			title: 'Значок',
			type: 'string',
			sort_order: 12,
			is_visible: true
		},
		{
			name: 'element_type',
			title: 'Тип',
			type: 'select',
			sort_order: 20,
			is_visible: true
		},
		{
			name: 'service',
			title: 'Сервис API',
			type: 'link',
			sort_order: 30,
			is_visible: true,
			related_table_id: servicesId
		},
		{ name: 'params', title: 'Параметры (JSON)', type: 'jsonb', sort_order: 40, is_visible: true },
		{ name: 'code', title: 'Код', type: 'textarea', sort_order: 50, is_visible: false },
		{ name: 'description', title: 'Описание', type: 'textarea', sort_order: 60, is_visible: false }
	];
}

function linkColumns(nodesId: string): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{
			name: 'from_node',
			title: 'Откуда',
			type: 'linelink',
			sort_order: 10,
			is_visible: true,
			related_table_id: nodesId
		},
		{
			name: 'to_node',
			title: 'Куда',
			type: 'linelink',
			sort_order: 20,
			is_visible: true,
			related_table_id: nodesId
		},
		{
			name: 'role',
			title: 'Роль',
			type: 'string',
			sort_order: 30,
			is_visible: true
		},
		{ name: 'label', title: 'Подпись', type: 'string', sort_order: 40, is_visible: false }
	];
}

// Перевод колонки node_type ТЧ «Узлы» со строки на «Выбор из списка» у уже
// созданных установок (идемпотентно, только если тип всё ещё 'string').
async function upgradeNodeTypeColumn(nodesId: string, online: boolean): Promise<void> {
	const col = await db.meta_columns
		.where('table_id')
		.equals(nodesId)
		.filter((c) => c.name === 'node_type')
		.first();
	if (!col || col.type === 'select') return;

	if (online) {
		try {
			await supabase.from('meta_columns').update({ type: 'select' }).eq('id', col.id);
		} catch {
			// сервер недоступен — достаточно локального обновления
		}
	}
	await db.meta_columns.put({ ...col, type: 'select' });
}

// Перевод колонки params сценария с jsonb на визуальный редактор «Параметры
// (список)» у уже созданных установок (идемпотентно). Ссылки-значения ищутся
// по всем таблицам (универсальный поиск), поэтому related_table_id не ставим.
async function upgradeScenarioParamsColumn(scenarioId: string, online: boolean): Promise<void> {
	const col = await db.meta_columns
		.where('table_id')
		.equals(scenarioId)
		.filter((c) => c.name === 'params')
		.first();
	if (!col || col.type === 'paramslist') return;

	if (online) {
		try {
			await supabase.from('meta_columns').update({ type: 'paramslist' }).eq('id', col.id);
		} catch {
			// сервер недоступен — достаточно локального обновления
		}
	}
	await db.meta_columns.put({ ...col, type: 'paramslist' });
}

// Поле «Элемент» узла ссылается на каталог «Элементы сценария» (flow_elements).
// У старых установок related_table_id не был заполнен (универсальный поиск),
// из-за чего в выпадающем списке показывались ВСЕ записи системы. Идемпотентно
// проставляем ссылку на каталог — серверу и локально.
async function upgradeNodeElementColumn(
	nodesId: string,
	elementsId: string,
	online: boolean
): Promise<void> {
	const col = await db.meta_columns
		.where('table_id')
		.equals(nodesId)
		.filter((c) => c.name === 'element')
		.first();
	if (!col || col.related_table_id === elementsId) return;

	if (online) {
		try {
			await supabase.from('meta_columns').update({ related_table_id: elementsId }).eq('id', col.id);
		} catch {
			// сервер недоступен — достаточно локального обновления
		}
	}
	await db.meta_columns.put({ ...col, related_table_id: elementsId });
}

// Идемпотентное создание таблиц модуля «Сценарии». Вызывается из
// metadata.ensureSystemTables() — после ensureApiQueryTables (для ссылки на
// каталог «Сервисы API»).
export async function ensureFlowTables(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const servicesId = (await db.meta_tables.where('name').equals(API_SERVICES_TABLE).first())?.id;

	// Каталог переиспользуемых элементов сценария (тип + сервис + параметры/код).
	const elementsId = await ensureTable(FLOW_ELEMENTS_TABLE, 'Элементы сценария', 'directory', {
		features: { create: true, save: true, copy: true, delete: true, run: false }
	});
	if (elementsId) {
		await ensureColumns(elementsId, elementColumns(servicesId ?? ''), online);
	}

	const scenarioId = await ensureTable(FLOW_TABLE, 'Сценарии', 'flow', {
		features: { run: true },
		runCode: FLOW_RUN_CODE
	});
	if (!scenarioId) return;
	await ensureColumns(scenarioId, scenarioColumns(), online);
	// Старые установки: колонка params была jsonb — переводим на визуальный
	// редактор «Параметры (список)».
	await upgradeScenarioParamsColumn(scenarioId, online);

	// ТЧ «Узлы»: строки = узлы графа.
	const nodesId = await ensureTable(FLOW_NODES_TABLE, 'Узлы', 'tabular', {}, scenarioId);
	if (nodesId) {
		await ensureColumns(nodesId, nodeColumns(servicesId ?? '', elementsId ?? ''), online);
		// Старые установки: колонка node_type была строкой — переводим в «Выбор из списка»
		await upgradeNodeTypeColumn(nodesId, online);
		// Старые установки: поле «Элемент» без связанной таблицы показывало ВСЕ
		// записи — проставляем ссылку на каталог «Элементы сценария».
		if (elementsId) await upgradeNodeElementColumn(nodesId, elementsId, online);
	}

	// ТЧ «Связи»: строки = рёбра графа; from_node/to_node ссылаются на строки «Узлы».
	const linksId = await ensureTable(FLOW_LINKS_TABLE, 'Связи', 'tabular', {}, scenarioId);
	if (linksId) {
		await ensureColumns(linksId, linkColumns(nodesId), online);
	}
}
