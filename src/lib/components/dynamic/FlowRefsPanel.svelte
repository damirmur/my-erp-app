<script lang="ts">
	import { db, type LocalLine } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { buildRecordUrl, buildListUrl } from '$lib/services/deeplink';

	let { data = {}, lines = [] } = $props<{ data: Record<string, any>; lines: LocalLine[] }>();

	interface Ref {
		label: string;
		value?: string;
		href?: string;
	}
	interface NodeBlock {
		name: string;
		refs: Ref[];
	}

	let paramRefs = $state<Ref[]>([]);
	let nodeRefs = $state<NodeBlock[]>([]);

	function isRecordId(v: unknown): boolean {
		return (
			typeof v === 'string' &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())
		);
	}

	async function recordRef(recordId: string): Promise<Ref> {
		const rec = await db.data_records.get(recordId);
		if (!rec) return { label: recordId, href: buildRecordUrl(recordId) };
		const table = rec.table_id ? ((await db.meta_tables.get(rec.table_id)) ?? null) : null;
		const title = rec.data?.number || rec.data?.name || table?.title || recordId;
		return { label: `${table?.title ?? ''}: ${title}`.trim(), href: buildRecordUrl(recordId) };
	}

	async function tableRef(tableName: string, prefix = ''): Promise<Ref> {
		const table = await db.meta_tables.where('name').equals(tableName).first();
		return {
			label: `${prefix}${table?.title ?? tableName} (${tableName})`,
			href: table ? buildListUrl(table.id) : buildListUrl(tableName)
		};
	}

	function scanTokens(obj: unknown, out: string[]): void {
		if (typeof obj === 'string') {
			for (const m of obj.match(/\$\{([^}]+)\}/g) ?? []) {
				const k = m.slice(2, -1).trim();
				if (k && !out.includes(k)) out.push(k);
			}
			return;
		}
		if (Array.isArray(obj)) return obj.forEach((v) => scanTokens(v, out));
		if (obj && typeof obj === 'object') {
			for (const v of Object.values(obj as Record<string, unknown>)) scanTokens(v, out);
		}
	}

	function pushRef(refs: Ref[], ref: Ref) {
		if (!refs.some((r) => r.href === ref.href && r.label === ref.label)) refs.push(ref);
	}

	let token = 0;

	$effect(() => {
		const p = data?.params;
		let paramsObj: Record<string, any> = {};
		if (p && typeof p === 'object' && !Array.isArray(p)) {
			paramsObj = p;
		} else if (typeof p === 'string' && p.trim()) {
			try {
				const parsed = JSON.parse(p);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) paramsObj = parsed;
			} catch {
				// битый JSON в параметрах — показываем как пусто
			}
		}
		const all = lines;
		const my = ++token;
		void (async () => {
			// Параметры сценария
			const pRefs: Ref[] = [];
			for (const [k, v] of Object.entries(paramsObj)) {
				if (isRecordId(v)) {
					const r = await recordRef(String(v).trim());
					pRefs.push({ label: `${k} → ${r.label}`, href: r.href });
				} else if (v && typeof v === 'object') {
					pRefs.push({ label: k, value: JSON.stringify(v) });
				} else {
					pRefs.push({ label: k, value: v == null ? '' : String(v) });
				}
			}

			// Узлы и их ссылки
			const nodesTable = await db.meta_tables.where('name').equals('flow_nodes').first();
			const nodeLines = nodesTable
				? all.filter((l: LocalLine) => l.table_id === nodesTable.id)
				: [];
			const blocks: NodeBlock[] = [];
			for (const node of nodeLines) {
				const d = node.data ?? {};
				const name = String(d.name || d.number || node.id);
				const refs: Ref[] = [];

				// Элемент каталога (flow_elements) + переопределения узла: ссылки
				// строим по эффективному типу/сервису/параметрам (элемент + узел).
				let eType = String(d.node_type || '');
				let eService = d.service ? String(d.service) : '';
				let np =
					d.params && typeof d.params === 'object' && !Array.isArray(d.params) ? d.params : {};
				if (d.element) {
					const el = await db.data_records.get(String(d.element));
					if (el) {
						const ed = el.data ?? {};
						pushRef(refs, {
							label: `Элемент → ${ed.name || '…'}`,
							href: buildRecordUrl(el.id)
						});
						if (!eType) eType = String(ed.element_type || '');
						if (!eService && ed.service) eService = String(ed.service);
						const elParams =
							ed.params && typeof ed.params === 'object' && !Array.isArray(ed.params)
								? ed.params
								: {};
						np = { ...elParams, ...np };
					}
				}
				const type = eType;

				if (type === 'constant' && np.name) {
					const constName = String(np.name);
					const ct = await db.meta_tables.where('name').equals('constants').first();
					const cRec = ct
						? await db.data_records
								.where('table_id')
								.equals(ct.id)
								.filter((r) => r.data?.name === constName)
								.first()
						: undefined;
					if (cRec) {
						pushRef(refs, { label: `Константа «${constName}»`, href: buildRecordUrl(cRec.id) });
					} else {
						pushRef(refs, { label: `Константа «${constName}» (не найдена)` });
					}
				}
				if (type === 'api' && eService) {
					const r = await recordRef(eService);
					pushRef(refs, { label: `Сервис API → ${r.label}`, href: r.href });
				}
				if (['find', 'create', 'run'].includes(type) && np.table) {
					pushRef(refs, await tableRef(String(np.table)));
				}
				if (type === 'create' && np.lines && typeof np.lines === 'object') {
					for (const subName of Object.keys(np.lines)) {
						pushRef(refs, await tableRef(subName, 'ТЧ → '));
					}
				}
				// Ссылки на параметры сценария вида ${kontragent} (если значение — id записи)
				const tokens: string[] = [];
				scanTokens(np, tokens);
				for (const key of tokens) {
					const pv = paramsObj[key];
					if (pv && isRecordId(pv)) {
						const r = await recordRef(String(pv).trim());
						pushRef(refs, { label: `${key} → ${r.label}`, href: r.href });
					}
				}

				blocks.push({ name, refs });
			}

			if (my !== token) return;
			paramRefs = pRefs;
			nodeRefs = blocks;
		})();
	});
</script>

<div class="flow-refs">
	<div class="refs-section">
		<div class="refs-title">⚙️ Параметры сценария</div>
		{#if paramRefs.length === 0}
			<div class="refs-empty">Параметры не заданы</div>
		{:else}
			<ul>
				{#each paramRefs as ref (ref.label)}
					<li>
						{#if ref.href}
							<button class="ref-link" onclick={() => workspace.openFromLink(ref.href ?? '')}>
								{ref.label}
							</button>
						{:else}
							<span class="ref-key">{ref.label}</span>
							{#if ref.value}<code class="ref-value">{ref.value}</code>{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="refs-section">
		<div class="refs-title">🔗 Ссылки узлов</div>
		{#if nodeRefs.length === 0}
			<div class="refs-empty">Нет узлов</div>
		{:else}
			{#each nodeRefs as block (block.name)}
				<div class="node-block">
					<div class="node-name">🟦 {block.name}</div>
					{#if block.refs.length === 0}
						<div class="refs-empty">нет ссылок</div>
					{:else}
						<ul>
							{#each block.refs as ref (ref.label)}
								<li>
									{#if ref.href}
										<button class="ref-link" onclick={() => workspace.openFromLink(ref.href ?? '')}>
											{ref.label}
										</button>
									{:else}
										<span>{ref.label}</span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	.flow-refs {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 1.5rem;
	}
	.refs-section {
		border: 1px solid #e2e8f0;
		border-radius: 0.5rem;
		padding: 0.75rem;
		background: #f8fafc;
	}
	.refs-title {
		font-weight: 600;
		margin-bottom: 0.5rem;
		font-size: 0.85rem;
	}
	.refs-empty {
		color: #94a3b8;
		font-size: 0.8rem;
	}
	.node-block {
		margin-top: 0.5rem;
		padding: 0.4rem 0.6rem;
		background: #ffffff;
		border: 1px solid #e2e8f0;
		border-radius: 0.375rem;
	}
	.node-name {
		font-weight: 600;
		font-size: 0.8rem;
		margin-bottom: 0.3rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0.2rem 0;
		font-size: 0.8rem;
	}
	.ref-link {
		background: none;
		border: none;
		color: #2563eb;
		cursor: pointer;
		text-align: left;
		padding: 0;
		font-size: 0.8rem;
		text-decoration: underline;
	}
	.ref-link:hover {
		color: #1d4ed8;
	}
	.ref-key {
		font-weight: 600;
	}
	.ref-value {
		font-size: 0.75rem;
		background: #f1f5f9;
		padding: 0 4px;
		border-radius: 3px;
		word-break: break-all;
	}
</style>
