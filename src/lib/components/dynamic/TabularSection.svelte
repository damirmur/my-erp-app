<script lang="ts">
	import { db, type LocalLine, type LocalColumn } from '$lib/db/indexeddb';
	import { fieldRegistry } from '$lib/fields';
	import { defaultBirth } from '$lib/fields/birth';
	import './erpTable.css';
	let { lines = $bindable([]), onChange = null, readOnly = false, tableId = '' } = $props();
	let selectedLineId = $state<string | null>(null);
	let columns = $state<LocalColumn[]>([]);

	// Авторасчёт суммы (как в документах): если в ТЧ есть колонки price/quantity/amount
	let hasAmountAuto = $derived(
		columns.some((c) => c.name === 'price') &&
			columns.some((c) => c.name === 'quantity') &&
			columns.some((c) => c.name === 'amount')
	);

	$effect(() => {
		if (!tableId) return;
		db.meta_columns
			.where('table_id')
			.equals(tableId)
			.sortBy('sort_order')
			.then((cols) => {
				columns = cols;
			});
	});

	function defaultLineData(): Record<string, unknown> {
		const data: Record<string, unknown> = {};
		for (const col of columns) {
			if (col.type === 'boolean') data[col.name] = false;
			else if (col.type === 'birth') data[col.name] = defaultBirth();
			else if (col.type === 'number') data[col.name] = 0;
			else data[col.name] = '';
		}
		return data;
	}

	function addLine() {
		lines.push({
			id: crypto.randomUUID(),
			data: defaultLineData(),
			sort_order: lines.length
		});
		if (onChange) onChange();
	}

	function removeSelectedLine() {
		if (!selectedLineId) {
			alert('Выберите строку для удаления');
			return;
		}
		const index = lines.findIndex((l) => l.id === selectedLineId);
		if (index !== -1) {
			lines.splice(index, 1);
			selectedLineId = null;
			if (onChange) onChange();
		}
	}

	function recomputeAmount(line: LocalLine) {
		const qty = parseFloat(line.data.quantity as any) || 0;
		const prc = parseFloat(line.data.price as any) || 0;
		line.data.amount = Number((qty * prc).toFixed(2));
	}

	function handleLinkSelect(line: LocalLine, data: Record<string, any>) {
		if (columns.some((c) => c.name === 'price') && data?.price != null) {
			line.data.price = parseFloat(data.price) || 0;
		}
		recomputeAmount(line);
	}

	function cellChange(col: LocalColumn, line: LocalLine, arg: any) {
		if (col.type === 'link') {
			handleLinkSelect(line, arg);
		} else if (hasAmountAuto && (col.name === 'quantity' || col.name === 'price')) {
			recomputeAmount(line);
		}
		if (onChange) onChange();
	}
</script>

<div class="tabular-section">
	<div class="tabular-actions">
		<button onclick={addLine} class="btn-add" disabled={readOnly}>➕ Добавить строку</button>
		<button
			onclick={removeSelectedLine}
			class="btn-add btn-remove"
			disabled={!selectedLineId || readOnly}
		>
			❌ Удалить строку
		</button>
	</div>

	<table class="erp-table">
		<thead>
			<tr>
				<th style="width: 40px;">№</th>
				{#each columns as col}
					<th>{col.title}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#if lines.length === 0}
				<tr><td colSpan={columns.length + 1} class="empty-text">Табличная часть пуста.</td></tr>
			{:else}
				{#each lines as line, index (line.id)}
					<tr
						class="tabular-row"
						class:selected={selectedLineId === line.id}
						onclick={() => {
							if (!readOnly) selectedLineId = line.id;
						}}
					>
						<td class="text-center">{index + 1}</td>
						{#each columns as col}
							<td>
								{#if fieldRegistry[col.type]?.FormField}
									{@const FC = fieldRegistry[col.type].FormField}
									<FC
										bind:value={line.data[col.name]}
										disabled={readOnly || (hasAmountAuto && col.name === 'amount')}
										onChange={(arg: any) => cellChange(col, line, arg)}
										relatedTableId={col.related_table_id ?? ''}
									/>
								{:else}
									{String(line.data[col.name] ?? '')}
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

<style>
	.tabular-row {
		cursor: pointer;
	}
	.tabular-row:hover {
		background-color: #f8fafc;
	}
	.tabular-row.selected {
		background-color: #fef08a !important;
	}
	.tabular-actions {
		display: flex;
		gap: 6px;
		margin-bottom: 8px;
	}
	.btn-add {
		background: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		padding: 5px 10px;
		font-size: 0.8rem;
		cursor: pointer;
		color: #334155;
	}
	.btn-add:hover {
		background: #f1f5f9;
	}
	.btn-add:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.btn-remove {
		color: #ef4444;
	}
	.btn-remove:disabled {
		color: #cbd5e1;
	}
	.empty-text {
		text-align: center;
		color: #94a3b8;
		padding: 1.5rem !important;
	}
	.text-center {
		text-align: center;
	}
</style>
