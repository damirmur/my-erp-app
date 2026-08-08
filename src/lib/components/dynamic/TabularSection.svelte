<script lang="ts">
	import { db, type LocalLine, type LocalColumn, type LocalRecord } from '$lib/db/indexeddb';
	import { fieldRegistry } from '$lib/fields';
	import { defaultBirth } from '$lib/fields/birth';
	import { selectOptionsFor } from '$lib/services/flowElements';
	import { buildLineUrl, fullUrlFor } from '$lib/services/deeplink';
	import './erpTable.css';
	let {
		lines = $bindable([]),
		onChange = null,
		readOnly = false,
		tableId = '',
		tableName = '',
		recordId = '',
		linelinkCandidates = null,
		focusLineId = ''
	} = $props();
	let selectedLineId = $state<string | null>(null);
	let columns = $state<LocalColumn[]>([]);
	let searchTerm = $state('');
	let sortCol = $state<string | null>(null);
	let sortDir = $state<'asc' | 'desc'>('asc');

	// При открытии формы по ссылке на строку — сразу выделяем эту строку
	$effect(() => {
		if (focusLineId) selectedLineId = focusLineId;
	});

	async function copyLineLink() {
		if (!selectedLineId) return;
		const url = fullUrlFor(buildLineUrl(selectedLineId));
		try {
			await navigator.clipboard.writeText(url);
			alert('Ссылка на строку скопирована: ' + url);
		} catch {
			alert('Не удалось скопировать ссылку: ' + url);
		}
	}

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
			data[col.name] = defaultFor(col.type);
		}
		return data;
	}

	// Значение колонки по умолчанию (для новых строк и нормализации загруженных)
	function defaultFor(type: string): unknown {
		if (type === 'boolean') return false;
		if (type === 'birth') return defaultBirth();
		if (type === 'number') return 0;
		if (type === 'universal') return { t: 'string', v: '' };
		return '';
	}

	// Строки, загруженные из БД, могут не содержать всех колонок (например,
	// колонку добавили позже). Заполняем недостающие ключи значениями по
	// умолчанию ДО рендера ($effect.pre) — иначе bind:value={undefined} ломает
	// поля с fallback (props_invalid_value).
	$effect.pre(() => {
		if (columns.length === 0) return;
		for (const line of lines) {
			if (!line || !line.data) continue;
			for (const col of columns) {
				if (line.data[col.name] === undefined) {
					line.data[col.name] = defaultFor(col.type);
				}
			}
		}
	});

	function addLine() {
		const data = defaultLineData();
		// Первая строка ТЧ с булевой колонкой «default» помечается как основная
		// (например, контакт по умолчанию у контрагента).
		if (lines.length === 0 && columns.some((c) => c.name === 'default' && c.type === 'boolean')) {
			data.default = true;
		}
		lines.push({
			id: crypto.randomUUID(),
			data,
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

	function handleLinkSelect(line: LocalLine, rec: LocalRecord | null) {
		if (columns.some((c) => c.name === 'price') && rec?.data?.price != null) {
			line.data.price = parseFloat(rec.data.price) || 0;
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

	// Нормализация для поиска: нижний регистр, без диакритики (é→e), ё→е
	function norm(s: string): string {
		return s
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/ё/g, 'е');
	}

	// Умное сравнение значений колонок: числа — числом, universal — по v, пустые — в конец
	function compareValues(a: unknown, b: unknown): number {
		let ava = a;
		let bv = b;
		if (ava && typeof ava === 'object' && 'v' in (ava as object)) ava = (ava as any).v;
		if (bv && typeof bv === 'object' && 'v' in (bv as object)) bv = (bv as any).v;
		if (ava == null || ava === '') return bv == null || bv === '' ? 0 : 1;
		if (bv == null || bv === '') return -1;
		if (typeof ava === 'number' && typeof bv === 'number') return ava - bv;
		return String(ava).localeCompare(String(bv), 'ru', { numeric: true });
	}

	// Вид строк: поиск + сортировка — только отображение, `lines` и sort_order не трогаем
	let viewLines = $derived.by(() => {
		let rows = lines;
		const q = norm(searchTerm.trim());
		if (q) {
			rows = lines.filter((l) =>
				columns.some((c) => norm(String(l.data?.[c.name] ?? '')).includes(q))
			);
		}
		if (sortCol) {
			const key = sortCol;
			const dir = sortDir === 'asc' ? 1 : -1;
			rows = [...rows].sort((a, b) => compareValues(a.data?.[key], b.data?.[key]) * dir);
		}
		return rows;
	});

	// Цикл сортировки колонки: первый клик — ↑, второй — ↓, третий — исходный порядок
	function changeSort(colName: string) {
		if (sortCol !== colName) {
			sortCol = colName;
			sortDir = 'asc';
		} else if (sortDir === 'asc') {
			sortDir = 'desc';
		} else {
			sortCol = null;
			sortDir = 'asc';
		}
	}

	function clearLines() {
		if (lines.length === 0) return;
		if (!confirm('Очистить все строки табличной части?')) return;
		lines.length = 0;
		selectedLineId = null;
		if (onChange) onChange();
	}

	function resetView() {
		searchTerm = '';
		sortCol = null;
		sortDir = 'asc';
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
		<button
			onclick={clearLines}
			class="btn-add btn-remove"
			disabled={lines.length === 0 || readOnly}
			title="Удалить все строки табличной части"
		>
			🧹 Очистить
		</button>
		<button
			onclick={copyLineLink}
			class="btn-add"
			disabled={!selectedLineId}
			title="Скопировать ссылку на выделенную строку"
		>
			🔗 Копировать ссылку строки
		</button>
		<input
			type="search"
			class="tabular-search"
			bind:value={searchTerm}
			placeholder="Поиск по строкам..."
		/>
		{#if searchTerm.trim() || sortCol}
			<button onclick={resetView} class="btn-add" title="Сбросить поиск и сортировку">
				Сброс
			</button>
			<span class="tabular-count">
				Найдено {viewLines.length} / {lines.length}
			</span>
		{/if}
	</div>

	<div class="tabular-scroll">
		<table class="erp-table">
			<thead>
				<tr>
					<th style="width: 40px;">№</th>
					{#each columns as col}
						<th
							class="sortable-th"
							class:sort-active={sortCol === col.name}
							onclick={() => changeSort(col.name)}
							title="Сортировать по «{col.title}»"
						>
							{col.title}
							{#if sortCol === col.name}
								<span class="sort-ind">{sortDir === 'asc' ? '▲' : '▼'}</span>
							{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#if viewLines.length === 0}
					<tr>
						<td colSpan={columns.length + 1} class="empty-text">
							{lines.length === 0 ? 'Табличная часть пуста.' : 'Ничего не найдено.'}
						</td>
					</tr>
				{:else}
					{#each viewLines as line, index (line.id)}
						<tr
							class="tabular-row"
							class:selected={selectedLineId === line.id}
							onclick={() => {
								// Выделение строки работает независимо от readOnly
								// (проведён документ или нет) — редактирование полей
								// ограничивается отдельно через disabled у полей.
								selectedLineId = line.id;
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
											{recordId}
											candidates={col.type === 'linelink' ? linelinkCandidates : undefined}
											options={col.type === 'select'
												? selectOptionsFor(tableName, col.name)
												: undefined}
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
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-bottom: 8px;
	}
	.tabular-search {
		flex: 0 1 220px;
		padding: 5px 8px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		font-size: 0.8rem;
		color: #334155;
		box-sizing: border-box;
	}
	.tabular-count {
		font-size: 0.75rem;
		color: #64748b;
	}
	.sortable-th {
		cursor: pointer;
		user-select: none;
	}
	.sortable-th:hover {
		background-color: #e2e8f0;
	}
	.sortable-th.sort-active {
		background-color: #dbeafe;
		color: #1e40af;
	}
	.sort-ind {
		margin-left: 4px;
		font-size: 0.7rem;
	}
	.tabular-scroll {
		max-height: 50vh;
		overflow-y: auto;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
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
