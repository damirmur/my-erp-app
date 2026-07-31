<script lang="ts">
	import { db, type LocalTable } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { metadata } from '$lib/state/metadata';
	import { syncService } from '$lib/services/sync';
	import { liveQuery } from 'dexie';

	// Карта человекочитаемых названий типов таблиц
	const typeLabels: Record<string, string> = {
		directory: '📁 Справочники',
		document: '📄 Документы',
		register: '📊 Регистры',
		constant: '🏷️ Константы',
		system: '⚙️ Системные'
	};

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

		return () => subscription.unsubscribe();
	});

	// Группированное дерево для основного режима
	let groupedTables = $derived.by(() => {
		const groups: Record<string, LocalTable[]> = {
			directory: [],
			document: [],
			register: [],
			constant: [],
			system: []
		};
		tables.forEach((table) => {
			if (groups[table.type]) {
				groups[table.type].push(table);
			}
		});
		return groups;
	});

	// В режиме конструктора показываем все таблицы верхнего уровня (без табличных частей)
	let constructorTables = $derived(
		tables.filter((t) => !t.parent_table_id).sort((a, b) => a.title.localeCompare(b.title))
	);

	let isConfiguratorTabActive = $derived(workspace.activeTab?.tableId === 'SYSTEM_CONFIUGRATOR_ID');

	// Подтаблицы (ТЧ), сгруппированные по родительской таблице
	let subTablesByParent = $derived.by(() => {
		const map = new Map<string, LocalTable[]>();
		tables.forEach((t) => {
			if (t.parent_table_id) {
				const pid = String(t.parent_table_id);
				const list = map.get(pid) ?? [];
				list.push(t);
				map.set(pid, list);
			}
		});
		return map;
	});

	// Раскрытые строки дерева таблиц (в конструкторе)
	let expandedTables = $state<Record<string, boolean>>({});

	function isTableExpanded(id: string) {
		return expandedTables[id] !== false;
	}

	function toggleTableExpanded(id: string) {
		expandedTables[id] = isTableExpanded(id) ? false : true;
	}

	// Свёрнутые группы (общие для обоих режимов), запоминаем между сессиями
	let expandedGroups = $state<Record<string, boolean>>({});

	$effect(() => {
		try {
			const raw = localStorage.getItem('sidebarExpandedGroups');
			if (raw) expandedGroups = JSON.parse(raw);
		} catch {
			// повреждённые данные игнорируем
		}
	});

	$effect(() => {
		try {
			localStorage.setItem('sidebarExpandedGroups', JSON.stringify(expandedGroups));
		} catch {
			// localStorage недоступен — не критично
		}
	});

	function isGroupExpanded(key: string) {
		return expandedGroups[key] !== false;
	}

	function toggleGroup(key: string) {
		expandedGroups[key] = isGroupExpanded(key) ? false : true;
	}

	// Создание новой таблицы прямо из заголовка группы в конструкторе
	let creatingGroup = $state<string | null>(null);
	let newTableName = $state('');

	async function handleCreateTable() {
		const name = newTableName.trim();
		if (!name || !creatingGroup) return;
		const type = creatingGroup;
		creatingGroup = null;
		newTableName = '';
		const id = await metadata.createNewTable(name, type, name);
		if (id) {
			workspace.openConfigurator(id, name);
			await syncService.runFullSync();
		}
	}

	function handleCreateKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleCreateTable();
		} else if (e.key === 'Escape') {
			creatingGroup = null;
			newTableName = '';
		}
	}

	// Удаление таблицы (каскадно: подтаблицы + реквизиты)
	async function handleDeleteTable(id: string, title: string) {
		const subs = subTablesByParent.get(id) ?? [];
		const msg = subs.length
			? `Удалить таблицу "${title}" вместе с ${subs.length} табличной частью и всеми реквизитами?`
			: `Удалить таблицу "${title}" вместе со всеми реквизитами?`;
		if (!confirm(msg)) return;
		await metadata.deleteTableCascade(id);
		workspace.closeConfiguratorForTable(id);
		await syncService.runFullSync();
	}

	// Удаление табличной части из дерева
	async function handleDeleteSubTable(sub: LocalTable) {
		if (!confirm(`Удалить табличную часть "${sub.title}" вместе с реквизитами?`)) return;
		await metadata.deleteColumnsByTable(sub.id);
		await metadata.deleteTable(sub.id);
		await syncService.runFullSync();
	}

	// Фокус на поле создания таблицы при появлении
	function autofocusInput(node: HTMLInputElement) {
		node.focus();
	}
</script>

{#if !workspace.sidebarCollapsed}
	<aside class="sidebar">
		<div class="sidebar-header">
			<div class="mode-switch">
				<button
					onclick={() => workspace.setMode('main')}
					class="mode-btn"
					class:active={workspace.mode === 'main'}
				>
					Основной режим
				</button>
				<button
					onclick={() => workspace.setMode('constructor')}
					class="mode-btn"
					class:active={workspace.mode === 'constructor'}
				>
					Конструктор
				</button>
			</div>
		</div>

		{#if loading}
			<div class="p-4 text-gray-500 text-sm">Загрузка конфигурации...</div>
		{:else}
			<nav class="sidebar-nav">
				{#each Object.entries(typeLabels) as [typeKey, typeLabel]}
					{#if workspace.mode === 'constructor' || groupedTables[typeKey].length > 0}
						<div class="nav-group">
							<div class="group-header-row">
								<button class="group-header" onclick={() => toggleGroup(typeKey)}>
									<span class="chevron">{isGroupExpanded(typeKey) ? '▾' : '▸'}</span>
									<span class="group-title">{typeLabel}</span>
								</button>
								{#if workspace.mode === 'constructor'}
									<button
										class="group-add-btn"
										class:active={creatingGroup === typeKey}
										onclick={() => (creatingGroup = creatingGroup === typeKey ? null : typeKey)}
										title="Добавить таблицу этого типа"
									>
										＋
									</button>
								{/if}
							</div>

							{#if isGroupExpanded(typeKey)}
								<ul>
									{#if creatingGroup === typeKey}
										<li class="create-row">
											<input
												type="text"
												bind:value={newTableName}
												onkeydown={handleCreateKeydown}
												placeholder="Имя таблицы (лат.), Enter — создать"
												class="create-table-input"
												use:autofocusInput
											/>
										</li>
									{/if}

									{#if workspace.mode === 'constructor'}
										{#each constructorTables.filter((t) => t.type === typeKey) as table}
											{@const subs = subTablesByParent.get(table.id) ?? []}
											<li class="tree-row">
												<div class="tree-row-main">
													<button
														class="tree-toggle"
														class:hidden={subs.length === 0}
														onclick={() => toggleTableExpanded(table.id)}
														title={subs.length ? 'Показать табличные части' : ''}
													>
														<span class="chevron">{isTableExpanded(table.id) ? '▾' : '▸'}</span>
													</button>
													<button
														onclick={() => workspace.openConfigurator(table.id, table.title)}
														class="nav-item"
														class:active={isConfiguratorTabActive &&
															workspace.activeTab?.recordId === table.id}
													>
														<span class="nav-item-title">{table.title}</span>
														<span class="nav-item-code">{table.name ?? table.id.slice(0, 8)}</span>
													</button>
													<button
														class="row-del-btn"
														onclick={() => handleDeleteTable(table.id, table.title)}
														title="Удалить таблицу">✕</button
													>
												</div>
												{#if isTableExpanded(table.id) && subs.length > 0}
													<ul class="tree-subs">
														{#each subs as sub}
															<li class="tree-row tree-sub-row">
																<button
																	onclick={() => workspace.openConfigurator(table.id, table.title)}
																	class="nav-item nav-item-sub"
																>
																	<span class="nav-item-title">{sub.title}</span>
																	<span class="nav-item-code">{sub.name ?? sub.id.slice(0, 8)}</span
																	>
																</button>
																<button
																	class="row-del-btn"
																	onclick={() => handleDeleteSubTable(sub)}
																	title="Удалить табличную часть">✕</button
																>
															</li>
														{/each}
													</ul>
												{/if}
											</li>
										{/each}
									{:else}
										{#each groupedTables[typeKey] as table}
											<li>
												<button
													onclick={() => workspace.openList(table.id, table.title)}
													class="nav-item"
													class:active={workspace.activeTab?.tableId === table.id &&
														workspace.activeTab?.type === 'list'}
												>
													{table.title}
												</button>
											</li>
										{/each}
									{/if}
								</ul>
							{/if}
						</div>
					{/if}
				{/each}
			</nav>
		{/if}
	</aside>
{/if}

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
		padding: 0.75rem;
		border-bottom: 1px solid #e5e7eb;
		background-color: #ffffff;
	}
	.mode-switch {
		display: flex;
		background-color: #e5e7eb;
		border-radius: 0.375rem;
		padding: 2px;
	}
	.mode-btn {
		flex: 1;
		background: none;
		border: none;
		padding: 6px 8px;
		font-size: 0.8rem;
		font-weight: 500;
		color: #6b7280;
		border-radius: 0.25rem;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background-color 0.2s,
			color 0.2s;
	}
	.mode-btn:hover {
		color: #1f2937;
	}
	.mode-btn.active {
		background-color: #ffffff;
		color: #1f2937;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
	}
	.sidebar-nav {
		padding: 1rem 0.5rem;
		overflow-y: auto;
		flex: 1;
	}
	.nav-group {
		margin-bottom: 1.25rem;
	}
	.group-header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		margin-bottom: 0.5rem;
	}
	.group-header {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		text-align: left;
	}
	.chevron {
		font-size: 0.7rem;
		color: #9ca3af;
		width: 14px;
		flex-shrink: 0;
	}
	.group-title {
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		color: #6b7280;
	}
	.group-add-btn {
		background: none;
		border: none;
		color: #9ca3af;
		font-size: 0.9rem;
		padding: 2px 6px;
		border-radius: 0.25rem;
		cursor: pointer;
		transition:
			background-color 0.2s,
			color 0.2s;
	}
	.group-add-btn:hover {
		background-color: #e5e7eb;
		color: #16a34a;
	}
	.group-add-btn.active {
		background-color: #e5e7eb;
		color: #16a34a;
	}
	.sidebar-nav ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.tree-row {
		margin-bottom: 1px;
	}
	.tree-row-main {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.tree-toggle {
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		width: 18px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}
	.tree-toggle.hidden {
		visibility: hidden;
	}
	.tree-subs {
		padding-left: 16px;
	}
	.tree-sub-row {
		display: flex;
		align-items: center;
	}
	.row-del-btn {
		background: none;
		border: none;
		color: #ef4444;
		font-size: 0.75rem;
		padding: 2px 6px;
		border-radius: 0.25rem;
		cursor: pointer;
		flex-shrink: 0;
		visibility: hidden;
		opacity: 0;
		transition:
			opacity 0.15s,
			background-color 0.15s;
	}
	.tree-row:hover .row-del-btn {
		visibility: visible;
		opacity: 1;
	}
	.row-del-btn:hover {
		background-color: #fee2e2;
	}
	.nav-item-sub {
		font-size: 0.85rem;
		padding: 0.35rem 0.6rem;
		color: #6b7280;
	}
	.create-row {
		padding: 0 0.25rem 0.5rem;
	}
	.create-table-input {
		width: 100%;
		box-sizing: border-box;
		padding: 6px 8px;
		border: 1px solid #94a3b8;
		border-radius: 0.25rem;
		font-size: 0.8rem;
		outline: none;
	}
	.create-table-input:focus {
		border-color: #3b82f6;
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
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
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
	.nav-item-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nav-item-code {
		font-size: 0.7rem;
		color: #9ca3af;
		flex-shrink: 0;
		max-width: 90px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
