import { db, type LocalColumn, type LocalLine, type LocalRecord } from '$lib/db/indexeddb';
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

// Код узла «Текст прогноза»: формирует человекочитаемый текст погоды из JSON
// wttr.in (вход узла — результат узла «Погода»). Возвращает текст — он уходит
// в контекст сценария и подставляется в сообщение через ${Текст прогноза}.
export const FORECAST_TEXT_CODE = [
	'// Текст прогноза из JSON погоды (вход узла «Погода»), вывод в часовом поясе браузера',
	"const json = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};",
	'',
	'const cur = json.current_condition?.[0] ?? {};',
	'const area = json.nearest_area?.[0] ?? {};',
	"const city = area.areaName?.[0]?.value ?? '';",
	"const region = area.region?.[0]?.value ?? '';",
	'const today = json.weather?.[0] ?? {};',
	'const astro = today.astronomy?.[0] ?? {};',
	'',
	'// Время в формате и часовом поясе браузера',
	"const fmtNow = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });",
	'',
	'// "05:45 AM" -> "05:45" (24-часовой формат, как принято в браузере)',
	'const to24 = (t) => {',
	"  if (!t) return '';",
	'  const m = t.trim().toUpperCase().match(/^(\\d{1,2}):(\\d{2})\\s*(AM|PM)?$/);',
	'  if (!m) return t;',
	'  let h = +m[1];',
	'  const p = m[3];',
	"  if (p === 'PM' && h < 12) h += 12;",
	"  if (p === 'AM' && h === 12) h = 0;",
	"  return `${String(h).padStart(2, '0')}:${m[2]}`;",
	'};',
	'',
	'// Начало суток для даты "YYYY-MM-DD" в часовом поясе браузера',
	'const dayStart = (ds) => new Date(`${ds}T00:00:00`);',
	'const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();',
	'const dayDiff = (ds) => Math.round((dayStart(ds) - todayStart) / 86400000);',
	"const relDay = (n) => (n === 0 ? 'сегодня' : n === 1 ? 'завтра' : n === 2 ? 'послезавтра' : '');",
	'',
	'// Дата в формате браузера с днём недели и относительной подписью',
	'const fmtDate = (ds) => {',
	'  const d = dayStart(ds);',
	'  const rel = relDay(dayDiff(ds));',
	"  const base = `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}, ${d.toLocaleDateString('ru-RU', { weekday: 'long' })}`;",
	'  return rel ? `${base} (${rel})` : base;',
	'};',
	'',
	'// Описание дня из почасовых данных (самое частое; при равенстве — значение на полдень)',
	'const dayDesc = (d) => {',
	'  const h = d.hourly ?? [];',
	"  if (!h.length) return '';",
	"  const vals = h.map((x) => x.lang_ru?.[0]?.value ?? x.weatherDesc?.[0]?.value ?? '').filter(Boolean);",
	"  if (!vals.length) return '';",
	'  const counts = {};',
	'  for (const v of vals) counts[v] = (counts[v] ?? 0) + 1;',
	'  const max = Math.max(...Object.values(counts));',
	'  const ties = Object.keys(counts).filter((v) => counts[v] === max);',
	'  if (ties.length === 1) return ties[0];',
	"  const noon = h.find((x) => x.time === '1200') ?? h[Math.floor(h.length / 2)];",
	'  return noon?.lang_ru?.[0]?.value ?? ties[0];',
	'};',
	'',
	'const lines = [];',
	"lines.push(`Погода в ${city}${region ? ', ' + region : ''} на ${fmtNow()}:`);",
	"lines.push(`• ${cur.lang_ru?.[0]?.value ?? cur.weatherDesc?.[0]?.value ?? '—'}, ${cur.temp_C ?? '—'}°C, ощущается как ${cur.FeelsLikeC ?? '—'}°C`);",
	"lines.push(`• Влажность: ${cur.humidity ?? '—'}%, осадки: ${cur.precipMM ?? '—'} мм`);",
	"lines.push(`• Ветер: ${cur.windspeedKmph ?? '—'} км/ч (${cur.winddir16Point ?? '—'}), давление: ${cur.pressure ?? '—'} гПа`);",
	"lines.push(`• УФ-индекс: ${cur.uvIndex ?? '—'}, облачность: ${cur.cloudcover ?? '—'}%, видимость: ${cur.visibility ?? '—'} км`);",
	'',
	'// Изменение погоды в течение дня (сегодня)',
	'const todayHourly = today.hourly ?? [];',
	'if (todayHourly.length) {',
	"  lines.push('');",
	"  lines.push('В течение дня:');",
	'  for (const h of todayHourly) {',
	'    const t = to24(`${Math.floor(+h.time / 100)}:00`);',
	"    lines.push(`• ${t}: ${h.lang_ru?.[0]?.value ?? h.weatherDesc?.[0]?.value ?? '—'}, ${h.tempC ?? '—'}°C`);",
	'  }',
	'}',
	'',
	'if (json.weather?.length) {',
	"  lines.push('');",
	"  lines.push('Прогноз:');",
	'  for (const d of json.weather) {',
	"    const snow = parseFloat(d.totalSnow_cm) > 0 ? `, снег: ${d.totalSnow_cm} см` : '';",
	'    const desc = dayDesc(d);',
	"    lines.push(`• ${fmtDate(d.date)}: мин ${d.mintempC ?? '—'}°C, макс ${d.maxtempC ?? '—'}°C${desc ? `, ${desc}` : ''}, УФ ${d.uvIndex ?? '—'}${snow}`);",
	'  }',
	'}',
	'',
	'if (astro?.sunrise) {',
	"  lines.push('');",
	'  lines.push(`• Рассвет: ${to24(astro.sunrise)}, закат: ${to24(astro.sunset)}, фаза луны: ${astro.moon_phase} (${astro.moon_illumination}%)`);',
	'}',
	'',
	"return lines.join('\\n');"
].join('\n');

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

// ===== Сид-пример: «Погода → сообщение» =====
// Граф: константа «city» → извлечь город → запрос погоды (wttr.in) → шаблон
// текста → найти контакты контрагентов (find.all) → создать «Сообщение» → отправить.
// Контрагенты задаются параметром сценария (data.params.kontragents — массив UUID);
// их можно переопределить через execute-ссылку:
//   #/r/{сценарий}.execute({kontragents:["<uuid>", "..."]}).json

export const FLOW_EXAMPLE_NAME = 'Погода → сообщение (пример)';

// Найти пример сценария (локально или на сервере) по name.
async function findExample(scenarioTableId: string, online: boolean): Promise<LocalRecord | null> {
	const local = await db.data_records
		.where('table_id')
		.equals(scenarioTableId)
		.filter((r) => r.data?.name === FLOW_EXAMPLE_NAME)
		.first();
	if (local) return local;
	if (!online) return null;
	try {
		const { data } = await supabase
			.from('data_records')
			.select('*')
			.eq('table_id', scenarioTableId);
		return (data ?? []).find((r: any) => r.data?.name === FLOW_EXAMPLE_NAME) ?? null;
	} catch {
		return null;
	}
}

// Пример в новом формате: все узлы ссылаются на каталог «Элементы сценария».
async function exampleUsesElements(exampleId: string): Promise<boolean> {
	const nodesTable = await db.meta_tables.where('name').equals(FLOW_NODES_TABLE).first();
	if (!nodesTable) return false;
	const nodes = (await db.data_lines.where('record_id').equals(exampleId).toArray()).filter(
		(l) => l.table_id === nodesTable.id
	);
	return nodes.length > 0 && nodes.every((l) => l.data?.element);
}

// Удалить сценарий целиком (локально и на сервере).
async function deleteScenario(recordId: string, online: boolean): Promise<void> {
	await db.data_lines.where('record_id').equals(recordId).delete();
	await db.data_records.delete(recordId);
	if (online) {
		try {
			await supabase.from('data_lines').delete().eq('record_id', recordId);
			await supabase.from('data_records').delete().eq('id', recordId);
		} catch {
			// уедет при ближайшем синке
		}
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

// Каталог элементов примера (flow_elements): идемпотентно по name. Узел сценария
// ссылается на элемент (колонка element) и может переопределять параметры/код.
async function seedFlowElements(online: boolean, wttrId: string): Promise<Map<string, string>> {
	const table = await db.meta_tables.where('name').equals(FLOW_ELEMENTS_TABLE).first();
	if (!table) return new Map();
	const nameToId = new Map<string, string>();

	const defs: Array<Record<string, any>> = [
		{
			name: 'Константа города',
			element_type: 'constant',
			params: { name: 'city' },
			description:
				'Вход: не использует.\nКак работает: находит в таблице «Константы» запись с именем из параметра name (по умолчанию «city») и возвращает её значение.\nВыход: значение константы (строка, число или объект — зависит от типа константы).'
		},
		{
			name: 'Извлечь город',
			element_type: 'get',
			params: { path: 'city' },
			description:
				'Вход: результат предыдущего узла (объект/JSON).\nКак работает: извлекает из входа значение по точечному пути path (например «city» или «current.temp_c»). Если вход не объект или путь не найден — возвращает вход без изменений.\nВыход: значение по пути из входа.'
		},
		{
			name: 'Погода (wttr.in)',
			element_type: 'api',
			service: wttrId,
			params: { city: '${input}', format: 'j1', lang: 'ru' },
			description:
				'Вход: результат предыдущего узла — подставляется в параметры через ${input} (например, город).\nКак работает: вызывает внешний сервис (wttr.in) по записи «Сервис API»; в параметрах можно ссылаться на контекст сценария через ${...}.\nВыход: ответ API — JSON (объект погоды wttr.in).'
		},
		{
			name: 'Текст прогноза',
			element_type: 'code',
			code: FORECAST_TEXT_CODE,
			params: {},
			description:
				'Вход: результат предыдущего узла (JSON погоды wttr.in).\nКак работает: выполняет JS-код узла, который строит человекочитаемый текст прогноза: текущая погода, почасовой прогноз на день, прогноз на несколько дней, рассвет/закат.\nВыход: строка текста прогноза.',
			// Старый заводской конфиг (однострочный шаблон) — обновляем до кода,
			// пока элемент не редактировали вручную.
			legacy: {
				element_type: 'template',
				params: {
					template:
						'Погода в городе ${nearest_area.0.areaName.0.value}: ${current_condition.0.temp_C}°C, ${current_condition.0.weatherDesc.0.value}'
				},
				service: ''
			}
		},
		{
			name: 'Найти контакты контрагентов',
			element_type: 'find',
			params: {
				table: 'contragent_contacts',
				where: { record_id: '${kontragents}', default: true },
				all: true,
				map: { kontragent: 'record_id', channel: 'channel' }
			},
			description:
				'Вход: не обязателен; параметры сценария ${kontragents} (массив UUID контрагентов).\nКак работает: ищет в таблице «contragent_contacts» (ТЧ контактов) строки, где record_id входит в список ${kontragents} и default = true. Значения where-массивы трактуются как «in». all=true возвращает ВСЕ совпадения массивом. map перекладывает поля: { kontragent: record_id, channel: channel }. Ищет сначала локально (IndexedDB), затем на сервере.\nВыход: массив строк-получателей { kontragent, channel }.',
			// Старый заводской конфиг (все контакты без фильтра default) — обновляем,
			// пока элемент не редактировали вручную.
			legacy: {
				element_type: 'find',
				params: {
					table: 'contragent_contacts',
					where: { record_id: '${kontragents}' },
					all: true,
					map: { kontragent: 'record_id', channel: 'channel' }
				},
				service: ''
			}
		},
		{
			name: 'Создать сообщение',
			element_type: 'create',
			params: {
				table: 'notify_messages',
				data: { subject: 'Прогноз погоды', message: '${Текст прогноза}' },
				lines: { notify_message_channels: '${Контакты контрагентов}' }
			},
			description:
				'Вход: не обязателен; данные берутся из контекста сценария через ${...} — ${Текст прогноза} (строка), ${Контакты контрагентов} (массив получателей).\nКак работает: создаёт запись в таблице «notify_messages» с полями data (subject, message) и строками ТЧ «notify_message_channels» из массива получателей.\nВыход: объект { id, ...data } — id созданного сообщения.',
			// Старый заводской конфиг (одна строка получателя) — обновляем до нового
			// (массив получателей из контекста), пока элемент не редактировали вручную.
			legacy: {
				element_type: 'create',
				params: {
					table: 'notify_messages',
					data: { subject: 'Прогноз погоды', message: '${Текст прогноза}' },
					lines: {
						notify_message_channels: [{ kontragent: '${kontragent}', channel: '${channel}' }]
					}
				},
				service: ''
			}
		},
		{
			name: 'Отправить сообщение',
			element_type: 'run',
			params: { table: 'notify_messages', record: '${id}' },
			description:
				'Вход: не обязателен; record подставляется из контекста (${id} — id созданного сообщения).\nКак работает: выполняет код действия таблицы «notify_messages» по указанной записи (NOTIFY_RUN_CODE — отправка сообщения получателям по каналам).\nВыход: результат действия (статусы отправки по каналам).'
		}
	];

	// Элементы, заменённые в новой архитектуре: удаляем, только если они всё ещё
	// хранят заводской конфиг (не тронуты пользователем).
	const legacyRemove: Array<{ name: string; legacy: Record<string, any> }> = [
		{
			name: 'Найти канал контрагента',
			legacy: {
				element_type: 'find',
				params: { table: 'contragent_contacts', where: { record_id: '${kontragent}' } },
				service: ''
			}
		}
	];

	// Глубокое сравнение без учёта порядка ключей: jsonb в Postgres сортирует
	// ключи объектов, поэтому JSON.stringify-сравнение legacy-конфига ломается.
	function deepEqual(a: any, b: any): boolean {
		if (a === b) return true;
		if (typeof a !== typeof b) return false;
		if (Array.isArray(a) && Array.isArray(b)) {
			return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
		}
		if (a && b && typeof a === 'object' && typeof b === 'object') {
			const ka = Object.keys(a);
			const kb = Object.keys(b);
			if (ka.length !== kb.length) return false;
			return ka.every((k) => deepEqual(a[k], b[k]));
		}
		return false;
	}

	function keyConfig(d: any): Record<string, any> {
		return {
			element_type: d?.element_type ?? '',
			params: d?.params ?? {},
			service: d?.service ?? ''
		};
	}

	for (const def of defs) {
		const existing = await db.data_records
			.where('table_id')
			.equals(table.id)
			.filter((r) => r.data?.name === def.name)
			.first();
		if (existing) {
			const target = {
				element_type: def.element_type,
				params: def.params ?? {},
				service: def.service ?? '',
				code: def.code ?? ''
			};
			// Элемент всё ещё на старом заводском конфиге — поднимаем до нового дефолта.
			if (def.legacy && deepEqual(keyConfig(existing.data), def.legacy)) {
				const data = { ...existing.data, ...target };
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
							table_id: table.id,
							status: existing.status,
							data,
							is_dirty: 1,
							updated_at: new Date().toISOString(),
							is_folder: existing.is_folder ?? false,
							parent_id: existing.parent_id ?? null
						});
					} catch {
						// уедет при ближайшем синке
					}
				}
			}
			nameToId.set(def.name, existing.id);
			continue;
		}
		const record: LocalRecord = {
			id: crypto.randomUUID(),
			table_id: table.id,
			status: 'draft',
			is_folder: false,
			parent_id: null,
			data: {
				name: def.name,
				element_type: def.element_type,
				service: def.service ?? '',
				params: def.params ?? {},
				code: def.code ?? '',
				description: def.description ?? ''
			},
			is_dirty: 1,
			updated_at: new Date().toISOString()
		};
		await db.data_records.put(record);
		if (online) {
			try {
				await supabase.from('data_records').upsert(record);
			} catch {
				// уедет при ближайшем синке
			}
		}
		nameToId.set(def.name, record.id);
	}

	// Удаляем legacy-элементы (переименованные/заменённые), не тронутые пользователем.
	for (const rm of legacyRemove) {
		const existing = await db.data_records
			.where('table_id')
			.equals(table.id)
			.filter((r) => r.data?.name === rm.name)
			.first();
		if (!existing) continue;
		if (!deepEqual(keyConfig(existing.data), rm.legacy)) continue;
		await db.data_records.delete(existing.id);
		if (online) {
			try {
				await supabase.from('data_records').delete().eq('id', existing.id);
			} catch {
				// уедет при ближайшем синке
			}
		}
	}

	return nameToId;
}

// Сид-пример сценария ПОСЛЕ синхронизации: вызывается из runFullSync сразу после
// seedApiQueryDefaults — к этому моменту в кэше есть каталог «Сервисы API» (wttr.in)
// и константы. Узлы примера ссылаются на записи каталога «Элементы сценария».
export async function seedFlowExample(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const scenarioTable = await db.meta_tables.where('name').equals(FLOW_TABLE).first();
	const nodesTable = await db.meta_tables.where('name').equals(FLOW_NODES_TABLE).first();
	const linksTable = await db.meta_tables.where('name').equals(FLOW_LINKS_TABLE).first();
	if (!scenarioTable || !nodesTable || !linksTable) return;

	// Каталог элементов примера сидим всегда (идемпотентно по name), даже если сам
	// сценарий уже существует — элементы нужны для редактирования и переиспользования.
	const wttr = await db.data_records.filter((r) => r.data?.name === 'wttr.in — погода').first();
	const elements = wttr ? await seedFlowElements(online, wttr.id) : new Map<string, string>();
	if (!wttr) {
		console.warn('Сид-пример сценария: не найден сервис wttr.in, пример не создан.');
		return;
	}

	// Старый inline-пример (до каталога элементов) удаляем и пересоздаём в новом
	// формате — обратной совместимости нет.
	const existing = await findExample(scenarioTable.id, online);
	if (existing) {
		if (await exampleUsesElements(existing.id)) return;
		console.log('Сид-пример: пересоздаю сценарий в новом формате (каталог элементов).');
		await deleteScenario(existing.id, online);
	}

	await ensureCityConstant(online);

	// Узлы ссылаются на записи каталога (колонка element).
	const el = (name: string): string => elements.get(name) ?? '';

	const scenarioId = crypto.randomUUID();
	const KONTRAGENT = '0bc5fc65-5db6-48c9-9810-fb52597356c4';

	// Узлы. Имена узлов — ключи контекста: на результат узла «Текст прогноза»
	// ссылается узел «Создать сообщение» через ${Текст прогноза}, на «Контакты
	// контрагентов» (массив получателей от find.all) — через ${Контакты контрагентов}.
	const nodes = [
		{ data: { name: 'Константа города', element: el('Константа города'), params: {} } },
		{ data: { name: 'Извлечь город', element: el('Извлечь город'), params: {} } },
		{ data: { name: 'Погода', element: el('Погода (wttr.in)'), params: {} } },
		{ data: { name: 'Текст прогноза', element: el('Текст прогноза'), params: {} } },
		{
			data: {
				name: 'Контакты контрагентов',
				element: el('Найти контакты контрагентов'),
				params: {}
			}
		},
		{ data: { name: 'Создать сообщение', element: el('Создать сообщение'), params: {} } },
		{ data: { name: 'Отправить', element: el('Отправить сообщение'), params: {} } }
	];

	// Связи: последовательные рёбра; «Контакты контрагентов» не зависит от текста,
	// поэтому идёт отдельной веткой (параллельно запросу погоды).
	const links = [
		{ from: 'Константа города', to: 'Извлечь город', role: 'flow', label: 'city' },
		{ from: 'Извлечь город', to: 'Погода', role: 'flow', label: 'запрос' },
		{ from: 'Погода', to: 'Текст прогноза', role: 'flow', label: 'результат' },
		{ from: 'Текст прогноза', to: 'Создать сообщение', role: 'flow', label: 'текст' },
		{ from: 'Контакты контрагентов', to: 'Создать сообщение', role: 'flow', label: 'получатели' },
		{ from: 'Создать сообщение', to: 'Отправить', role: 'flow', label: 'отправка' }
	];

	await seedScenario(
		scenarioId,
		scenarioTable.id,
		nodesTable.id,
		linksTable.id,
		{ kontragents: [KONTRAGENT] },
		nodes,
		links,
		online
	);
}
