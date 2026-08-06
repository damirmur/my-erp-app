import { db, type LocalLine, type LocalRecord } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { buildRecordUrl, linkApi } from '$lib/services/deeplink';
import {
	runActionCode,
	apiCall,
	saveRecordWithLines,
	runAnotherTable,
	type RunActionContext
} from '$lib/services/actionRunner';
import { runFlowElement, type FlowElementInput } from '$lib/services/flowElements';

// Движок исполнения сценария (тип таблицы 'flow', граф как в n8n).
//
// Структура графа — в табличных частях записи сценария (сид flows.ts):
//   «Узлы»  (flow_nodes): строки = узлы; у узла может быть код (code) или
//           ссылка на сервис API (service) с параметрами (params);
//   «Связи» (flow_links): строки = рёбра { from_node, to_node, role, label }.
//
// Роли связи (колонка role):
//   flow     — последовательная зависимость: узел «Куда» ждёт завершения «Откуда»
//              и получает его результат во вход;
//   parallel — параллельная ветка: веер из одного узла в несколько исполняется
//              одновременно; узел с несколькими входящими ждёт ВСЕ входы;
//   input    — дополнительный вход: узел должен запросить данные со стороны
//              (например, apiCall к внешнему сервису), прежде чем выполниться;
//              тоже ребро-зависимость, результат источника уходит во вход узла.
//
// Исполнение — «волновая» топологическая обработка: узел готов, когда выполнены
// все его входящие связи; готовые узлы одной волны исполняются параллельно
// (Promise.all). Возвращает { results: {узел: результат}, last: ... }.

export interface FlowEdge {
	from: string | null;
	to: string | null;
	role: string;
	label: string;
}

export interface FlowRunResult {
	results: Record<string, unknown>;
	last: unknown;
}

// Названия табличных частей (стабильные, из сида)
const NODES_TABLE = 'flow_nodes';
const LINKS_TABLE = 'flow_links';

// Заголовок узла для отчёта
function nodeTitle(node: LocalLine): string {
	const d = node.data ?? {};
	if (d.name != null && String(d.name) !== '') return String(d.name);
	return String(d.number ?? node.id);
}
// Параметры узла: jsonb «params» (дефолты) + входные данные от предшественников.
// В ТЧ jsonb хранится строкой — разбираем в объект.
function nodeParams(node: LocalLine, inputs: Record<string, unknown>): Record<string, any> {
	const d = node.data ?? {};
	let base: Record<string, any> = {};
	if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
		base = d.params;
	} else if (typeof d.params === 'string' && d.params.trim()) {
		try {
			const parsed = JSON.parse(d.params);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
		} catch {
			// битый JSON в параметрах узла игнорируем
		}
	}
	return { ...base, ...inputs };
}

// Сырые параметры узла (jsonb «params», без слияния входов) — для элементов
function rawNodeParams(node: LocalLine): Record<string, any> {
	const d = node.data ?? {};
	if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
		return d.params;
	}
	if (typeof d.params === 'string' && d.params.trim()) {
		try {
			const parsed = JSON.parse(d.params);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
		} catch {
			// битый JSON в параметрах узла игнорируем
		}
	}
	return {};
}

// Выполнить один узел:
//   - node_type === 'start' — вернуть входные параметры как есть (стартовая точка);
//   - node_type — элемент из каталога (constant/get/api/template/find/create/run);
//   - есть service (ссылка на api_services) — декларативный apiCall(service, params);
//   - есть code — runActionCode с контекстом (input/inputs/params доступны коду);
//   - иначе — вернуть вход как результат (пассивный/агрегирующий узел).
async function executeNode(
	node: LocalLine,
	inputs: Record<string, unknown>,
	scenario: LocalRecord,
	scenarioLines: LocalLine[],
	scenarioParams: Record<string, any>
): Promise<unknown> {
	const d = node.data ?? {};
	const type = String(d.node_type || '').trim();
	const code = String(d.code || '').trim();
	const serviceId = d.service ? String(d.service) : '';

	const params = nodeParams(node, inputs);

	if (type === 'start') {
		return params;
	}

	const input = inputs.flow ?? inputs.input ?? undefined;

	// Элемент из каталога (constant/get/api/template/find/create/run)
	const ELEMENT_TYPES = ['constant', 'get', 'api', 'template', 'find', 'create', 'run'];
	if (ELEMENT_TYPES.includes(type)) {
		const e: FlowElementInput = {
			node,
			input,
			params: rawNodeParams(node),
			scenario,
			scenarioLines,
			scenarioParams,
			apiCall,
			runAnotherTable,
			saveRecordWithLines
		};
		return await runFlowElement(type, e);
	}

	if (serviceId) {
		const serviceRecord = await db.data_records.get(serviceId);
		if (!serviceRecord) throw new Error(`Узел «${nodeTitle(node)}»: сервис API не найден`);
		const res = await apiCall(serviceRecord, params);
		if (!res.ok) {
			throw new Error(
				`Узел «${nodeTitle(node)}»: HTTP ${res.status}: ${String(res.raw).slice(0, 300)}`
			);
		}
		return res.data ?? res.raw;
	}

	if (code) {
		const ctx: RunActionContext = {
			record: scenario,
			records: [scenario],
			lines: scenarioLines,
			params,
			input,
			inputs,
			db,
			supabase,
			save: saveRecordWithLines,
			log: (...args) => console.log(`[Узел «${nodeTitle(node)}»]`, ...args),
			link: linkApi,
			apiCall,
			run: runAnotherTable,
			flow: flowHelper
		};
		return await runActionCode(code, ctx);
	}

	// Пассивный узел: просто прокладываем вход дальше
	return inputs.flow ?? inputs.input ?? params;
}

// Выполнить сценарий (запись таблицы типа 'flow') по её id.
export async function flowExecute(
	recordId: string,
	scenarioParams: Record<string, any> = {}
): Promise<FlowRunResult> {
	const scenario = await db.data_records.get(recordId);
	if (!scenario) throw new Error('Запись сценария не найдена: ' + recordId);

	const allLines = await db.data_lines.where('record_id').equals(recordId).toArray();
	const nodesTable = await db.meta_tables.where('name').equals(NODES_TABLE).first();
	const linksTable = await db.meta_tables.where('name').equals(LINKS_TABLE).first();
	if (!nodesTable || !linksTable) {
		throw new Error('У сценария нет табличных частей «Узлы»/«Связи»');
	}

	const nodes = allLines.filter((l) => l.table_id === nodesTable.id);
	const linkLines = allLines.filter((l) => l.table_id === linksTable.id);
	if (nodes.length === 0) return { results: {}, last: null };

	const nodeById = new Map(nodes.map((n) => [n.id, n]));

	// Рёбра: пропускаем битые (несуществующий узел), но пишем предупреждение
	const edges: FlowEdge[] = [];
	for (const l of linkLines) {
		const from = l.data?.from_node ? String(l.data.from_node) : null;
		const to = l.data?.to_node ? String(l.data.to_node) : null;
		if (from && to && !nodeById.has(from)) {
			console.warn(`Сценарий ${recordId}: связь ссылается на отсутствующий узел «откуда»`);
			continue;
		}
		if (to && !nodeById.has(to)) {
			console.warn(`Сценарий ${recordId}: связь ссылается на отсутствующий узел «куда»`);
			continue;
		}
		if (!from || !to) continue; // недостроенная связь
		edges.push({
			from,
			to,
			role: String(l.data?.role || 'flow'),
			label: String(l.data?.label || '')
		});
	}

	// Входящие/исходящие рёбра по узлам
	const incoming = new Map<string, FlowEdge[]>();
	const outgoing = new Map<string, FlowEdge[]>();
	for (const id of nodeById.keys()) {
		incoming.set(id, []);
		outgoing.set(id, []);
	}
	for (const e of edges) {
		outgoing.get(e.from!)!.push(e);
		incoming.get(e.to!)!.push(e);
	}

	// Счётчики невыполненных входов; готовы те, у кого 0
	const remaining = new Map<string, number>();
	for (const [id, ins] of incoming) remaining.set(id, ins.length);
	let ready = nodes.filter((n) => (remaining.get(n.id) ?? 0) === 0);

	if (ready.length === 0) {
		throw new Error('В графе сценария нет стартовых узлов (возможно, цикл)');
	}

	const results: Record<string, unknown> = {};
	const done = new Set<string>();
	const readySet = new Set(ready.map((n) => n.id));

	// Накопляемый контекст сценария: входные параметры + результаты всех
	// выполненных узлов (по наименованию узла и слитые ключи объектов), чтобы
	// узел мог ссылаться на результат ЛЮБОГО предыдущего узла (${имя_узла}).
	const context: Record<string, any> = { ...(scenarioParams ?? {}) };

	// Волновая обработка: каждая волна — параллельное исполнение всех готовых узлов
	while (ready.length > 0) {
		const wave = [...ready];
		ready = [];

		const waveResults = await Promise.all(
			wave.map((node) => {
				const ins = incoming.get(node.id) ?? [];
				const inputs: Record<string, unknown> = {};
				for (const e of ins) {
					inputs[e.role] = results[e.from!];
				}
				return executeNode(node, inputs, scenario, allLines, context);
			})
		);

		wave.forEach((node, i) => {
			const value = waveResults[i];
			results[node.id] = value;
			done.add(node.id);
			readySet.delete(node.id);
			// Результат узла доступен последующим узлам по его наименованию
			const title = nodeTitle(node);
			context[title] = value;
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				Object.assign(context, value);
			}
		});

		// Освобождаем зависимые узлы
		for (const node of wave) {
			for (const e of outgoing.get(node.id) ?? []) {
				if (!e.to || done.has(e.to)) continue;
				const rem = (remaining.get(e.to) ?? 0) - 1;
				remaining.set(e.to, rem);
				if (rem === 0 && !readySet.has(e.to) && !done.has(e.to)) {
					ready.push(nodeById.get(e.to)!);
					readySet.add(e.to);
				}
			}
		}
	}

	// Недостижимые узлы (цикл или оторванные) — не молчим
	const unreachable = nodes.filter((n) => !done.has(n.id));
	if (unreachable.length > 0) {
		throw new Error(
			'Не удалось выполнить узлы (цикл или нет входящих связей): ' +
				unreachable.map(nodeTitle).join(', ')
		);
	}

	// Последний выполненный узел: тот, у которого нет исходящих рёбер
	let lastId: string | null = null;
	for (const [id, outs] of outgoing) {
		if (outs.length === 0 && done.has(id)) lastId = id;
	}
	if (lastId === null && done.size > 0) {
		const order = [...done];
		lastId = order[order.length - 1];
	}

	// Человекочитаемый отчёт: имя узла → результат
	const readable: Record<string, unknown> = {};
	for (const n of nodes) readable[nodeTitle(n)] = results[n.id];

	return { results: readable, last: lastId ? results[lastId] : null };
}

// Хелпер для runCode: выполняет сценарий по id записи.
// В контексте действия доступен как `flow` (см. actionRunner.ts).
export function flowHelper(
	recordId: string,
	params: Record<string, any> = {}
): Promise<FlowRunResult> {
	return flowExecute(recordId, params);
}
