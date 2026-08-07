<script lang="ts">
	import { db, type LocalRecord } from '$lib/db/indexeddb';
	import { liveQuery } from 'dexie';

	// ИСПРАВЛЕНО: Объявляем пропсы через классическую деструктуризацию Svelte 5 с использованием макроса $bindable()
	let {
		value = $bindable(''), // Теперь это поле официально разрешено для bind:value!
		targetTableId = '',
		onSelect = null,
		disabled = false,
		// Дополнительный фильтр кандидатов (например, для поля «Группа» — только
		// папки без самого себя и потомков). Применяется после поиска по имени.
		filter = null
	} = $props<{
		value: string;
		targetTableId: string;
		onSelect?: ((record: LocalRecord) => void) | null;
		disabled?: boolean;
		filter?: ((record: LocalRecord) => boolean) | null;
	}>();

	let searchQuery = $state('');
	let isOpen = $state(false);
	let suggestions = $state<LocalRecord[]>([]);
	// Заголовки таблиц для универсального поиска (когда targetTableId не задан)
	let tableTitles = $state<Record<string, string>>({});
	let dropdownRef = $state<HTMLDivElement | null>(null);

	// Значение поля — id выбранной записи (как в 1С: «Ссылка» = id).
	// displayName — наименование этой записи для отображения в закрытом состоянии.
	let displayName = $state('');

	$effect(() => {
		if (isOpen || !value) {
			if (!isOpen) displayName = '';
			return;
		}
		let cancelled = false;
		db.data_records
			.get(value)
			.then((r) => {
				if (cancelled) return;
				// Если записи нет (старые данные хранили имя, а не id) — показываем сырое значение
				displayName = r?.data?.name ?? String(value);
			})
			.catch(() => {
				if (!cancelled) displayName = String(value);
			});
		return () => {
			cancelled = true;
		};
	});

	// Подписка на живой поиск в IndexedDB
	$effect(() => {
		if (!isOpen) return;

		const observable = liveQuery(async () => {
			// targetTableId задан — ищем в конкретном справочнике;
			// пуст — универсальный поиск по всем таблицам верхнего уровня
			// (нужно для «Универсального» поля со ссылкой на любую таблицу).
			let records: LocalRecord[];
			let titles: Record<string, string> = {};
			if (targetTableId) {
				records = await db.data_records.where('table_id').equals(targetTableId).toArray();
			} else {
				const tables = await db.meta_tables.filter((t) => !t.parent_table_id).toArray();
				titles = Object.fromEntries(tables.map((t) => [t.id, t.title]));
				const topIds = new Set(tables.map((t) => t.id));
				const all = await db.data_records.toArray();
				records = all.filter((r) => topIds.has(r.table_id));
			}

			const q = searchQuery.toLowerCase();
			return {
				records: records.filter(
					(r) => (!filter || filter(r)) && (r.data.name || '').toLowerCase().includes(q)
				),
				titles
			};
		});

		const sub = observable.subscribe({
			next: (data) => {
				suggestions = data.records;
				tableTitles = data.titles;
			},
			error: (err) => console.error('Ошибка поиска в справочнике:', err)
		});

		return () => sub.unsubscribe();
	});

	function handleSelect(record: LocalRecord) {
		value = record.id; // Прямая мутация переменной, разрешенной для $bindable
		displayName = record.data?.name ?? '';
		isOpen = false;
		searchQuery = '';

		if (onSelect) {
			onSelect(record);
		}
	}

	function handleOutsideClick(event: MouseEvent) {
		if (dropdownRef && !dropdownRef.contains(event.target as Node)) {
			isOpen = false;
		}
	}

	$effect(() => {
		window.addEventListener('click', handleOutsideClick);
		return () => window.removeEventListener('click', handleOutsideClick);
	});
</script>

<div class="lookup-wrapper" bind:this={dropdownRef}>
	<!-- Используем наши вычисляемые реактивные переменные -->
	<input
		type="text"
		value={isOpen ? searchQuery : displayName}
		oninput={(e) => {
			const target = e.target as HTMLInputElement;
			if (isOpen) {
				searchQuery = target.value;
			} else {
				value = target.value; // ИСПРАВЛЕНО: пишем напрямую в value
			}
		}}
		placeholder={isOpen ? 'Поиск...' : 'Нажмите для выбора...'}
		onfocus={() => {
			if (!disabled) {
				isOpen = true;
			}
		}}
		{disabled}
		class="lookup-input"
		class:active-focus={isOpen}
		class:has-clear={!!displayName && !disabled}
	/>

	{#if displayName && !disabled}
		<button
			type="button"
			class="lookup-clear"
			title="Очистить"
			aria-label="Очистить"
			onclick={(e) => {
				e.stopPropagation();
				value = '';
				displayName = '';
				isOpen = false;
				searchQuery = '';
			}}
		>
			✕
		</button>
	{/if}

	{#if isOpen && !disabled}
		<div class="lookup-dropdown">
			{#if suggestions.length === 0}
				<div class="dropdown-empty">Элемент не найден</div>
			{:else}
				{#each suggestions as record (record.id)}
					<button type="button" onclick={() => handleSelect(record)} class="dropdown-item">
						<span class="item-title">{record.data.name}</span>
						{#if record.data.sku}
							<span class="item-meta">Арт: {record.data.sku}</span>
						{:else if !targetTableId && tableTitles[record.table_id]}
							<span class="item-meta">{tableTitles[record.table_id]}</span>
						{/if}
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.lookup-wrapper {
		position: relative;
		width: 100%;
	}
	.lookup-input {
		width: 100%;
		border: 1px solid #cbd5e1;
		outline: none;
		background: #ffffff;
		padding: 6px 8px;
		font-size: 0.85rem;
		cursor: pointer;
		box-sizing: border-box;
		border-radius: 4px;
	}
	.lookup-input:disabled {
		cursor: not-allowed;
		color: #475569;
		background-color: #f8fafc;
	}
	.lookup-input.has-clear {
		padding-right: 26px;
	}
	.lookup-clear {
		position: absolute;
		right: 4px;
		top: 50%;
		transform: translateY(-50%);
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.75rem;
		line-height: 1;
		color: #94a3b8;
		padding: 4px;
		border-radius: 4px;
	}
	.lookup-clear:hover {
		color: #dc2626;
		background: #f1f5f9;
	}
	.active-focus {
		background: #fef08a !important;
		color: #000;
		font-weight: 500;
		border-color: #eab308;
	}

	.lookup-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		width: 100%;
		background: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
		z-index: 9999;
		max-height: 200px;
		overflow-y: auto;
		margin-top: 2px;
	}
	.dropdown-empty {
		padding: 8px;
		font-size: 0.8rem;
		color: #94a3b8;
		text-align: center;
	}
	.dropdown-item {
		width: 100%;
		background: none;
		border: none;
		padding: 6px 8px;
		text-align: left;
		font-size: 0.85rem;
		cursor: pointer;
		display: flex;
		justify-content: space-between;
		align-items: center;
		color: #334155;
	}
	.dropdown-item:hover {
		background-color: #f1f5f9;
		color: #1e40af;
	}
	.item-title {
		font-weight: 500;
	}
	.item-meta {
		font-size: 0.75rem;
		color: #64748b;
		background: #f1f5f9;
		padding: 2px 6px;
		border-radius: 4px;
	}
</style>
