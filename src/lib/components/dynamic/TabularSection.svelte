<script lang="ts">
	import LookupInput from '../ui/LookupInput.svelte';
	import type { LocalLine } from '$lib/db/indexeddb';
	let { lines = $bindable([]), onChange = null, readOnly = false, tableId = '' } = $props();
	let selectedLineId = $state<string | null>(null);

	function addLine() {
		lines.push({
			id: crypto.randomUUID(),
			data: { product: '', quantity: 1, price: 0, amount: 0 }
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

	function calculateAmount(line: LocalLine) {
		const qty = parseFloat(line.data.quantity) || 0;
		const prc = parseFloat(line.data.price) || 0;
		line.data.amount = Number((qty * prc).toFixed(2));
		if (onChange) onChange();
	}
	function handleProductSelect(line: LocalLine, productData: Record<string, any>) {
		// Если в справочнике Номенклатура у товара есть цена, автоматически переносим её в документ
		// (Для теста вы можете добавить цену в JSON товара, например {"price": 45000})
		if (productData.price) {
			line.data.price = parseFloat(productData.price) || 0;
		}

		// Пересчитываем сумму строки
		calculateAmount(line);
	}
</script>

<div class="tabular-section">
	<!-- Командная панель табличной части -->
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

	<table class="section-table">
		<thead>
			<tr>
				<th style="width: 40px;">№</th>
				<th>Номенклатура / Описание</th>
				<th style="width: 100px;">Кол-во</th>
				<th style="width: 120px;">Цена</th>
				<th style="width: 140px;">Сумма</th>
			</tr>
		</thead>
		<tbody>
			{#if lines.length === 0}
				<tr><td colSpan="5" class="empty-text">Табличная часть пуста.</td></tr>
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
						<td>
							<LookupInput
								bind:value={line.data.product}
								targetTableId={tableId}
								disabled={readOnly}
								onSelect={(productData) => handleProductSelect(line, productData)}
							/>
						</td>
						<td>
							<input
								type="number"
								bind:value={line.data.quantity}
								oninput={() => calculateAmount(line)}
								disabled={readOnly}
								class="cell-input text-right"
							/>
						</td>
						<td>
							<input
								type="number"
								bind:value={line.data.price}
								oninput={() => calculateAmount(line)}
								disabled={readOnly}
								class="cell-input text-right"
							/>
						</td>
						<td>
							<input
								type="number"
								value={line.data.amount}
								readonly
								class="cell-input text-right readonly"
							/>
						</td>
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
	} /* Желтое выделение строки */
	.btn-remove {
		margin-left: 4px;
		color: #ef4444;
	}
	.btn-remove:disabled {
		color: #cbd5e1;
	}
</style>
