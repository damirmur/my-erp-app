import { db, type LocalColumn, type LocalLine, type LocalRecord } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { API_SERVICES_TABLE, ensureColumns, ensureTable } from '$lib/state/notifications';

// Модуль «Сценарии»: таблица (тип 'flow') с графом как в n8n. Одна запись =
// одна схема; узлы и связи — табличные части этой записи, поэтому сценарий
// самодостаточен (копируется/удаляется вместе с графом).
//
//   «Узлы»   (flow_nodes): name, node_type (start/action/condition/api),
//            params (jsonb), code (текст узла), service (ссылка на api_services)
//   «Связи»  (flow_links): from_node, to_node (Ссылка на строку ТЧ «Узлы»),
//            role (flow | parallel | input), label
//
// Исполнение — кнопка «▶️ Выполнить»: движок flowRunner.ts запускается либо
// через config.runCode (дефолт), либо напрямую по типу таблицы (runRecordAction).
// Таблицы создаются идемпотентно (код-сид) при старте и в начале каждого синка.

export const FLOW_TABLE = 'flow_scenarios';
export const FLOW_NODES_TABLE = 'flow_nodes';
export const FLOW_LINKS_TABLE = 'flow_links';

// Код действия по умолчанию: вызывает движок сценария. Доступен пользователю
// в конфигураторе как обычный runCode, но тип 'flow' выполняется и без него.
export const FLOW_RUN_CODE = `// Выполнение сценария: граф из ТЧ «Узлы» и «Связи»
return await flow(record.id, params);`;

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
		}
	];
}

function nodeColumns(servicesId: string): Omit<LocalColumn, 'id' | 'table_id'>[] {
	return [
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 10, is_visible: true },
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

// Идемпотентное создание таблиц модуля «Сценарии». Вызывается из
// metadata.ensureSystemTables() — после ensureApiQueryTables (для ссылки на
// каталог «Сервисы API»).
export async function ensureFlowTables(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const servicesId = (await db.meta_tables.where('name').equals(API_SERVICES_TABLE).first())?.id;

	const scenarioId = await ensureTable(FLOW_TABLE, 'Сценарии', 'flow', {
		features: { run: true },
		runCode: FLOW_RUN_CODE
	});
	if (!scenarioId) return;
	await ensureColumns(scenarioId, scenarioColumns(), online);

	// ТЧ «Узлы»: строки = узлы графа.
	const nodesId = await ensureTable(FLOW_NODES_TABLE, 'Узлы', 'tabular', {}, scenarioId);
	if (nodesId) {
		await ensureColumns(nodesId, nodeColumns(servicesId ?? ''), online);
		// Старые установки: колонка node_type была строкой — переводим в «Выбор из списка»
		await upgradeNodeTypeColumn(nodesId, online);
	}

	// ТЧ «Связи»: строки = рёбра графа; from_node/to_node ссылаются на строки «Узлы».
	const linksId = await ensureTable(FLOW_LINKS_TABLE, 'Связи', 'tabular', {}, scenarioId);
	if (linksId) {
		await ensureColumns(linksId, linkColumns(nodesId), online);
	}
}

// ===== Сид-пример: «Погода → сообщение» =====
// Граф: константа «city» → извлечь город → запрос погоды (wttr.in) → шаблон
// текста → найти канал контрагента → создать «Сообщение» → отправить.
// Контрагент задаётся параметром сценария (data.params.kontragent) — его можно
// переопределить через execute-ссылку: #/r/{сценарий}.execute({kontragent:...}).json

export const FLOW_EXAMPLE_NAME = 'Погода → сообщение (пример)';

// Нет ли уже такого сценария (локально или на сервере) — идемпотентность по name.
async function flowExampleExists(scenarioTableId: string, online: boolean): Promise<boolean> {
	const local = await db.data_records
		.where('table_id')
		.equals(scenarioTableId)
		.filter((r) => r.data?.name === FLOW_EXAMPLE_NAME)
		.first();
	if (local) return true;
	if (!online) return false;
	try {
		const { data } = await supabase
			.from('data_records')
			.select('data')
			.eq('table_id', scenarioTableId);
		return (data ?? []).some((r: any) => r.data?.name === FLOW_EXAMPLE_NAME);
	} catch {
		return false;
	}
}

// Гарантировать константу «city» (только если её ещё нет) — универсальное
// значение JSON {city: "Orenburg"}, из которого узел «get» достаёт город.
async function ensureCityConstant(online: boolean): Promise<void> {
	const constantsTable = await db.meta_tables.where('name').equals('constants').first();
	if (!constantsTable) return;
	const existing = await db.data_records
		.where('table_id')
		.equals(constantsTable.id)
		.filter((r) => r.data?.name === 'city')
		.first();
	if (existing) return;
	const now = new Date().toISOString();
	const record: LocalRecord = {
		id: crypto.randomUUID(),
		table_id: constantsTable.id,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		data: {
			number: '1',
			name: 'city',
			value: { t: 'jsonb', v: { city: 'Orenburg' } },
			description: 'Город для прогноза погоды (пример сценария)'
		},
		is_dirty: 1,
		updated_at: now
	};
	await db.data_records.put(record);
	if (online) {
		try {
			await supabase.from('data_records').upsert(record);
		} catch {
			// уедет при ближайшем синке
		}
	}
}

// Создать запись сценария + строки ТЧ (локально и на сервере, если онлайн).
// В nodes каждый узел задаётся с data.name; в links from/to — имена узлов,
// которые здесь резолвятся в реальные id строк ТЧ «Узлы».
async function seedScenario(
	scenarioId: string,
	scenarioTableId: string,
	nodesTableId: string,
	linksTableId: string,
	params: Record<string, any>,
	nodes: Array<{ data: Record<string, any> }>,
	links: Array<{ from: string; to: string; role: string; label: string }>,
	online: boolean
): Promise<void> {
	const now = new Date().toISOString();
	const scenario: LocalRecord = {
		id: scenarioId,
		table_id: scenarioTableId,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		data: {
			number: '1',
			name: FLOW_EXAMPLE_NAME,
			description: 'Прогноз погоды по городу из константы и отправка сообщением контрагенту.',
			params
		},
		is_dirty: 1,
		updated_at: now
	};

	// Узлы: генерируем id заранее и запоминаем id по имени для связей
	const nodeIds = nodes.map(() => crypto.randomUUID());
	const nodeIdByName = new Map<string, string>();
	const nodeLines: LocalLine[] = nodes.map((n, i) => {
		nodeIdByName.set(n.data.name, nodeIds[i]);
		return {
			id: nodeIds[i],
			record_id: scenarioId,
			table_id: nodesTableId,
			data: n.data,
			sort_order: i + 1
		};
	});

	const linkLines: LocalLine[] = links.map((l, i) => ({
		id: crypto.randomUUID(),
		record_id: scenarioId,
		table_id: linksTableId,
		data: {
			from_node: nodeIdByName.get(l.from) ?? '',
			to_node: nodeIdByName.get(l.to) ?? '',
			role: l.role,
			label: l.label
		},
		sort_order: i + 1
	}));

	await db.transaction('rw', [db.data_records, db.data_lines], async () => {
		await db.data_records.put(scenario);
		await db.data_lines.bulkPut([...nodeLines, ...linkLines]);
	});

	if (online) {
		try {
			await supabase.from('data_records').upsert(scenario);
			await supabase.from('data_lines').upsert([...nodeLines, ...linkLines]);
		} catch {
			// уедет при ближайшем синке
		}
	}
}

// Сид-пример сценария ПОСЛЕ синхронизации: вызывается из runFullSync сразу после
// seedApiQueryDefaults — к этому моменту в кэше есть каталог «Сервисы API» (wttr.in)
// и константы.
export async function seedFlowExample(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const scenarioTable = await db.meta_tables.where('name').equals(FLOW_TABLE).first();
	const nodesTable = await db.meta_tables.where('name').equals(FLOW_NODES_TABLE).first();
	const linksTable = await db.meta_tables.where('name').equals(FLOW_LINKS_TABLE).first();
	if (!scenarioTable || !nodesTable || !linksTable) return;
	if (await flowExampleExists(scenarioTable.id, online)) return;

	// Сервис погоды (wttr.in) для узла «Погода»
	const wttr = await db.data_records.filter((r) => r.data?.name === 'wttr.in — погода').first();
	if (!wttr) {
		console.warn('Сид-пример сценария: не найден сервис wttr.in, пример не создан.');
		return;
	}

	await ensureCityConstant(online);

	const scenarioId = crypto.randomUUID();
	const KONTRAGENT = '0bc5fc65-5db6-48c9-9810-fb52597356c4';

	// Узлы. Имена узлов — ключи контекста: на результат узла «Текст прогноза»
	// ссылается узел «Создать сообщение» через ${Текст прогноза}.
	const nodes = [
		{
			data: { name: 'Константа города', node_type: 'constant', params: { name: 'city' }, code: '' }
		},
		{ data: { name: 'Извлечь город', node_type: 'get', params: { path: 'city' }, code: '' } },
		{
			data: {
				name: 'Погода',
				node_type: 'api',
				service: wttr.id,
				params: { city: '${input}', format: 'j1', lang: 'ru' },
				code: ''
			}
		},
		{
			data: {
				name: 'Текст прогноза',
				node_type: 'template',
				params: {
					template:
						'Погода в городе ${location.name}: ${current.temp_c}°C, ${current.condition.text}'
				},
				code: ''
			}
		},
		{
			data: {
				name: 'Текст прогноза',
				node_type: 'template',
				params: {
					template:
						'Погода в городе ${nearest_area.0.areaName.0.value}: ${current_condition.0.temp_C}°C, ${current_condition.0.weatherDesc.0.value}'
				},
				code: ''
			}
		},
		{
			data: {
				name: 'Создать сообщение',
				node_type: 'create',
				params: {
					table: 'notify_messages',
					data: { subject: 'Прогноз погоды', message: '${Текст прогноза}' },
					lines: {
						notify_message_channels: [{ kontragent: '${kontragent}', channel: '${channel}' }]
					}
				},
				code: ''
			}
		},
		{
			data: {
				name: 'Отправить',
				node_type: 'run',
				params: { table: 'notify_messages', record: '${id}' },
				code: ''
			}
		}
	];

	// Связи: последовательные рёбра; «Канал контрагента» не зависит от текста,
	// поэтому идёт отдельной веткой (параллельно запросу погоды).
	const links = [
		{ from: 'Константа города', to: 'Извлечь город', role: 'flow', label: 'city' },
		{ from: 'Извлечь город', to: 'Погода', role: 'flow', label: 'запрос' },
		{ from: 'Погода', to: 'Текст прогноза', role: 'flow', label: 'результат' },
		{ from: 'Текст прогноза', to: 'Создать сообщение', role: 'flow', label: 'текст' },
		{ from: 'Канал контрагента', to: 'Создать сообщение', role: 'flow', label: 'канал' },
		{ from: 'Создать сообщение', to: 'Отправить', role: 'flow', label: 'отправка' }
	];

	await seedScenario(
		scenarioId,
		scenarioTable.id,
		nodesTable.id,
		linksTable.id,
		{ kontragent: KONTRAGENT },
		nodes,
		links,
		online
	);
}
