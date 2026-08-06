<script lang="ts">
	import type { LocalLine } from '$lib/db/indexeddb';
	import UniversalField from '$lib/fields/UniversalField.svelte';

	// Таблица периодов периодической константы: дата (ISO) + значение
	let { lines = $bindable([]), onChange = null, readOnly = false, valueType = 'string' } = $props();

	let selectedLineId = $state<string | null>(null);

	function defaultForType(type: string): any {
		if (type === 'number') return 0;
		if (type === 'boolean') return false;
		if (type === 'universal') return { t: 'string', v: '' };
		return '';
	}

	function addLine() {
		lines.push({
			id: crypto.randomUUID(),
			data: { period: '', value: defaultForType(valueType) },
			sort_order: lines.length
		});
		selectedLineId = null;
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

	// ISO -> значение для <input type="datetime-local">
	function toLocalInput(iso: string | undefined | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	function fromLocalInput(v: string): string {
		if (!v) return '';
		const d = new Date(v);
		return isNaN(d.getTime()) ? '' : d.toISOString();
	}
</script>

<div class="periods-section">
	<div class="periods-actions">
		<button onclick={addLine} class="btn-add" disabled={readOnly}>➕ Добавить период</button>
		<button
			onclick={removeSelectedLine}
			class="btn-add btn-remove"
			disabled={!selectedLineId || readOnly}
		>
			❌ Удалить период
		</button>
	</div>

	<table class="periods-table">
		<thead>
			<tr>
				<th style="width: 40px;">№</th>
				<th style="width: 240px;">Дата</th>
				<th>Значение</th>
			</tr>
		</thead>
		<tbody>
			{#if lines.length === 0}
				<tr
					><td colSpan="3" class="empty-text">Таблица периодов пуста. Добавьте первый период.</td
					></tr
				>
			{:else}
				{#each lines as line, index (line.id)}
					<tr
						class="periods-row"
						class:selected={selectedLineId === line.id}
						onclick={() => {
							if (!readOnly) selectedLineId = line.id;
						}}
					>
						<td class="text-center">{index + 1}</td>
						<td>
							<input
								type="datetime-local"
								value={toLocalInput(line.data.period)}
								onchange={(e) => {
									line.data.period = fromLocalInput(e.currentTarget.value);
									if (onChange) onChange();
								}}
								disabled={readOnly}
								class="cell-input"
							/>
						</td>
						<td>
							{#if valueType === 'universal'}
								<UniversalField
									bind:value={line.data.value}
									disabled={readOnly}
									onChange={() => onChange?.()}
								/>
							{:else if valueType === 'number'}
								<input
									type="number"
									step="any"
									bind:value={line.data.value}
									oninput={() => onChange?.()}
									disabled={readOnly}
									class="cell-input text-right"
								/>
							{:else if valueType === 'boolean'}
								<input
									type="checkbox"
									bind:checked={line.data.value}
									onchange={() => onChange?.()}
									disabled={readOnly}
									class="cell-checkbox"
								/>
							{:else if valueType === 'date'}
								<input
									type="date"
									bind:value={line.data.value}
									onchange={() => onChange?.()}
									disabled={readOnly}
									class="cell-input"
								/>
							{:else}
								<input
									type="text"
									bind:value={line.data.value}
									oninput={() => onChange?.()}
									disabled={readOnly}
									class="cell-input"
								/>
							{/if}
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

<style>
	.periods-section {
		padding: 10px;
	}
	.periods-actions {
		display: flex;
		gap: 8px;
		margin-bottom: 8px;
	}
	.btn-add {
		background: #ffffff;
		border: 1px solid #cbd5e1;
		font-size: 0.8rem;
		padding: 5px 12px;
		border-radius: 4px;
		cursor: pointer;
		color: #1e293b;
	}
	.btn-add:hover:not(:disabled) {
		background: #f1f5f9;
	}
	.btn-add:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.btn-remove {
		color: #ef4444;
	}
	.periods-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.periods-table th {
		background: #f8fafc;
		border: 1px solid #cbd5e1;
		padding: 6px;
		text-align: left;
	}
	.periods-table td {
		border: 1px solid #e2e8f0;
		padding: 4px 6px;
		color: #334155;
	}
	.periods-row {
		cursor: pointer;
	}
	.periods-row:hover {
		background-color: #f8fafc;
	}
	.periods-row.selected {
		background-color: #fef08a !important;
	}
	.cell-input {
		width: 100%;
		box-sizing: border-box;
		padding: 4px 6px;
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		font-size: 0.85rem;
		outline: none;
	}
	.cell-input:focus {
		border-color: #3b82f6;
	}
	.cell-checkbox {
		width: auto;
	}
	.text-center {
		text-align: center;
	}
	.text-right {
		text-align: right;
	}
	.empty-text {
		text-align: center;
		color: #94a3b8;
		padding: 1.5rem !important;
	}
</style>
