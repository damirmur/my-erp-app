<script lang="ts">
	import { db, type LocalTable } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { metadata } from '$lib/state/metadata';
	import { syncService } from '$lib/services/sync';
	import { liveQuery } from 'dexie';
	import { tableTypeList, deleteTableTypeFromDB, createTableTypeFromBase } from '$lib/table-types';

	// Порядок встроенных групп в сайдбаре; кастомные типы идут после
	const preferredTypeOrder = ['directory', 'document', 'register', 'constant', 'system'];

	// Заголовки групп встроенных типов (множественное число)
	const groupTitles: Record<string, string> = {
		directory: '📁 Справочники',
		document: '📄 Документы',
		register: '📊 Регистры',
		constant: '🏷️ Константы',
		system: '⚙️ Системные'
	};

	function groupTitle(type: string, label: string): string {
		return groupTitles[type] ?? label;
	}

	// Типы таблиц (встроенные + из БД), в порядке для отображения
	let typeList = $derived.by(() => {
		const types = [...$tableTypeList];
		types.sort((a, b) => {
			const ia = preferredTypeOrder.indexOf(a.type);
			const ib = preferredTypeOrder.indexOf(b.type);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.label.localeCompare(b.label);
		});
		return types;
	});

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

	// Таблицы, сгруппированные по типу
	let tablesByType = $derived.by(() => {
		const map: Record<string, LocalTable[]> = {};
		tables.forEach((table) => {
			(map[table.type] ??= []).push(table);
		});
		return map;
	});

	// Таблица скрыта из основного режима, если в её config выставлен флаг hiddenInMain
	function isVisibleInMain(table: LocalTable): boolean {
		return table.config?.hiddenInMain !== true;
	}

	// Системная таблица «История»: открывается как обычный список (DynamicList),
	// но её записи ведут на исходные объекты (см. DynamicList.openRecord).
	let historyTable = $derived(tables.find((t) => t.name === 'history') ?? null);

	// Те же группы, но без скрытых таблиц (для основного режима)
	let mainModeTablesByType = $derived.by(() => {
		const map: Record<string, LocalTable[]> = {};
		tables.forEach((table) => {
			if (!isVisibleInMain(table)) return;
			(map[table.type] ??= []).push(table);
		});
		return map;
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

	// ---- Типы таблиц: создание и удаление ----
	const translitMap: Record<string, string> = {
		а: 'a',
		б: 'b',
		в: 'v',
		г: 'g',
		д: 'd',
		е: 'e',
		ё: 'e',
		ж: 'zh',
		з: 'z',
		и: 'i',
		й: 'y',
		к: 'k',
		л: 'l',
		м: 'm',
		н: 'n',
		о: 'o',
		п: 'p',
		р: 'r',
		с: 's',
		т: 't',
		у: 'u',
		ф: 'f',
		х: 'h',
		ц: 'ts',
		ч: 'ch',
		ш: 'sh',
		щ: 'sch',
		ъ: '',
		ы: 'y',
		ь: '',
		э: 'e',
		ю: 'yu',
		я: 'ya'
	};

	function translit(text: string): string {
		return text
			.toLowerCase()
			.split('')
			.map((ch) => translitMap[ch] ?? ch)
			.join('')
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_|_$/g, '');
	}

	let creatingType = $state(false);
	let newTypeLabel = $state('');
	let newTypeName = $state('');
	let newTypeBase = $state('directory');

	async function handleCreateType() {
		const label = newTypeLabel.trim();
		if (!label) return;
		const name = newTypeName.trim() || translit(label);
		try {
			await createTableTypeFromBase(newTypeBase, name, label);
		} catch (e: any) {
			alert(`Ошибка создания типа: ${e?.message ?? e}`);
			return;
		}
		creatingType = false;
		newTypeLabel = '';
		newTypeName = '';
		newTypeBase = 'directory';
	}

	function handleTypeKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleCreateType();
		} else if (e.key === 'Escape') {
			creatingType = false;
			newTypeLabel = '';
			newTypeName = '';
		}
	}

	async function handleDeleteType(typeName: string, typeLabel: string) {
		const count = tablesByType[typeName]?.length ?? 0;
		if (count > 0) {
			alert(`Нельзя удалить тип "${typeLabel}": в нём ${count} таблиц(а). Сначала удалите их.`);
			return;
		}
		if (!confirm(`Удалить тип "${typeLabel}" (${typeName})?`)) return;
		try {
			await deleteTableTypeFromDB(typeName);
		} catch (e: any) {
			alert(`Ошибка удаления типа: ${e?.message ?? e}`);
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
				{#if workspace.mode === 'main' && historyTable}
					<div class="history-section">
						<div class="group-header-row">
							<button
								class="history-open-btn"
								class:active={workspace.activeTab?.tableId === historyTable.id &&
									workspace.activeTab?.type === 'list'}
								onclick={() => workspace.openList(historyTable.id, historyTable.title)}
								title="Открыть историю действий"
							>
								🕘 История
							</button>
							<button
								class="group-add-btn"
								onclick={() => workspace.clearHistory()}
								title="Очистить историю"
							>
								✕
							</button>
						</div>
					</div>
				{/if}

				{#if workspace.mode === 'constructor'}
					<div class="types-section">
						<div class="group-header-row">
							<span class="group-title">🗂 Типы таблиц</span>
							<button
								class="group-add-btn"
								class:active={creatingType}
								onclick={() => (creatingType = !creatingType)}
								title="Добавить тип от базового"
							>
								＋
							</button>
						</div>

						{#if creatingType}
							<div class="create-type-form">
								<input
									type="text"
									bind:value={newTypeLabel}
									onkeydown={handleTypeKeydown}
									placeholder="Синоним (например, Отчёт)"
									class="create-table-input"
									use:autofocusInput
								/>
								<input
									type="text"
									bind:value={newTypeName}
									onkeydown={handleTypeKeydown}
									placeholder="Имя (лат.), напр. report"
									class="create-table-input"
								/>
								<select bind:value={newTypeBase} class="create-table-input">
									{#each typeList as t}
										{#if t.type !== 'tabular'}
											<option value={t.type}>{t.label} ({t.type})</option>
										{/if}
									{/each}
								</select>
								<div class="create-type-actions">
									<button onclick={handleCreateType} class="type-btn type-btn-primary"
										>Создать тип</button
									>
									<button
										onclick={() => {
											creatingType = false;
											newTypeLabel = '';
											newTypeName = '';
										}}
										class="type-btn">Отмена</button
									>
								</div>
							</div>
						{/if}

						<ul>
							{#each typeList as t}
								<li class="type-row">
									<span class="type-row-label">{groupTitle(t.type, t.label)}</span>
									<span class="nav-item-code">{t.type}</span>
									<span class="type-count">{tablesByType[t.type]?.length ?? 0}</span>
									<button
										class="row-del-btn"
										onclick={() => handleDeleteType(t.type, t.label)}
										title="Удалить тип">✕</button
									>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#each typeList as typeDef}
					{#if typeDef.type !== 'tabular' && (workspace.mode === 'constructor' || (mainModeTablesByType[typeDef.type]?.length ?? 0) > 0)}
						<div class="nav-group">
							<div class="group-header-row">
								<button class="group-header" onclick={() => toggleGroup(typeDef.type)}>
									<span class="chevron">{isGroupExpanded(typeDef.type) ? '▾' : '▸'}</span>
									<span class="group-title">{groupTitle(typeDef.type, typeDef.label)}</span>
								</button>
								{#if workspace.mode === 'constructor'}
									<button
										class="group-add-btn"
										class:active={creatingGroup === typeDef.type}
										onclick={() =>
											(creatingGroup = creatingGroup === typeDef.type ? null : typeDef.type)}
										title="Добавить таблицу этого типа"
									>
										＋
									</button>
								{/if}
							</div>

							{#if isGroupExpanded(typeDef.type)}
								<ul>
									{#if creatingGroup === typeDef.type}
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
										{#each constructorTables.filter((t) => t.type === typeDef.type) as table}
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
										{#each mainModeTablesByType[typeDef.type] ?? [] as table}
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
	.types-section {
		margin-bottom: 1.25rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid #e5e7eb;
	}
	.create-type-form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 0 0.25rem 0.5rem;
	}
	.create-type-actions {
		display: flex;
		gap: 6px;
	}
	.type-btn {
		flex: 1;
		background: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		font-size: 0.8rem;
		padding: 4px 8px;
		cursor: pointer;
		color: #475569;
	}
	.type-btn:hover {
		background: #f1f5f9;
	}
	.type-btn-primary {
		background: #2563eb;
		border-color: #2563eb;
		color: #ffffff;
	}
	.type-btn-primary:hover {
		background: #1d4ed8;
	}
	.type-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0.25rem;
		font-size: 0.8rem;
	}
	.type-row:hover {
		background-color: #e5e7eb;
		border-radius: 0.25rem;
	}
	.type-row-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #4b5563;
	}
	.type-count {
		font-size: 0.7rem;
		color: #94a3b8;
		flex-shrink: 0;
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
	.sidebar-nav ul.tree-subs {
		margin-left: 9px;
		padding-left: 12px;
		border-left: 1px solid #e2e8f0;
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
	.history-section {
		margin-bottom: 1.25rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid #e5e7eb;
	}
	.history-open-btn {
		flex: 1;
		display: flex;
		align-items: center;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.5rem 0.75rem;
		font-size: 0.9rem;
		color: #4b5563;
		border-radius: 0.375rem;
		transition: background-color 0.2s;
		text-align: left;
	}
	.history-open-btn:hover {
		background-color: #e5e7eb;
		color: #1f2937;
	}
	.history-open-btn.active {
		background-color: #e0e7ff;
		color: #4f46e5;
		font-weight: 500;
	}
</style>
