<script lang="ts">
	import LookupInput from '$lib/components/ui/LookupInput.svelte';
	import { db, type LocalRecord, type LocalTable } from '$lib/db/indexeddb';
	import { fieldRegistry, fieldTypeList } from './index';
	import { defaultBirth } from './birth';

	// Хранимое значение — объект { t: тип, v: значение, tbl?: таблица для «Ссылки» }:
	// в разных записях одной таблицы тип поля может быть своим (строка, датавремя,
	// ссылка и т.д.). Для «Ссылка» значение — id связанной записи, а tbl — имя
	// таблицы, из которой она выбрана ('' = универсальный поиск по всем таблицам).
	interface UniversalValue {
		t: string;
		v: any;
		tbl?: string;
	}

	let {
		value = $bindable<UniversalValue | null>(null),
		disabled = false,
		onChange = (_e: Event) => {},
		relatedTableId = ''
	} = $props();

	// Кандидаты: все зарегистрированные типы с редактором, кроме самого «Универсального»
	let candidates = $derived(fieldTypeList.filter((f) => f.FormField && f.type !== 'universal'));

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

	// Нормализуем значение: при отсутствии/устаревшей структуре подставляем строку
	// (для пустой строки сохраняем её как значение строки).
	$effect(() => {
		const v = value;
		if (v == null || typeof v !== 'object' || typeof v.t !== 'string') {
			if (typeof v === 'string') {
				value = { t: 'string', v };
			} else {
				value = { t: 'string', v: '' };
			}
		}
	});

	function defaultFor(t: string): any {
		if (t === 'boolean') return false;
		if (t === 'birth') return defaultBirth();
		return '';
	}

	function changeType(t: string) {
		if (t === 'link') {
			// Для ссылки сразу запоминаем сконфигурированную таблицу колонки (если есть)
			const tbl = relatedTableId ? (tables.find((x) => x.id === relatedTableId)?.name ?? '') : '';
			value = { t, v: '', tbl };
		} else {
			value = { t, v: defaultFor(t) };
		}
		onChange(new Event('change'));
	}

	let currentType = $derived(value?.t ?? 'string');
	let currentFC = $derived(fieldRegistry[currentType]?.FormField);

	// Режим «правки типа»: свернутое состояние показывает только поле значения.
	let editMode = $state(false);

	// Значение считается выбранным, если оно непустое (для ссылки — выбран id записи).
	let isSet = $derived(
		!!value && value.v !== null && value.v !== undefined && String(value.v).trim() !== ''
	);

	// Целевая таблица LookupInput: имя из value.tbl → id; если таблица не выбрана —
	// используем сконфигурированную related_table_id колонки (обратная совместимость).
	let targetTableId = $derived(
		value?.tbl ? (tables.find((t) => t.name === value.tbl)?.id ?? '') : relatedTableId
	);

	// При выборе записи в универсальном поиске (таблица не задана) запоминаем
	// таблицу выбранной записи: поле-ссылка дальше ищет только в ней.
	function onPickLink(record: LocalRecord) {
		const t = tables.find((x) => x.id === record.table_id);
		if (t?.name) value = { ...value, t: 'link', v: record.id, tbl: t.name };
	}
</script>

<div class="universal-field">
	{#if !disabled && (editMode || !isSet)}
		{#if currentType === 'link'}
			<div class="universal-link-selects">
				<select
					class="universal-type"
					value={currentType}
					onchange={(e) => changeType(e.currentTarget.value)}
					title="Тип значения этой записи"
				>
					{#each candidates as c}
						<option value={c.type}>{c.label}</option>
					{/each}
				</select>
				<select
					class="universal-table"
					value={value?.tbl ?? ''}
					onchange={(e) => {
						value = { ...value, t: 'link', v: '', tbl: e.currentTarget.value };
						onChange(new Event('change'));
					}}
					title="Таблица для выбора записей"
				>
					<option value="">-- любая таблица --</option>
					{#each tables as t}
						<option value={t.name ?? t.id}>{t.title}</option>
					{/each}
				</select>
			</div>
		{:else}
			<select
				class="universal-type"
				value={currentType}
				onchange={(e) => changeType(e.currentTarget.value)}
				title="Тип значения этой записи"
			>
				{#each candidates as c}
					<option value={c.type}>{c.label}</option>
				{/each}
			</select>
		{/if}
	{/if}

	<div class="universal-value-row">
		{#if value && currentType === 'link'}
			<LookupInput
				bind:value={value.v}
				{targetTableId}
				{disabled}
				onSelect={(record) => onPickLink(record)}
			/>
		{:else if value && currentFC}
			{@const SubField = currentFC}
			<SubField bind:value={value.v} {disabled} {onChange} {relatedTableId} />
		{/if}

		{#if !disabled && isSet && !editMode}
			<button
				type="button"
				class="universal-edit"
				title="Изменить тип"
				onclick={() => (editMode = true)}
			>
				⚙
			</button>
		{:else if !disabled && editMode && isSet}
			<button
				type="button"
				class="universal-edit"
				title="Готово"
				onclick={() => (editMode = false)}
			>
				✓
			</button>
		{/if}
	</div>
</div>

<style>
	.universal-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.universal-type {
		width: fit-content;
		font-size: 0.75rem;
		padding: 2px 6px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		background: #f8fafc;
		color: #334155;
		outline: none;
	}
	.universal-link-selects {
		display: flex;
		gap: 4px;
	}
	.universal-table {
		flex: 1;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		padding: 6px 8px;
		font-size: 0.8rem;
		background: #f8fafc;
		color: #334155;
		outline: none;
	}
	.universal-value-row {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.universal-value-row > :first-child {
		flex: 1;
		min-width: 0;
	}
	.universal-edit {
		flex-shrink: 0;
		background: #f1f5f9;
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		cursor: pointer;
		color: #64748b;
		font-size: 0.8rem;
		line-height: 1;
		padding: 4px 7px;
	}
	.universal-edit:hover {
		color: #1e40af;
		background: #e2e8f0;
	}
</style>
