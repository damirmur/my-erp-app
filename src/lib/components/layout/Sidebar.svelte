<script lang="ts">
	import { db, type LocalTable } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { metadata } from '$lib/state/metadata';
	import { syncService } from '$lib/services/sync';
	import { liveQuery } from 'dexie';
	import { tableTypeList, deleteTableTypeFromDB, createTableTypeFromBase } from '$lib/table-types';
	import {
		APP_SETTINGS_TABLE,
		NAV_ORDER_KEY,
		clearNavOrder as resetPersistedNavOrder,
		saveNavOrder as persistNavOrder
	} from '$lib/state/settings';

	// Порядок встроенных групп в сайдбаре; кастомные типы идут после
	const preferredTypeOrder = ['directory', 'document', 'register', 'constant', 'flow', 'system'];

	// Заголовки групп встроенных типов (множественное число)
	const groupTitles: Record<string, string> = {
		directory: '📁 Справочники',
		document: '📄 Документы',
		register: '📊 Регистры',
		constant: '🏷️ Константы',
		flow: '🔀 Сценарии',
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

	// Меню «Открыть ссылку»: команда раскрывает поле ввода, Enter — открыть,
	// Escape — свернуть. Принимает полный URL, hash или голый id записи.
	let openLinkExpanded = $state(false);
	let openLinkInput = $state('');
	let openLinkError = $state('');

	// Нормализация: полный URL/hash парсит сам parseHash (всё до # отрезается),
	// голый id без '#' и '/' превращаем в ссылку на запись.
	function normalizeOpenLink(input: string): string {
		const text = input.trim();
		if (!text) return '';
		if (text.includes('#') || text.includes('/')) return text;
		return `#/r/${text}`;
	}

	async function handleOpenLink() {
		const href = normalizeOpenLink(openLinkInput);
		if (!href) {
			openLinkError = 'Введите ссылку или id записи';
			return;
		}
		const ok = await workspace.openFromLink(href);
		if (ok) {
			openLinkExpanded = false;
			openLinkInput = '';
			openLinkError = '';
		} else {
			openLinkError = 'Объект не найден. Проверьте ссылку.';
		}
	}

	function handleOpenLinkKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleOpenLink();
		} else if (e.key === 'Escape') {
			openLinkExpanded = false;
			openLinkInput = '';
			openLinkError = '';
		}
	}

	function collapseOpenLink() {
		openLinkExpanded = false;
		openLinkInput = '';
		openLinkError = '';
	}

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

	// ---- Настраиваемый порядок меню основного режима ----
	// Порядок групп типов и таблиц внутри них хранится в системной таблице
	// app_settings (запись с ключом main_nav_order), редактируется в конструкторе.
	let navOrder = $state<{ typeOrder: string[]; tableOrder: Record<string, string[]> }>({
		typeOrder: [],
		tableOrder: {}
	});

	$effect(() => {
		const observable = liveQuery(async () => {
			const table = await db.meta_tables.where('name').equals(APP_SETTINGS_TABLE).first();
			if (!table) return null;
			const rows = await db.data_records.where('table_id').equals(table.id).toArray();
			return rows.find((r) => r.data?.key === NAV_ORDER_KEY) ?? null;
		});

		const subscription = observable.subscribe({
			next: (rec) => {
				navOrder = {
					typeOrder: Array.isArray(rec?.data?.typeOrder) ? rec.data.typeOrder : [],
					tableOrder:
						rec?.data?.tableOrder && typeof rec.data.tableOrder === 'object'
							? rec.data.tableOrder
							: {}
				};
			},
			error: (err) => console.error('Ошибка чтения настроек меню:', err)
		});

		return () => subscription.unsubscribe();
	});

	let tablesById = $derived(new Map(tables.map((t) => [t.id, t])));

	// Порядок групп: настроенные типы — в заданном порядке, остальные — после них
	// в стандартном порядке (preferredTypeOrder, кастомные — по алфавиту).
	let orderedTypeList = $derived.by(() => {
		const types = [...typeList];
		const navIdx = new Map(navOrder.typeOrder.map((t, i) => [t, i]));
		types.sort((a, b) => {
			const ia = navIdx.has(a.type) ? navIdx.get(a.type)! : Number.MAX_SAFE_INTEGER;
			const ib = navIdx.has(b.type) ? navIdx.get(b.type)! : Number.MAX_SAFE_INTEGER;
			if (ia !== ib) return ia - ib;
			const pa = preferredTypeOrder.indexOf(a.type);
			const pb = preferredTypeOrder.indexOf(b.type);
			return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb) || a.label.localeCompare(b.label);
		});
		return types;
	});

	// В конструкторе дерево остаётся в исходном порядке, в основном — в настроенном
	let displayTypeList = $derived(workspace.mode === 'constructor' ? typeList : orderedTypeList);

	// Таблицы группы основного режима: из navOrder.tableOrder[type]; не настроенные
	// (новые) — в конец группы по имени.
	function orderedTablesFor(type: string): LocalTable[] {
		const list = mainModeTablesByType[type] ?? [];
		const order = navOrder.tableOrder[type] ?? [];
		if (order.length === 0) return list;
		const byId = new Map(list.map((t) => [t.id, t]));
		const ordered = order.map((id) => byId.get(id)).filter((t): t is LocalTable => !!t);
		const rest = list
			.filter((t) => !order.includes(t.id))
			.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
		return [...ordered, ...rest];
	}

	// Редактирование порядка в конструкторе: правки копятся в черновиках,
	// «Сохранить» пишет их в app_settings и запускает синк.
	let editingNavOrder = $state(false);
	let draftTypeOrder = $state<string[]>([]);
	let draftTableOrder = $state<Record<string, string[]>>({});

	function toggleEditNavOrder() {
		if (editingNavOrder) {
			cancelNavOrder();
			return;
		}
		draftTypeOrder = orderedTypeList.map((t) => t.type);
		draftTableOrder = {};
		for (const t of orderedTypeList) {
			const configured = new Set(navOrder.tableOrder[t.type] ?? []);
			const ordered = (navOrder.tableOrder[t.type] ?? []).filter((id) => tablesById.has(id));
			const rest = (mainModeTablesByType[t.type] ?? [])
				.filter((tbl) => !configured.has(tbl.id))
				.map((tbl) => tbl.id);
			draftTableOrder[t.type] = [...ordered, ...rest];
		}
		editingNavOrder = true;
	}

	function moveType(index: number, dir: -1 | 1) {
		const j = index + dir;
		if (j < 0 || j >= draftTypeOrder.length) return;
		const arr = [...draftTypeOrder];
		[arr[index], arr[j]] = [arr[j], arr[index]];
		draftTypeOrder = arr;
	}

	function moveTable(type: string, index: number, dir: -1 | 1) {
		const current = draftTableOrder[type] ?? [];
		const j = index + dir;
		if (j < 0 || j >= current.length) return;
		const arr = [...current];
		[arr[index], arr[j]] = [arr[j], arr[index]];
		draftTableOrder = { ...draftTableOrder, [type]: arr };
	}

	async function saveNavOrder() {
		try {
			await persistNavOrder({ typeOrder: draftTypeOrder, tableOrder: draftTableOrder });
			editingNavOrder = false;
			await syncService.runFullSync();
		} catch (e: any) {
			alert(`Ошибка сохранения порядка меню: ${e?.message ?? e}`);
		}
	}

	async function resetNavOrder() {
		if (!confirm('Сбросить порядок меню к стандартному?')) return;
		await resetPersistedNavOrder();
		editingNavOrder = false;
		draftTypeOrder = [];
		draftTableOrder = {};
		await syncService.runFullSync();
	}

	function cancelNavOrder() {
		editingNavOrder = false;
		draftTypeOrder = [];
		draftTableOrder = {};
	}

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
		const tables = tablesByType[typeName] ?? [];
		if (tables.length > 0) {
			// Разрешаем удаление, только если у типа нет таблиц с данными.
			// Пустые таблицы (ошибочно созданные) удаляем вместе с типом.
			const withData: LocalTable[] = [];
			const empty: LocalTable[] = [];
			for (const t of tables) {
				const n = await db.data_records.where('table_id').equals(t.id).count();
				(n > 0 ? withData : empty).push(t);
			}
			if (withData.length > 0) {
				alert(
					`Нельзя удалить тип "${typeLabel}": таблица(ы) «${withData
						.map((t) => t.title)
						.join('», «')}» содержат данные. Удалите данные или смените их тип.`
				);
				return;
			}
			if (
				!confirm(
					`Тип "${typeLabel}" содержит пустые таблицы: «${empty
						.map((t) => t.title)
						.join('», «')}». Удалить их вместе с типом?`
				)
			)
				return;
			for (const t of empty) {
				await metadata.deleteTableCascade(t.id);
			}
		}
		if (!confirm(`Удалить тип "${typeLabel}" (${typeName})?`)) return;
		try {
			await deleteTableTypeFromDB(typeName);
			await syncService.runFullSync();
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
				{#if workspace.mode === 'main'}
					<div class="menu-section">
						<div class="group-header-row">
							<span class="group-title">Меню</span>
						</div>
						<button
							class="menu-command-btn"
							class:active={openLinkExpanded}
							onclick={() => (openLinkExpanded = !openLinkExpanded)}
							title="Открыть объект по ссылке в новой вкладке"
						>
							🔗 Открыть ссылку…
						</button>
						{#if openLinkExpanded}
							<div class="open-link-form">
								<input
									type="text"
									bind:value={openLinkInput}
									onkeydown={handleOpenLinkKeydown}
									placeholder="#/r/…, полная ссылка или id"
									class="create-table-input"
									class:input-error={!!openLinkError}
									use:autofocusInput
								/>
								{#if openLinkError}
									<div class="open-link-error">{openLinkError}</div>
								{/if}
								<div class="open-link-actions">
									<button onclick={handleOpenLink} class="type-btn type-btn-primary">Открыть</button
									>
									<button onclick={collapseOpenLink} class="type-btn">Отмена</button>
								</div>
							</div>
						{/if}
					</div>
				{/if}

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
					<div class="navorder-section">
						<div class="group-header-row">
							<span class="group-title">🔀 Порядок меню (основной режим)</span>
							{#if !editingNavOrder}
								<button
									class="group-add-btn"
									onclick={toggleEditNavOrder}
									title="Настроить порядок типов и таблиц"
								>
									✎
								</button>
							{/if}
						</div>

						{#if editingNavOrder}
							{#each draftTypeOrder as typeName, tIndex}
								{@const typeDef = orderedTypeList.find((t) => t.type === typeName)}
								{@const tablesInType = draftTableOrder[typeName] ?? []}
								{#if typeDef}
									<div class="navorder-type-row">
										<div class="navorder-type-title">
											<span class="navorder-group-title"
												>{groupTitle(typeDef.type, typeDef.label)}</span
											>
											<div class="navorder-move">
												<button
													class="navorder-arrow"
													onclick={() => moveType(tIndex, -1)}
													disabled={tIndex === 0}
													title="Группу выше">▲</button
												>
												<button
													class="navorder-arrow"
													onclick={() => moveType(tIndex, 1)}
													disabled={tIndex === draftTypeOrder.length - 1}
													title="Группу ниже">▼</button
												>
											</div>
										</div>
										<ul class="navorder-tables">
											{#each tablesInType as tableId, tIdx}
												{@const table = tablesById.get(tableId)}
												{#if table}
													<li class="navorder-table-row">
														<span class="navorder-table-title">{table.title}</span>
														<div class="navorder-move">
															<button
																class="navorder-arrow"
																onclick={() => moveTable(typeName, tIdx, -1)}
																disabled={tIdx === 0}
																title="Выше">▲</button
															>
															<button
																class="navorder-arrow"
																onclick={() => moveTable(typeName, tIdx, 1)}
																disabled={tIdx === tablesInType.length - 1}
																title="Ниже">▼</button
															>
														</div>
													</li>
												{/if}
											{/each}
										</ul>
									</div>
								{/if}
							{/each}
							<div class="navorder-actions">
								<button onclick={saveNavOrder} class="type-btn type-btn-primary">Сохранить</button>
								<button onclick={resetNavOrder} class="type-btn">Сброс</button>
								<button onclick={cancelNavOrder} class="type-btn">Отмена</button>
							</div>
						{/if}
					</div>

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
										class="row-edit-btn"
										onclick={() =>
											workspace.openTypeConfigurator(t.type, groupTitle(t.type, t.label))}
										title="Предустановки типа">✎</button
									>
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

				{#each displayTypeList as typeDef}
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
										{#each orderedTablesFor(typeDef.type) as table}
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
	.navorder-section {
		margin-bottom: 1.25rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid #e5e7eb;
	}
	.navorder-type-row {
		margin-bottom: 0.5rem;
	}
	.navorder-type-title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		padding: 2px 0.25rem;
	}
	.navorder-group-title {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		color: #6b7280;
	}
	.navorder-tables {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.navorder-table-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		padding: 2px 0.25rem 2px 0.75rem;
		font-size: 0.8rem;
		color: #4b5563;
	}
	.navorder-table-row:hover {
		background-color: #e5e7eb;
		border-radius: 0.25rem;
	}
	.navorder-table-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.navorder-move {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
	}
	.navorder-arrow {
		background: none;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		color: #475569;
		font-size: 0.6rem;
		width: 20px;
		height: 20px;
		cursor: pointer;
		line-height: 1;
	}
	.navorder-arrow:hover:not(:disabled) {
		background-color: #f1f5f9;
		color: #1f2937;
	}
	.navorder-arrow:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.navorder-actions {
		display: flex;
		gap: 6px;
		margin-top: 0.5rem;
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
	.row-edit-btn {
		background: none;
		border: none;
		color: #64748b;
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
	.row-edit-btn:hover {
		background: #e2e8f0;
		color: #1f2937;
	}
	.tree-row:hover .row-del-btn,
	.type-row:hover .row-edit-btn,
	.type-row:hover .row-del-btn {
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
	.menu-section {
		margin-bottom: 1.25rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid #e5e7eb;
	}
	.menu-command-btn {
		width: 100%;
		display: flex;
		align-items: center;
		text-align: left;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.5rem 0.75rem;
		font-size: 0.9rem;
		color: #4b5563;
		border-radius: 0.375rem;
		transition: background-color 0.2s;
	}
	.menu-command-btn:hover {
		background-color: #e5e7eb;
		color: #1f2937;
	}
	.menu-command-btn.active {
		background-color: #e0e7ff;
		color: #4f46e5;
		font-weight: 500;
	}
	.open-link-form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 0 0.25rem 0.5rem;
	}
	.open-link-actions {
		display: flex;
		gap: 6px;
	}
	.open-link-error {
		font-size: 0.75rem;
		color: #dc2626;
	}
	.input-error {
		border-color: #ef4444;
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
