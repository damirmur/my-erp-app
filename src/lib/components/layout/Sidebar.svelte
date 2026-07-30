<script lang="ts">
	import { db, type LocalTable } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { liveQuery } from 'dexie';

	// Карта человекочитаемых названий типов таблиц
	const typeLabels: Record<string, string> = {
		directory: '📁 Справочники',
		document: '📄 Документы',
		register: '📊 Регистры',
		system: '⚙️ Системные'
	};

	// Используем liveQuery для создания реактивного стрима данных из IndexedDB.
	// Оборачиваем его в руну $fromObservable (Svelte 5) для автоматической подписки.
	// Если у вас чистый Svelte без SvelteKit плагинов реактивных observables, 
	// воспользуемся стандартным рунным подходом ниже:
	
	let tables = $state<LocalTable[]>([]);
	let loading = $state(true);

	// Подписываемся на изменения таблицы через живой запрос Dexie
	$effect(() => {
		const observable = liveQuery(() => db.meta_tables.orderBy('name').toArray());
		
		const subscription = observable.subscribe({
			next: (data) => {
				tables = data;
				loading = false;
			},
			error: (err) => console.error('Ошибка живого запроса меню:', err)
		});

		return () => subscription.unsubscribe(); // Автоматически отписываемся при уничтожении компонента
	});

	// Группированное дерево (остается без изменений, Svelte 5 пересчитает его автоматически)
	let groupedTables = $derived.by(() => {
		const groups: Record<string, LocalTable[]> = { directory: [], document: [], register: [], system: [] };
		tables.forEach(table => {
			if (groups[table.type]) {
				groups[table.type].push(table);
			}
		});
		return groups;
	});
</script>


<aside class="sidebar">
	<div class="sidebar-header">
		<h2>Панель разделов</h2>
	</div>

	{#if loading}
		<div class="p-4 text-gray-500 text-sm">Загрузка конфигурации...</div>
	{:else}
		<nav class="sidebar-nav">
			{#each Object.entries(typeLabels) as [typeKey, typeLabel]}
				{#if groupedTables[typeKey] && groupedTables[typeKey].length > 0}
					<div class="nav-group">
						<span class="group-title">{typeLabel}</span>
						<ul>
							{#each groupedTables[typeKey] as table}
								<li>
									<button 
										onclick={() => workspace.openList(table.id, table.title)}
										class="nav-item"
										class:active={workspace.activeTab?.tableId === table.id && workspace.activeTab?.type === 'list'}
									>
										{table.title}
									</button>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			{/each}
		</nav>
	{/if}
		<div style="padding: 1rem; border-top: 1px solid #e5e7eb; background: #ffffff;">
		<button 
			onclick={() => workspace.openForm('SYSTEM_CONFIUGRATOR_ID', 'config', '⚙️ Конфигуратор', 'Конфигурация')} 
			style="width: 100%; background: #475569; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 0.85rem;"
		>
			⚙️ Открыть Конструктор
		</button>
	</div>
</aside>

<style>
	.sidebar {
		width: 260px;
		background-color: #f3f4f6;
		border-right: 1px solid #e5e7eb;
		display: flex;
		flex-direction: column;
		height: 100vh;
	}
	.sidebar-header {
		padding: 1rem;
		border-bottom: 1px solid #e5e7eb;
		background-color: #ffffff;
	}
	.sidebar-header h2 {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0;
		color: #1f2937;
	}
	.sidebar-nav {
		padding: 1rem 0.5rem;
		overflow-y: auto;
		flex: 1;
	}
	.nav-group {
		margin-bottom: 1.5rem;
	}
	.group-title {
		display: block;
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		color: #6b7280;
		padding: 0 0.5rem;
		margin-bottom: 0.5rem;
	}
	.sidebar-nav ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.nav-item {
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 0.5rem 0.75rem;
		font-size: 0.9rem;
		color: #4b5563;
		border-radius: 0.375rem;
		cursor: pointer;
		transition: background-color 0.2s;
	}
	.nav-item:hover {
		background-color: #e5e7eb;
		color: #1f2937;
	}
	.nav-item.active {
		background-color: #e0e7ff;
		color: #4f46e5;
		font-weight: 500;
	}
</style>
