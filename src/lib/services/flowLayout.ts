import type { LocalLine } from '$lib/db/indexeddb';

// Раскладка сценария для диаграммы: топологические волны выполнения, как в
// движке flowRunner (узел готов, когда выполнены все его входящие связи).
// Волна узла = 0 при отсутствии входящих, иначе max(волна источников) + 1.
// Узлы с циклом или без входящих связей (недостижимые) собираются в
// отдельную группу `cycles` в конце — на схеме их видно, но движок их не
// выполнит (см. flowRunner: «нет стартовых узлов» / unreachable).

export interface FlowLayoutNode {
	line: LocalLine;
	wave: number;
	inCycle: boolean;
}

export interface FlowLayoutEdge {
	from: string;
	to: string;
	role: string;
	label: string;
	broken: boolean;
}

export interface FlowLayoutResult {
	nodes: FlowLayoutNode[];
	waves: string[][];
	edges: FlowLayoutEdge[];
	cycles: string[];
}

export function flowLayout(nodes: LocalLine[], links: LocalLine[]): FlowLayoutResult {
	const byId = new Map<string, LocalLine>(nodes.map((n) => [n.id, n]));

	const edges: FlowLayoutEdge[] = [];
	for (const l of links) {
		const from = l.data?.from_node ? String(l.data.from_node) : '';
		const to = l.data?.to_node ? String(l.data.to_node) : '';
		const hasFrom = !!from && byId.has(from);
		const hasTo = !!to && byId.has(to);
		if (!hasFrom || !hasTo) {
			// Битые/недостроенные связи — показываем пунктиром, если один конец есть
			edges.push({
				from,
				to,
				role: String(l.data?.role || 'flow'),
				label: String(l.data?.label || ''),
				broken: true
			});
			continue;
		}
		edges.push({
			from,
			to,
			role: String(l.data?.role || 'flow'),
			label: String(l.data?.label || ''),
			broken: false
		});
	}

	// Входящие/исходящие по узлам
	const incoming = new Map<string, LocalLine[]>();
	const outgoing = new Map<string, LocalLine[]>();
	for (const id of byId.keys()) {
		incoming.set(id, []);
		outgoing.set(id, []);
	}
	for (const e of edges) {
		if (!e.broken) {
			outgoing.get(e.from)!.push(byId.get(e.to)!);
			incoming.get(e.to)!.push(byId.get(e.from)!);
		}
	}

	// Топологическая волна: повторяем «узел готов, когда выполнены все входы»
	const remaining = new Map<string, number>();
	for (const [id, ins] of incoming) remaining.set(id, ins.length);
	const waveById = new Map<string, number>();
	let ready = nodes.filter((n) => (remaining.get(n.id) ?? 0) === 0);
	const done = new Set<string>();

	// Сначала обычные узлы (без циклов): прогоняем волны, как движок.
	const normal: LocalLine[] = [];
	const queue = [...ready];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (done.has(cur.id)) continue;
		done.add(cur.id);
		normal.push(cur);
		for (const out of outgoing.get(cur.id) ?? []) {
			const rem = (remaining.get(out.id) ?? 0) - 1;
			remaining.set(out.id, rem);
			if (rem === 0 && !done.has(out.id)) queue.push(out);
		}
	}

	// Остаток — цикл или оторванный узел (нет входящих, но остался? — так не
	// бывает; это узлы, к которым не добрались из-за цикла).
	const cycles = nodes.filter((n) => !done.has(n.id)).map((n) => n.id);

	for (let i = 0; i < normal.length; i++) {
		const id = normal[i].id;
		const maxIn = Math.max(
			0,
			...((incoming.get(id) ?? []).map((src) => waveById.get(src.id) ?? 0) ?? [])
		);
		waveById.set(id, maxIn + 1);
	}
	for (const id of cycles)
		waveById.set(id, (waveById.size > 0 ? Math.max(...waveById.values()) : 0) + 1);

	// Колонки по волнам
	const waves: string[][] = [];
	const nodeByWave = new Map<number, string[]>();
	for (const id of waveById.keys()) {
		const w = waveById.get(id)!;
		if (!nodeByWave.has(w)) nodeByWave.set(w, []);
		nodeByWave.get(w)!.push(id);
	}
	for (const w of [...nodeByWave.keys()].sort((a, b) => a - b)) {
		waves.push(nodeByWave.get(w)!);
	}

	const nodesOut: FlowLayoutNode[] = nodes.map((n) => ({
		line: n,
		wave: waveById.get(n.id) ?? 0,
		inCycle: cycles.includes(n.id)
	}));

	return { nodes: nodesOut, waves, edges, cycles };
}
