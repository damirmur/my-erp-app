<script lang="ts">
	import { db, type LocalLine } from '$lib/db/indexeddb';
	import { liveQuery } from 'dexie';

	// Поле «Ссылка на строку ТЧ»: выпадающий список строк указанной табличной
	// части (relatedTableId) текущей записи (recordId). Значение — id строки.
	let {
		value = $bindable(''),
		disabled = false,
		onChange = (_line: LocalLine | null) => {},
		relatedTableId = '',
		recordId = '',
		candidates = null as LocalLine[] | null
	} = $props();

	let searchQuery = $state('');
	let isOpen = $state(false);
	let suggestions = $state<LocalLine[]>([]);
	let displayName = $state('');
	let dropdownRef = $state<HTMLDivElement | null>(null);

	// Отображение строки: предпочтительно name/number, иначе первое непустое значение
	function lineTitle(line: LocalLine | null): string {
		if (!line) return '';
		const d = line.data ?? {};
		if (d.name != null && String(d.name) !== '') return String(d.name);
		if (d.number != null && String(d.number) !== '') return String(d.number);
		for (const v of Object.values(d)) {
			if (v != null && String(v) !== '') return String(v);
		}
		return '…';
	}

	$effect(() => {
		if (isOpen || !value) {
			if (!isOpen) displayName = '';
			return;
		}
		let cancelled = false;
		db.data_lines
			.get(value)
			.then((line) => {
				if (cancelled) return;
				displayName = line ? lineTitle(line) : String(value);
			})
			.catch(() => {
				if (!cancelled) displayName = String(value);
			});
		return () => {
			cancelled = true;
		};
	});

	// Живой поиск строк ТЧ. Когда переданы candidates (несохранённые строки
	// ТЧ из памяти формы), показываем их; иначе — строки из IndexedDB текущей
	// записи (для сохранённых записей).
	$effect(() => {
		if (!isOpen) return;
		if (candidates != null) {
			const q = searchQuery.toLowerCase();
			suggestions = candidates.filter((l) => lineTitle(l).toLowerCase().includes(q));
			return;
		}
		if (!relatedTableId || !recordId) return;

		const observable = liveQuery(async () => {
			const all = await db.data_lines
				.where('table_id')
				.equals(relatedTableId)
				.filter((l) => l.record_id === recordId)
				.toArray();
			const q = searchQuery.toLowerCase();
			return all.filter((l) => lineTitle(l).toLowerCase().includes(q));
		});

		const sub = observable.subscribe({
			next: (lines) => {
				suggestions = lines;
			},
			error: (err) => console.error('Ошибка поиска строк ТЧ:', err)
		});

		return () => sub.unsubscribe();
	});

	function handleSelect(line: LocalLine) {
		value = line.id;
		displayName = lineTitle(line);
		isOpen = false;
		searchQuery = '';
		onChange(line);
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
	<input
		type="text"
		value={isOpen ? searchQuery : displayName}
		oninput={(e) => {
			const target = e.target as HTMLInputElement;
			if (isOpen) {
				searchQuery = target.value;
			} else {
				value = target.value;
			}
		}}
		placeholder={isOpen ? 'Поиск...' : 'Нажмите для выбора...'}
		onfocus={() => {
			if (!disabled) isOpen = true;
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
				onChange(null);
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
				{#each suggestions as line (line.id)}
					<button type="button" onclick={() => handleSelect(line)} class="dropdown-item">
						<span class="item-title">{lineTitle(line)}</span>
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
</style>
