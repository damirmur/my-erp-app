<script lang="ts">
	import LookupInput from '$lib/components/ui/LookupInput.svelte';
	import { db, type LocalTable } from '$lib/db/indexeddb';

	// Поле «Параметры (список)»: визуальный редактор jsonb-параметров (например,
	// «Параметры» сценария). Как в конструкторе реквизитов: у каждого параметра
	// сначала тип поля. Если «Ссылка» — выбирается таблица, затем список записей
	// этой таблицы (добавление/удаление); иначе — одно значение.
	//
	// Хранимое значение остаётся обычным JSON-объектом { ключ: значение }, а
	// метаданные (тип и таблица) складываются в служебный ключ "__meta"
	// ({ ключ: { type, table } }). Движок сценария и mergeParams его игнорируют,
	// поэтому старое поведение ${kontragents} и пр. не меняется.
	let {
		value = $bindable(null),
		disabled = false,
		onChange = (() => {}) as (e: Event) => void
	} = $props();

	interface Row {
		key: string;
		type: string; // string | number | boolean | date | datetime | link
		table: string; // имя таблицы для link ('' = любая таблица)
		values: string[]; // для link — id записей; для остальных — [значение]
	}

	const META_KEY = '__meta';

	// Типы, как в конструкторе реквизитов (без экзотики, пригодной для параметров)
	const PARAM_TYPES = [
		{ value: 'string', label: 'Строка' },
		{ value: 'number', label: 'Число' },
		{ value: 'boolean', label: 'Логический' },
		{ value: 'date', label: 'Дата' },
		{ value: 'datetime', label: 'Дата и время' },
		{ value: 'link', label: 'Ссылка' }
	];

	let rows = $state<Row[]>([]);
	let lastValueJson = $state('');
	let lastRowsJson = $state('');

	// Таблицы верхнего уровня для выбора цели ссылки
	let tables = $state<LocalTable[]>([]);
	$effect(() => {
		let cancelled = false;
		db.meta_tables
			.filter((t) => !t.parent_table_id)
			.toArray()
			.then((all) => {
				if (!cancelled) tables = all;
			});
		return () => {
			cancelled = true;
		};
	});

	function toObj(raw: unknown): Record<string, any> {
		if (!raw) return {};
		if (typeof raw === 'string') {
			try {
				return JSON.parse(raw);
			} catch {
				return {};
			}
		}
		if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
		return {};
	}

	function inferType(v: unknown): string {
		if (Array.isArray(v)) return 'link';
		if (typeof v === 'number') return 'number';
		if (typeof v === 'boolean') return 'boolean';
		return 'string';
	}

	function parseToRows(obj: Record<string, any>): Row[] {
		const meta =
			obj[META_KEY] && typeof obj[META_KEY] === 'object' && !Array.isArray(obj[META_KEY])
				? (obj[META_KEY] as Record<string, any>)
				: {};
		return Object.entries(obj)
			.filter(([k]) => k !== META_KEY)
			.map(([k, v]) => {
				const m = meta[k] ?? {};
				let type = typeof m.type === 'string' ? m.type : inferType(v);
				const table = typeof m.table === 'string' ? m.table : '';
				if (Array.isArray(v)) {
					if (type !== 'link') type = 'link';
					return { key: k, type, table, values: v.map(String) };
				}
				if (type === 'link') {
					return { key: k, type, table, values: [String(v ?? '')] };
				}
				if (!PARAM_TYPES.some((p) => p.value === type)) type = 'string';
				return { key: k, type, table: '', values: [v == null ? '' : String(v)] };
			});
	}

	function rowsToObj(): Record<string, any> {
		const obj: Record<string, any> = {};
		const meta: Record<string, any> = {};
		for (const r of rows) {
			const key = r.key.trim();
			if (!key) continue;
			if (r.type === 'link') {
				const vals = r.values.map((v) => v.trim()).filter(Boolean);
				if (vals.length === 0) continue;
				obj[key] = vals.length > 1 ? vals : vals[0];
			} else {
				const raw = (r.values[0] ?? '').trim();
				if (raw === '') continue;
				if (r.type === 'number') {
					const n = parseFloat(raw);
					obj[key] = isNaN(n) ? raw : n;
				} else if (r.type === 'boolean') {
					obj[key] = raw === 'true';
				} else {
					obj[key] = raw;
				}
			}
			meta[key] = { type: r.type, table: r.type === 'link' ? r.table : '' };
		}
		if (Object.keys(meta).length > 0) obj[META_KEY] = meta;
		return obj;
	}

	// Внешнее значение → строки. Пишем lastRowsJson = текущее состояние строк,
	// чтобы effect записи внизу не «отдавал» значение обратно сразу после загрузки
	// (нет лишнего onChange). Эффект НЕ читает rows, иначе зацикливался бы: каждый
	// раз после записи rows перечитывал бы их и менял lastValueJson.
	$effect(() => {
		const vJson = JSON.stringify(toObj(value));
		if (vJson === lastValueJson) return;
		rows = parseToRows(toObj(value));
		lastValueJson = vJson;
		lastRowsJson = JSON.stringify(rowsToObj());
	});

	// Изменение строк (ввод, выбор в LookupInput, кнопки) → запись в value.
	// Читает только rows и lastRowsJson — пишет value и lastRowsJson, поэтому
	// между эффектами нет цикла: запись value обновляет lastValueJson только
	// если значение реально изменилось.
	$effect(() => {
		const json = JSON.stringify(rowsToObj());
		if (json === lastRowsJson) return;
		lastRowsJson = json;
		value = rowsToObj();
		onChange(new Event('input'));
	});

	function addRow() {
		rows.push({ key: '', type: 'string', table: '', values: [''] });
	}

	function removeRow(i: number) {
		rows.splice(i, 1);
	}

	function changeType(i: number, type: string) {
		rows[i].type = type;
		if (type !== 'link') {
			rows[i].table = '';
			// сохраняем первое значение, остальное отбрасываем
			rows[i].values = rows[i].values.length > 0 ? [rows[i].values[0]] : [''];
		} else if (rows[i].values.length === 0) {
			rows[i].values = [''];
		}
	}

	function addValue(i: number) {
		rows[i].values.push('');
	}

	function removeValue(i: number, j: number) {
		rows[i].values.splice(j, 1);
	}

	// При выборе записи в универсальном поиске (таблица не задана) запоминаем
	// таблицу выбранной записи: поле-ссылка дальше ищет только в ней, а значение
	// сохраняется вместе с метаданными (__meta.table).
	function onPickValue(i: number, record: { table_id: string } | null) {
		if (!record?.table_id) return;
		const t = tables.find((x) => x.id === record.table_id);
		if (t && t.name) rows[i].table = t.name;
	}
</script>

<div class="params-list">
	{#if rows.length === 0}
		<div class="params-empty">Параметры не заданы</div>
	{/if}

	{#each rows as row, i (row)}
		<div class="param-row">
			<div class="param-key-row">
				<label class="param-label" for={`param-key-${i}`}>Имя параметра:</label>
				<input
					type="text"
					id={`param-key-${i}`}
					bind:value={row.key}
					{disabled}
					placeholder="ключ (например, kontragents)"
					class="param-key-input"
				/>
				<button
					type="button"
					class="param-remove"
					title="Удалить параметр"
					{disabled}
					onclick={() => removeRow(i)}
				>
					✕
				</button>
			</div>
			<div class="param-type-row">
				<label class="param-label" for={`param-type-${i}`}>Тип параметра:</label>
				<select
					class="param-type"
					id={`param-type-${i}`}
					value={row.type}
					{disabled}
					title="Тип параметра"
					onchange={(e) => changeType(i, e.currentTarget.value)}
				>
					{#each PARAM_TYPES as t}
						<option value={t.value}>{t.label}</option>
					{/each}
				</select>
			</div>

			{#if row.type === 'link'}
				<div class="param-table-row">
					<select
						class="param-table"
						value={row.table}
						{disabled}
						title="Таблица для выбора записей"
						onchange={(e) => (row.table = e.currentTarget.value)}
					>
						<option value="">-- любая таблица --</option>
						{#each tables as t}
							<option value={t.name ?? t.id}>{t.title}</option>
						{/each}
					</select>
				</div>
				<div class="param-values">
					{#each row.values as _, j}
						<div class="param-value-row">
							<LookupInput
								bind:value={row.values[j]}
								targetTableId={row.table
									? (tables.find((t) => t.name === row.table)?.id ?? '')
									: ''}
								onSelect={(rec) => onPickValue(i, rec)}
								{disabled}
							/>
							<button
								type="button"
								class="param-remove"
								title="Убрать значение"
								{disabled}
								onclick={() => removeValue(i, j)}
							>
								✕
							</button>
						</div>
					{/each}
					<button type="button" class="param-add" {disabled} onclick={() => addValue(i)}>
						＋ добавить значение
					</button>
				</div>
			{:else}
				<div class="param-scalar">
					{#if row.type === 'number'}
						<input
							type="number"
							bind:value={row.values[0]}
							{disabled}
							placeholder="значение"
							class="param-scalar-input"
						/>
					{:else if row.type === 'boolean'}
						<label class="param-bool">
							<input
								type="checkbox"
								checked={row.values[0] === 'true'}
								{disabled}
								onchange={(e) => (row.values[0] = e.currentTarget.checked ? 'true' : 'false')}
							/>
							значение
						</label>
					{:else if row.type === 'date'}
						<input type="date" bind:value={row.values[0]} {disabled} class="param-scalar-input" />
					{:else if row.type === 'datetime'}
						<input
							type="datetime-local"
							bind:value={row.values[0]}
							{disabled}
							class="param-scalar-input"
						/>
					{:else}
						<input
							type="text"
							bind:value={row.values[0]}
							{disabled}
							placeholder="значение"
							class="param-scalar-input"
						/>
					{/if}
				</div>
			{/if}
		</div>
	{/each}

	<button type="button" class="param-add" {disabled} onclick={addRow}>＋ параметр</button>
</div>

<style>
	.params-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.params-empty {
		font-size: 0.8rem;
		color: #94a3b8;
		padding: 4px 0;
	}
	.param-row {
		border: 1px solid #e2e8f0;
		border-radius: 6px;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.param-key-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.param-label {
		flex-shrink: 0;
		font-size: 0.8rem;
		color: #64748b;
	}
	.param-type-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.param-key-input {
		flex: 1;
		min-width: 12rem;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		padding: 6px 8px;
		font-size: 0.85rem;
		outline: none;
	}
	.param-key-input:focus {
		border-color: #3b82f6;
	}
	.param-type,
	.param-table {
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		padding: 6px 8px;
		font-size: 0.8rem;
		background: #f8fafc;
		color: #334155;
		outline: none;
	}
	.param-table-row {
		display: flex;
	}
	.param-values {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.param-value-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.param-scalar {
		display: flex;
	}
	.param-scalar-input {
		flex: 1;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		padding: 6px 8px;
		font-size: 0.85rem;
		outline: none;
	}
	.param-scalar-input:focus {
		border-color: #3b82f6;
	}
	.param-bool {
		display: flex;
		gap: 6px;
		align-items: center;
		font-size: 0.85rem;
		color: #475569;
	}
	.param-remove {
		background: none;
		border: none;
		cursor: pointer;
		color: #94a3b8;
		font-size: 0.8rem;
		padding: 4px;
		border-radius: 4px;
		flex-shrink: 0;
	}
	.param-remove:hover {
		color: #dc2626;
		background: #f1f5f9;
	}
	.param-add {
		align-self: flex-start;
		background: #f1f5f9;
		border: 1px dashed #cbd5e1;
		border-radius: 4px;
		padding: 4px 10px;
		font-size: 0.8rem;
		cursor: pointer;
		color: #475569;
	}
	.param-add:hover {
		background: #e2e8f0;
	}
</style>
