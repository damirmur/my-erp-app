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
import { importStatement } from '$lib/services/bankParser';

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

// Статус шага (узла) сценария после исполнения: выполнен / ошибка / не выполнялся.
export interface FlowStep {
	name: string;
	status: 'ok' | 'error' | 'pending';
	error?: string;
	durationMs?: number;
}

export interface FlowRunResult {
	results: Record<string, unknown>;
	last: unknown;
	steps: FlowStep[];
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
// Парсинг jsonb-параметров (объект или JSON-строка) в объект.
function parseParams(value: unknown): Record<string, any> {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
		} catch {
			// битый JSON игнорируем
		}
	}
	return {};
}

// Выполнить один узел:
//   - узел может ссылаться на запись каталога «Элементы сценария» (flow_elements):
//     элемент задаёт тип/сервис/параметры/код по умолчанию, узел — переопределения;
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
	let type = String(d.node_type || '').trim();
	let code = String(d.code || '').trim();
	let serviceId = d.service ? String(d.service) : '';

	const nodeBase = parseParams(d.params);
	let elementParams: Record<string, any> = {};
	if (d.element) {
		const element = await db.data_records.get(String(d.element));
		if (element) {
			const ed = element.data ?? {};
			if (!type) type = String(ed.element_type || '').trim();
			if (!code) code = String(ed.code || '').trim();
			if (!serviceId && ed.service) serviceId = String(ed.service);
			elementParams = parseParams(ed.params);
		}
	}

	// Приоритет: входные данные > переопределения узла > дефолты элемента.
	const rawParams = { ...elementParams, ...nodeBase };
	const params = { ...rawParams, ...inputs };

	if (type === 'start') {
		return params;
	}

	const input = inputs.flow ?? inputs.input ?? undefined;

	// Элемент из каталога (constant/get/api/template/find/create/run)
	const ELEMENT_TYPES = ['constant', 'get', 'api', 'template', 'find', 'create', 'run'];
	if (ELEMENT_TYPES.includes(type)) {
		// Эффективный узел: элемент-дефолты слиты в data, чтобы реализации элементов
		// (elementApi читает node.data.service, elementConstant — params и т.д.)
		// работали единообразно и для узлов со ссылкой на запись каталога.
		const effNode: LocalLine = {
			...node,
			data: { ...d, node_type: type, code, service: serviceId, params: rawParams }
		};
		const e: FlowElementInput = {
			node: effNode,
			input,
			params: rawParams,
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
			// Входные параметры сценария доступны коду узла наравне с параметрами
			// самого узла (params.statements и т.п.), даже если у узла нет входа.
			params: { ...scenarioParams, ...params },
			input,
			inputs,
			db,
			supabase,
			save: saveRecordWithLines,
			log: (...args) => console.log(`[Узел «${nodeTitle(node)}»]`, ...args),
			link: linkApi,
			apiCall,
			run: runAnotherTable,
			flow: flowHelper,
			importStatement
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
	if (nodes.length === 0) return { results: {}, last: null, steps: [] };

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

	// Статусы шагов: что выполнено, что упало (и с какой ошибкой), что не добралось.
	const steps: FlowStep[] = [];
	const stepByName = new Map<string, FlowStep>();
	function ensureStep(name: string): FlowStep {
		let s = stepByName.get(name);
		if (!s) {
			s = { name, status: 'pending' };
			steps.push(s);
			stepByName.set(name, s);
		}
		return s;
	}
	function markPendingDownstream() {
		// Не выполненные узлы помечаем как «не добрались»; статус уже существующих
		// шагов (например, error у упавшего узла) не перезаписываем.
		for (const n of nodes) {
			if (!done.has(n.id)) ensureStep(nodeTitle(n));
		}
	}

	// Волновая обработка: каждая волна — параллельное исполнение всех готовых узлов.
	// Ошибка узла фиксируется в steps и прерывает исполнение (зависимые — «pending»).
	try {
		while (ready.length > 0) {
			const wave = [...ready];
			ready = [];

			const waveResults = await Promise.all(
				wave.map(async (node) => {
					const step = ensureStep(nodeTitle(node));
					const t0 = performance.now();
					const ins = incoming.get(node.id) ?? [];
					const inputs: Record<string, unknown> = {};
					for (const e of ins) {
						inputs[e.role] = results[e.from!];
					}
					try {
						const value = await executeNode(node, inputs, scenario, allLines, context);
						step.status = 'ok';
						step.durationMs = Math.round(performance.now() - t0);
						delete step.error;
						return value;
					} catch (e: any) {
						step.status = 'error';
						step.error = e?.message ?? String(e);
						step.durationMs = Math.round(performance.now() - t0);
						throw e;
					}
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
			markPendingDownstream();
			throw new Error(
				'Не удалось выполнить узлы (цикл или нет входящих связей): ' +
					unreachable.map(nodeTitle).join(', ')
			);
		}
	} catch (e: any) {
		markPendingDownstream();
		e.steps = steps;
		throw e;
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

	return { results: readable, last: lastId ? results[lastId] : null, steps };
}

// Хелпер для runCode: выполняет сценарий по id записи.
// В контексте действия доступен как `flow` (см. actionRunner.ts).
export function flowHelper(
	recordId: string,
	params: Record<string, any> = {}
): Promise<FlowRunResult> {
	return flowExecute(recordId, params);
}
