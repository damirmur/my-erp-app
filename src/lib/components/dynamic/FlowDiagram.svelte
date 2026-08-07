<script lang="ts">
	import { db, type LocalLine } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { buildLineUrl } from '$lib/services/deeplink';
	import { flowLayout } from '$lib/services/flowLayout';

	// Read-only схема сценария: узлы по колонкам-волнам (как их исполняет движок
	// flowRunner), стрелки from → to с ролью/подписью. Клик по узлу открывает
	// строку ТЧ «Узлы» (переключение вкладки + подсветка через focusLineId).

	let { data = {}, lines = [] } = $props<{ data: Record<string, any>; lines: LocalLine[] }>();

	let nodesTable = $state<{ id: string; title: string } | null>(null);
	let linksTable = $state<{ id: string; title: string } | null>(null);
	let typeById = $state<Record<string, string>>({});
	let elementNameById = $state<Record<string, string>>({});

	const CARD_W = 190;
	const CARD_H = 66;
	const H_GAP = 90;
	const V_GAP = 26;
	const PAD = 24;
	const HEADER_H = 30;

	$effect(() => {
		void (async () => {
			const nodes = await db.meta_tables.where('name').equals('flow_nodes').first();
			const links = await db.meta_tables.where('name').equals('flow_links').first();
			nodesTable = nodes ? { id: nodes.id, title: nodes.title } : null;
			linksTable = links ? { id: links.id, title: links.title } : null;

			// Эффективный тип узла: node_type узла, иначе element_type из каталога
			const types: Record<string, string> = {};
			const elemNames: Record<string, string> = {};
			const nodeLines = nodes ? lines.filter((l: LocalLine) => l.table_id === nodes.id) : [];
			const elementIds: string[] = nodeLines
				.map((l: LocalLine) => l.data?.element)
				.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
			const elementRecs = await db.data_records.bulkGet([...new Set(elementIds)]);
			const elBy = new Map((elementRecs ?? []).map((r) => [r?.id ?? '', r]));
			for (const l of nodeLines) {
				const d = l.data ?? {};
				let t = String(d.node_type || '');
				if (!t && d.element) {
					const el = elBy.get(String(d.element));
					if (el) {
						t = String(el.data?.element_type || '');
						elemNames[l.id] = String(el.data?.name || '');
					}
				}
				if (!t && d.service) t = 'api';
				if (!t && d.code) t = 'code';
				types[l.id] = t;
			}
			typeById = types;
			elementNameById = elemNames;
		})();
	});

	let nodeLines = $derived(
		nodesTable ? lines.filter((l: LocalLine) => l.table_id === nodesTable!.id) : []
	);
	let linkLines = $derived(
		linksTable ? lines.filter((l: LocalLine) => l.table_id === linksTable!.id) : []
	);
	let layout = $derived(flowLayout(nodeLines, linkLines));

	// Позиции узлов: колонка = волна, в колонке узлы друг под другом.
	let pos = $derived.by(() => {
		const map = new Map<string, { x: number; y: number }>();
		for (const wave of layout.waves) {
			wave.forEach((id, i) => {
				const w = layout.waves.indexOf(wave);
				map.set(id, { x: PAD + w * (CARD_W + H_GAP), y: HEADER_H + PAD + i * (CARD_H + V_GAP) });
			});
		}
		return map;
	});

	let width = $derived(PAD * 2 + Math.max(1, layout.waves.length) * (CARD_W + H_GAP) - H_GAP);
	let height = $derived(
		HEADER_H +
			PAD * 2 +
			Math.max(1, ...layout.waves.map((w) => w.length)) * (CARD_H + V_GAP) -
			V_GAP
	);

	// Цвет/подпись роли связи
	const ROLE_COLOR: Record<string, string> = {
		flow: '#2563eb',
		parallel: '#16a34a',
		input: '#f59e0b'
	};
	const ROLE_LABEL: Record<string, string> = {
		flow: '→',
		parallel: '∥',
		input: '⇥'
	};

	// Бейдж типа узла
	const TYPE_BADGE: Record<string, string> = {
		start: '▶ Старт',
		constant: '📌 Константа',
		get: '🪝 Извлечь',
		api: '🌐 API',
		template: '🖼 Шаблон',
		find: '🔍 Найти',
		create: '➕ Создать',
		run: '🏃 Выполнить',
		code: '🧩 Код'
	};

	function nodeTitle(line: LocalLine): string {
		const d = line.data ?? {};
		if (d.name != null && String(d.name) !== '') return String(d.name);
		return '…';
	}

	function truncate(s: string, n = 24): string {
		return s.length > n ? s.slice(0, n - 1) + '…' : s;
	}

	function openNode(id: string) {
		workspace.openFromLink(buildLineUrl(id));
	}
</script>

{#if nodesTable && linkLines && (nodeLines.length > 0 || linkLines.length > 0)}
	<div class="flow-diagram">
		<div class="diagram-title">📊 Схема сценария</div>
		<div class="diagram-scroll">
			<svg {width} {height} class="diagram-svg">
				<defs>
					<marker
						id="fd-arrow"
						viewBox="0 0 10 10"
						refX="9"
						refY="5"
						markerWidth="7"
						markerHeight="7"
						orient="auto-start-reverse"
					>
						<path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
					</marker>
				</defs>

				<!-- Заголовки волн -->
				{#each layout.waves as wave, wi}
					<text
						x={PAD + wi * (CARD_W + H_GAP) + CARD_W / 2}
						y={HEADER_H - 8}
						text-anchor="middle"
						class="wave-head"
					>
						Шаг {wi + 1}
					</text>
				{/each}

				<!-- Стрелки -->
				{#each layout.edges as e}
					{@const fromPos = pos.get(e.from)}
					{@const toPos = pos.get(e.to)}
					{#if fromPos && toPos}
						<g>
							<line
								x1={fromPos.x + CARD_W}
								y1={fromPos.y + CARD_H / 2}
								x2={toPos.x}
								y2={toPos.y + CARD_H / 2}
								class="edge"
								class:broken={e.broken}
								stroke={ROLE_COLOR[e.role] ?? '#94a3b8'}
								marker-end={e.role === 'input' ? undefined : 'url(#fd-arrow)'}
							/>
							{#if e.label}
								<text
									x={(fromPos.x + CARD_W + toPos.x) / 2}
									y={(fromPos.y + CARD_H / 2 + toPos.y + CARD_H / 2) / 2 - 4}
									text-anchor="middle"
									class="edge-label"
								>
									{ROLE_LABEL[e.role] ?? ''}
									{truncate(e.label, 14)}
								</text>
							{/if}
						</g>
					{/if}
				{/each}

				<!-- Узлы -->
				{#each layout.nodes as node}
					{@const p = pos.get(node.line.id)}
					{@const t = typeById[node.line.id] ?? ''}
					{@const badge = TYPE_BADGE[t] ?? (t ? '▫ ' + t : '')}
					{#if p}
						<g
							class="node-g"
							role="button"
							tabindex="0"
							onclick={() => openNode(node.line.id)}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									openNode(node.line.id);
								}
							}}
						>
							<rect
								x={p.x}
								y={p.y}
								width={CARD_W}
								height={CARD_H}
								rx="8"
								class:in-cycle={node.inCycle}
							/>
							<text x={p.x + 10} y={p.y + 20} class="node-name">
								{truncate(nodeTitle(node.line))}
							</text>
							{#if badge}
								<text x={p.x + 10} y={p.y + 40} class="node-badge">{badge}</text>
							{/if}
							{#if elementNameById[node.line.id] && t}
								<text x={p.x + 10} y={p.y + 56} class="node-element">
									из «{truncate(elementNameById[node.line.id], 20)}»
								</text>
							{/if}
						</g>
					{/if}
				{/each}
			</svg>
		</div>
		{#if layout.cycles.length > 0}
			<div class="diagram-warn">
				⚠️ Узлы вне порядка (цикл или нет входящих связей): {layout.cycles
					.map((id) => nodeLines.find((l: LocalLine) => l.id === id))
					.filter((l): l is LocalLine => !!l)
					.map((l) => nodeTitle(l))
					.join(', ')}
			</div>
		{/if}
	</div>
{/if}

<style>
	.flow-diagram {
		margin-bottom: 1.5rem;
		border: 1px solid #e2e8f0;
		border-radius: 0.5rem;
		padding: 0.75rem;
		background: #f8fafc;
	}
	.diagram-title {
		font-weight: 600;
		font-size: 0.85rem;
		margin-bottom: 0.5rem;
	}
	.diagram-scroll {
		overflow-x: auto;
	}
	.diagram-svg {
		display: block;
		min-width: 100%;
	}
	.wave-head {
		font-size: 12px;
		font-weight: 600;
		fill: #64748b;
	}
	.edge {
		stroke-width: 2;
	}
	.edge.broken {
		stroke-dasharray: 5 4;
	}
	.edge-label {
		font-size: 10px;
		fill: #64748b;
	}
	.node-g {
		cursor: pointer;
	}
	.node-g rect {
		fill: #ffffff;
		stroke: #cbd5e1;
		stroke-width: 1.5;
	}
	.node-g:hover rect {
		stroke: #2563eb;
		stroke-width: 2;
		filter: drop-shadow(0 1px 3px rgba(37, 99, 235, 0.25));
	}
	.node-g rect.in-cycle {
		stroke: #ef4444;
		stroke-dasharray: 5 4;
	}
	.node-name {
		font-size: 13px;
		font-weight: 600;
		fill: #0f172a;
	}
	.node-badge {
		font-size: 11px;
		fill: #2563eb;
	}
	.node-element {
		font-size: 10px;
		fill: #94a3b8;
	}
	.diagram-warn {
		margin-top: 0.5rem;
		font-size: 0.8rem;
		color: #dc2626;
	}
</style>
