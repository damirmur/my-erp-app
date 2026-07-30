<script lang="ts">
	import { db, type LocalRecord } from '$lib/db/indexeddb';
	import { liveQuery } from 'dexie';

	// ИСПРАВЛЕНО: Объявляем пропсы через классическую деструктуризацию Svelte 5 с использованием макроса $bindable()
	let {
		value = $bindable(''),       // Теперь это поле официально разрешено для bind:value!
		targetTableId = '',
		onSelect = null,
		disabled = false
	} = $props<{
		value: string;
		targetTableId: string;
		onSelect?: ((data: Record<string, unknown>) => void) | null;
		disabled?: boolean;
	}>();

	let searchQuery = $state('');
	let isOpen = $state(false);
	let suggestions = $state<LocalRecord[]>([]);
	let dropdownRef = $state<HTMLDivElement | null>(null);

	// displayValue теперь просто читает деструктурированное значение value
	let displayValue = $derived(value ?? '');

	// Подписка на живой поиск в IndexedDB
	$effect(() => {
		if (!isOpen || !targetTableId) return;

		const observable = liveQuery(async () => {
			// Ищем напрямую по переданному targetTableId
			const records = await db.data_records.where('table_id').equals(targetTableId).toArray();
			
			return records.filter(r => {
				const name = (r.data.name || '').toLowerCase();
				return name.includes(searchQuery.toLowerCase());
			});
		});

		const sub = observable.subscribe({
			next: data => { suggestions = data; },
			error: err => console.error('Ошибка поиска в справочнике:', err)
		});

		return () => sub.unsubscribe();
	});

	function handleSelect(record: LocalRecord) {
		value = record.data.name; // Прямая мутация переменной, разрешенной для $bindable
		isOpen = false;
		searchQuery = '';
		
		if (onSelect) {
			onSelect(record.data);
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
		value={isOpen ? searchQuery : displayValue} 
		oninput={(e) => {
			const target = e.target as HTMLInputElement;
			if (isOpen) {
				searchQuery = target.value;
			} else {
				value = target.value; // ИСПРАВЛЕНО: пишем напрямую в value
			}
		}}
		placeholder={isOpen ? "Поиск..." : "Нажмите для выбора..."}
		onfocus={() => { if (!disabled) { isOpen = true; searchQuery = displayValue; } }}
		{disabled}
		class="lookup-input"
		class:active-focus={isOpen}
	/>

	
	{#if isOpen && !disabled}
		<div class="lookup-dropdown">
			{#if suggestions.length === 0}
				<div class="dropdown-empty">Элемент не найден</div>
			{:else}
				{#each suggestions as record (record.id)}
					<button 
						type="button"
						onclick={() => handleSelect(record)} 
						class="dropdown-item"
					>
						<span class="item-title">{record.data.name}</span>
						{#if record.data.sku}
							<span class="item-meta">Арт: {record.data.sku}</span>
						{/if}
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.lookup-wrapper { position: relative; width: 100%; }
	.lookup-input {
		width: 100%; border: 1px solid #cbd5e1; outline: none; background: #ffffff;
		padding: 6px 8px; font-size: 0.85rem; cursor: pointer; box-sizing: border-box;
		border-radius: 4px;
	}
	.lookup-input:disabled { cursor: not-allowed; color: #475569; background-color: #f8fafc; }
	.active-focus { background: #fef08a !important; color: #000; font-weight: 500; border-color: #eab308; }
	
	.lookup-dropdown {
		position: absolute; top: 100%; left: 0; width: 100%;
		background: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px;
		box-shadow: 0 4px 10px rgba(0,0,0,0.15); z-index: 9999;
		max-height: 200px; overflow-y: auto; margin-top: 2px;
	}
	.dropdown-empty { padding: 8px; font-size: 0.8rem; color: #94a3b8; text-align: center; }
	.dropdown-item {
		width: 100%; background: none; border: none; padding: 6px 8px;
		text-align: left; font-size: 0.85rem; cursor: pointer; display: flex;
		justify-content: space-between; align-items: center; color: #334155;
	}
	.dropdown-item:hover { background-color: #f1f5f9; color: #1e40af; }
	.item-title { font-weight: 500; }
	.item-meta { font-size: 0.75rem; color: #64748b; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
</style>
