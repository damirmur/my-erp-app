<script lang="ts">
	import { db, type LocalTable } from '$lib/db/indexeddb';
	import { metadata } from '$lib/state/metadata';
	import { workspace } from '$lib/state/workspace.svelte';
	import { syncService } from '$lib/services/sync';
	import { fieldTypeList } from '$lib/fields';
	import LinkConfig from '$lib/fields/LinkConfig.svelte';
	import { liveQuery } from 'dexie';
	import { getTableType, getEffectiveConfig, type TableTypeModule } from '$lib/table-types';

	// Вкладка конфигуратора привязана к одной таблице
	let { tabId = '', tableId = '' } = $props();

	// ===== Черновые модели (staged): изменения копятся в памяти до нажатия «Записать» =====
	interface ColumnDraft {
		key: string; // стабильный локальный ключ
		dbId: string | null; // id в БД (null — новая)
		isNew: boolean;
		deleted: boolean;
		name: string;
		title: string;
		type: string;
		sort_order: number;
		related_table_id: string | null;
	}

	interface SubTableDraft {
		key: string;
		dbId: string | null;
		isNew: boolean;
		deleted: boolean;
		name: string;
		title: string;
		columns: ColumnDraft[];
	}

	let selectedTableId = $state('');
	let selectedTableMeta = $state<LocalTable | null>(null);
	let headerColumns = $state<ColumnDraft[]>([]);
	let subTablesDraft = $state<SubTableDraft[]>([]);

	// Параметры добавления/редактирования реквизита
	let editingKey = $state<string | null>(null); // 'main' или ключ ТЧ
	let editingColKey = $state<string | null>(null);
	let newColName = $state('');
	let newColTitle = $state('');
	let newColType = $state('string');
	let newColRelatedTableId = $state('');

	// Параметры создания Табличной Части
	let newSubName = $state('');
	let newSubTitle = $state('');

	let allTables = $state<LocalTable[]>([]);

	// Вкладки ТЧ
	let activeSubIndex = $state<number>(0);

	// Настройки объекта (черновик)
	let editConfig = $state<{
		features: Record<string, boolean>;
		hiddenActions: string[];
		statusReadOnly: Record<string, boolean>;
		periodic: boolean;
	}>({ features: {}, hiddenActions: [], statusReadOnly: {}, periodic: false });
	let selectedTypeDef = $state<TableTypeModule | null>(null);

	// Синоним таблицы (черновик)
	let tableSynonym = $state('');

	let saving = $state(false);

	let dirty = $derived(workspace.tabs.find((t) => t.id === tabId)?.isDirty ?? false);

	// Видимые ТЧ (без помеченных на удаление)
	let visibleSubTables = $derived(subTablesDraft.filter((s) => !s.deleted));

	function markDirty() {
		workspace.setDirty(tabId, true);
	}

	function toColumnDraft(col: {
		id: string;
		name: string;
		title: string;
		type: string;
		sort_order: number;
		related_table_id?: string | null;
	}): ColumnDraft {
		return {
			key: crypto.randomUUID(),
			dbId: col.id,
			isNew: false,
			deleted: false,
			name: col.name,
			title: col.title,
			type: col.type,
			sort_order: col.sort_order ?? 10,
			related_table_id: col.related_table_id ?? null
		};
	}

	function getColumnList(key: string): ColumnDraft[] {
		if (key === 'main') return headerColumns;
		return subTablesDraft.find((s) => s.key === key)?.columns ?? [];
	}

	// Полная загрузка данных из БД (используется при открытии вкладки и после «Отмена»)
	async function loadAll() {
		if (!selectedTableId) return;
		selectedTableMeta = (await db.meta_tables.get(selectedTableId)) ?? null;
		if (!selectedTableMeta) return;
		tableSynonym = selectedTableMeta.title;
		selectedTypeDef = getTableType(selectedTableMeta.type);
		const effective = getEffectiveConfig(selectedTableMeta);
		editConfig = {
			features: { ...effective.features },
			hiddenActions: [...(effective.hiddenActions ?? [])],
			statusReadOnly: { ...(effective.statusReadOnly ?? {}) },
			periodic: effective.periodic ?? false
		};

		const cols = await db.meta_columns
			.where('table_id')
			.equals(selectedTableId)
			.sortBy('sort_order');
		headerColumns = cols.map(toColumnDraft);

		const subs = allTables.filter((t) => t.parent_table_id === selectedTableId);
		subTablesDraft = [];
		for (const sub of subs) {
			const subCols = await db.meta_columns.where('table_id').equals(sub.id).sortBy('sort_order');
			subTablesDraft.push({
				key: crypto.randomUUID(),
				dbId: sub.id,
				isNew: false,
				deleted: false,
				name: sub.name ?? '',
				title: sub.title,
				columns: subCols.map(toColumnDraft)
			});
		}
		if (activeSubIndex >= subTablesDraft.length) activeSubIndex = 0;
	}

	$effect(() => {
		const sub = liveQuery(() => db.meta_tables.toArray()).subscribe({
			next: (tables) => {
				allTables = tables;
			}
		});
		return () => sub.unsubscribe();
	});

	$effect(() => {
		if (tableId && tableId !== selectedTableId) {
			selectedTableId = tableId;
		}
	});

	$effect(() => {
		if (selectedTableId) {
			loadAll();
		}
	});

	function genSlug(text: string, prefix = 'col'): string {
		return (
			text
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')
				.replace(/^_|_$/g, '') || `${prefix}_${Date.now().toString(36)}`
		);
	}

	$effect(() => {
		if (newColTitle && !newColName) {
			newColName = genSlug(newColTitle);
		}
	});

	$effect(() => {
		if (newSubTitle && !newSubName) {
			newSubName = genSlug(newSubTitle, 'tbl');
		}
	});

	// ===== Реквизиты (шапка и ТЧ) =====
	function handleEditColumn(key: string, col: ColumnDraft) {
		editingKey = key;
		editingColKey = col.key;
		newColName = col.name;
		newColTitle = col.title;
		newColType = col.type;
		newColRelatedTableId = col.related_table_id ?? '';
	}

	function handleCancelEdit() {
		editingKey = null;
		editingColKey = null;
		newColName = '';
		newColTitle = '';
		newColType = 'string';
		newColRelatedTableId = '';
	}

	function handleAddOrUpdateColumn(key: string) {
		if (!newColTitle) return alert('Заполните заголовок реквизита!');
		const colName = newColName || genSlug(newColTitle);
		const list = getColumnList(key);

		if (editingKey === key && editingColKey) {
			const col = list.find((c) => c.key === editingColKey);
			if (col) {
				col.name = colName;
				col.title = newColTitle;
				col.type = newColType;
				col.related_table_id = newColRelatedTableId || null;
			}
		} else {
			list.push({
				key: crypto.randomUUID(),
				dbId: null,
				isNew: true,
				deleted: false,
				name: colName,
				title: newColTitle,
				type: newColType,
				sort_order: 10,
				related_table_id: newColRelatedTableId || null
			});
		}
		handleCancelEdit();
		markDirty();
	}

	function handleDeleteColumn(key: string, col: ColumnDraft) {
		if (!confirm('Вы уверены, что хотите удалить этот реквизит? Структура формы изменится.'))
			return;
		col.deleted = true;
		if (editingColKey === col.key) handleCancelEdit();
		markDirty();
	}

	// ===== Табличные части =====
	function handleAddSubTable() {
		if (!newSubTitle) return alert('Заполните синоним ТЧ!');
		const subName = newSubName || genSlug(newSubTitle, 'tbl');
		subTablesDraft.push({
			key: crypto.randomUUID(),
			dbId: null,
			isNew: true,
			deleted: false,
			name: subName,
			title: newSubTitle,
			columns: []
		});
		newSubName = '';
		newSubTitle = '';
		activeSubIndex = subTablesDraft.length - 1;
		markDirty();
	}

	function handleDeleteSubTable(sub: SubTableDraft) {
		if (!confirm(`Удалить табличную часть "${sub.title}"? Это также удалит все её реквизиты.`))
			return;
		sub.deleted = true;
		markDirty();
	}

	// ===== Запись всех изменений одной кнопкой =====
	async function handleSave() {
		if (!selectedTableMeta) return;
		saving = true;
		try {
			if (tableSynonym !== selectedTableMeta.title) {
				await metadata.updateTableTitle(selectedTableId, tableSynonym);
			}
			await metadata.updateTableConfig(selectedTableId, editConfig);

			// Реквизиты шапки
			for (const col of headerColumns) {
				if (col.deleted) {
					if (col.dbId) await metadata.deleteColumnQuiet(col.dbId);
					continue;
				}
				if (col.dbId) {
					await metadata.saveOrUpdateColumn(selectedTableId, col.dbId, {
						name: col.name,
						title: col.title,
						type: col.type,
						sort_order: col.sort_order,
						related_table_id: col.related_table_id
					});
				} else {
					await metadata.saveOrUpdateColumn(selectedTableId, 'new', {
						name: col.name,
						title: col.title,
						type: col.type,
						sort_order: col.sort_order,
						related_table_id: col.related_table_id
					});
				}
			}

			// Табличные части
			for (const sub of subTablesDraft) {
				if (sub.deleted) {
					if (sub.dbId) {
						await metadata.deleteColumnsByTable(sub.dbId);
						await metadata.deleteTable(sub.dbId);
					}
					continue;
				}
				let subId = sub.dbId;
				if (!subId) {
					subId = await metadata.createNewTable(sub.title, 'tabular', sub.name, selectedTableId);
				}
				if (subId) {
					for (const col of sub.columns) {
						if (col.deleted) {
							if (col.dbId) await metadata.deleteColumnQuiet(col.dbId);
							continue;
						}
						if (col.dbId) {
							await metadata.saveOrUpdateColumn(subId, col.dbId, {
								name: col.name,
								title: col.title,
								type: col.type,
								sort_order: col.sort_order,
								related_table_id: col.related_table_id
							});
						} else {
							await metadata.saveOrUpdateColumn(subId, 'new', {
								name: col.name,
								title: col.title,
								type: col.type,
								sort_order: col.sort_order,
								related_table_id: col.related_table_id
							});
						}
					}
				}
			}

			// Периодическая константа: автоматически создаём таблицу периодов
			if (selectedTableMeta.type === 'constant' && editConfig.periodic) {
				const hasChild = subTablesDraft.some((s) => !s.deleted);
				if (!hasChild) {
					const childName = genSlug(`${selectedTableMeta.name ?? 'constant'}_periods`, 'tbl');
					const childId = await metadata.createNewTable(
						'Периоды',
						'tabular',
						childName,
						selectedTableId
					);
					if (childId) {
						const valueType = headerColumns.find((c) => !c.deleted)?.type ?? 'string';
						await metadata.saveOrUpdateColumn(childId, 'new', {
							name: 'period',
							title: 'Период',
							type: 'date',
							sort_order: 1,
							related_table_id: null
						});
						await metadata.saveOrUpdateColumn(childId, 'new', {
							name: 'value',
							title: 'Значение',
							type: valueType,
							sort_order: 2,
							related_table_id: null
						});
					}
				}
			}
		} finally {
			saving = false;
		}
		workspace.setDirty(tabId, false);
		workspace.updateTabTitle(tabId, `⚙️ ${tableSynonym}`);
		await syncService.runFullSync();
		await loadAll();
	}

	// Сброс всех черновых изменений
	async function handleCancel() {
		if (dirty && !confirm('Отменить все несохраненные изменения?')) return;
		workspace.setDirty(tabId, false);
		handleCancelEdit();
		await loadAll();
	}
</script>

<div class="configurator-layout">
	<div class="meta-editor-box">
		<div class="config-toolbar">
			<span class="cfg-table-name">{selectedTableMeta?.title ?? 'Конфигуратор'}</span>
			<span class="cfg-table-code">{selectedTableMeta?.name ?? ''}</span>
			{#if dirty}<span class="dirty-flag">*</span>{/if}
			<div class="toolbar-spacer"></div>
			<button onclick={handleSave} class="btn-blue" disabled={saving || !selectedTableMeta}>
				{saving ? '⏳ Запись...' : '💾 Записать'}
			</button>
			<button onclick={handleCancel} class="btn-cancel" disabled={!dirty}>✕ Отмена</button>
		</div>
		<hr class="divider" />

		{#if selectedTableMeta}
			<div class="field-group">
				<label for="cfg-synonym">Синоним таблицы</label>
				<input
					id="cfg-synonym"
					type="text"
					bind:value={tableSynonym}
					oninput={markDirty}
					placeholder="Синоним (рус.)"
				/>
			</div>
		{/if}

		{#if selectedTableMeta && selectedTableId}
			<div class="editor-workspace">
				<!-- 1. Реквизиты Шапки -->
				<h4>1. Реквизиты Шапки:</h4>
				<table class="config-table" border="1">
					<thead>
						<tr
							><th>Имя</th><th>Заголовок</th><th>Тип реквизита</th><th style="width:80px;"
								>Действия</th
							></tr
						>
					</thead>
					<tbody>
						{#each headerColumns.filter((c) => !c.deleted) as col}
							<tr class:editing-row={editingColKey === col.key}>
								<td>{col.name}</td>
								<td>{col.title}</td>
								<td>{col.type}</td>
								<td class="text-center">
									<button
										onclick={() => handleEditColumn('main', col)}
										class="btn-icon-edit"
										title="Редактировать реквизит">✏️</button
									>
									<button
										onclick={() => handleDeleteColumn('main', col)}
										class="btn-icon-del"
										title="Удалить реквизит">❌</button
									>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>

				{#if selectedTableMeta.type !== 'constant' || headerColumns.filter((c) => !c.deleted).length === 0}
					<div class="add-main-column-zone">
						<input
							aria-label="Имя нового поля"
							type="text"
							bind:value={newColName}
							placeholder="Имя реквизита"
						/>
						<input
							aria-label="Синоним нового поля"
							type="text"
							bind:value={newColTitle}
							placeholder="Синоним"
						/>
						<select aria-label="Тип нового поля" bind:value={newColType}>
							{#each fieldTypeList as ft}
								<option value={ft.type}>{ft.label}</option>
							{/each}
						</select>

						{#if newColType === 'link'}
							<LinkConfig bind:relatedTableId={newColRelatedTableId} {allTables} />
						{/if}
						<button onclick={() => handleAddOrUpdateColumn('main')} class="btn-blue">
							{editingKey === 'main' ? 'Применить' : '➕ Добавить в шапку'}
						</button>
						{#if editingKey === 'main'}
							<button onclick={handleCancelEdit} class="btn-cancel">Отмена</button>
						{/if}
					</div>
				{/if}

				<!-- 2. Настройки объекта -->
				<h4 style="margin-top:2rem;">2. Настройки объекта:</h4>
				{#if selectedTypeDef}
					<div class="config-section">
						<div class="config-grid">
							<label class="cfg-check">
								<input
									type="checkbox"
									bind:checked={editConfig.features.hierarchy}
									onchange={markDirty}
								/>
								Иерархия (группы/папки)
							</label>
							<label class="cfg-check">
								<input
									type="checkbox"
									bind:checked={editConfig.features.copy}
									onchange={markDirty}
								/>
								Копирование
							</label>
							<label class="cfg-check">
								<input
									type="checkbox"
									bind:checked={editConfig.features.print}
									onchange={markDirty}
								/>
								Печать
							</label>
							<label class="cfg-check">
								<input
									type="checkbox"
									bind:checked={editConfig.features.tabularSections}
									onchange={markDirty}
								/>
								Табличные части
							</label>
						</div>

						{#if selectedTypeDef.statuses.length > 1}
							<div class="cfg-status-readonly">
								<span class="cfg-label">Статусы «только чтение»:</span>
								{#each selectedTypeDef.statuses as st}
									<label class="cfg-check">
										<input
											type="checkbox"
											bind:checked={editConfig.statusReadOnly[st.value]}
											onchange={markDirty}
										/>
										{st.icon}
										{st.label}
									</label>
								{/each}
							</div>
						{/if}

						{#if selectedTableMeta.type === 'constant'}
							<div class="cfg-status-readonly">
								<label class="cfg-check">
									<input type="checkbox" bind:checked={editConfig.periodic} onchange={markDirty} />
									📅 Периодическая (значения по датам, создаётся таблица «Периоды»)
								</label>
							</div>
						{/if}
					</div>
				{/if}

				<!-- 3. Табличные части — вкладки (для констант управляются автоматически) -->
				{#if selectedTableMeta.type !== 'constant'}
					<div class="sub-tabs-bar">
						{#each visibleSubTables as sub, i}
							<button
								class="sub-tab"
								class:active={activeSubIndex === i}
								onclick={() => (activeSubIndex = i)}
							>
								{sub.title}{#if sub.isNew}<span class="sub-new-flag"> (нов.)</span>{/if}
							</button>
						{/each}
						<button
							class="sub-tab add-tab"
							onclick={() => (activeSubIndex = visibleSubTables.length)}>+</button
						>
					</div>

					{#if activeSubIndex < visibleSubTables.length}
						{@const sub = visibleSubTables[activeSubIndex]}
						<div class="sub-tab-content">
							<div class="sub-tab-header">
								<strong>{sub.title}</strong>
								<span>[{sub.name || 'новое имя'}]</span>
								<button
									onclick={() => handleDeleteSubTable(sub)}
									class="btn-icon-del"
									title="Удалить ТЧ">🗑️</button
								>
							</div>

							<table class="config-table" border="1">
								<thead>
									<tr
										><th>Имя</th><th>Заголовок</th><th>Тип реквизита</th><th style="width:80px;"
											>Действия</th
										></tr
									>
								</thead>
								<tbody>
									{#each sub.columns.filter((c) => !c.deleted) as col}
										<tr class:editing-row={editingColKey === col.key}>
											<td>{col.name}</td>
											<td>{col.title}</td>
											<td>{col.type}</td>
											<td class="text-center">
												<button
													onclick={() => handleEditColumn(sub.key, col)}
													class="btn-icon-edit"
													title="Редактировать реквизит">✏️</button
												>
												<button
													onclick={() => handleDeleteColumn(sub.key, col)}
													class="btn-icon-del"
													title="Удалить реквизит">❌</button
												>
											</td>
										</tr>
									{/each}
								</tbody>
							</table>

							<div class="add-main-column-zone">
								<input
									aria-label="Имя поля ТЧ"
									type="text"
									bind:value={newColName}
									placeholder="Имя реквизита"
								/>
								<input
									aria-label="Синоним поля ТЧ"
									type="text"
									bind:value={newColTitle}
									placeholder="Синоним"
								/>
								<select aria-label="Тип поля ТЧ" bind:value={newColType}>
									{#each fieldTypeList as ft}
										<option value={ft.type}>{ft.label}</option>
									{/each}
								</select>
								{#if newColType === 'link'}
									<LinkConfig bind:relatedTableId={newColRelatedTableId} {allTables} />
								{/if}
								<button onclick={() => handleAddOrUpdateColumn(sub.key)} class="btn-blue">
									{editingKey === sub.key ? 'Применить' : '➕ Добавить в ТЧ'}
								</button>
								{#if editingKey === sub.key}
									<button onclick={handleCancelEdit} class="btn-cancel">Отмена</button>
								{/if}
							</div>
						</div>
					{:else}
						<div class="create-subtable-zone">
							<h5>➕ Добавить новую Табличную Часть:</h5>
							<div class="flex-inputs">
								<input
									aria-label="Имя новой ТЧ"
									type="text"
									bind:value={newSubName}
									placeholder="Имя ТЧ (e.g., contacts)"
								/>
								<input
									aria-label="Синоним новой ТЧ"
									type="text"
									bind:value={newSubTitle}
									placeholder="Синоним ТЧ (e.g., Контакты)"
								/>
								<button onclick={handleAddSubTable} class="btn-blue">➕ Создать ТЧ</button>
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.configurator-layout {
		padding: 1rem;
		box-sizing: border-box;
		height: 100%;
		overflow-y: auto;
		background-color: #f1f5f9;
	}
	.meta-editor-box {
		border: 1px solid #cbd5e1;
		padding: 1rem;
		border-radius: 6px;
		background: #ffffff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
	}
	.config-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.cfg-table-name {
		font-size: 1rem;
		font-weight: 700;
		color: #1e293b;
	}
	.cfg-table-code {
		font-size: 0.75rem;
		color: #94a3b8;
	}
	.dirty-flag {
		color: #ef4444;
		font-weight: bold;
	}
	.toolbar-spacer {
		flex: 1;
	}
	h4 {
		color: #334155;
		margin-bottom: 0.5rem;
		font-size: 0.95rem;
	}
	h5 {
		margin: 0 0 8px 0;
		color: #475569;
		font-size: 0.85rem;
	}
	.divider {
		border: 0;
		border-top: 1px solid #e2e8f0;
		margin: 12px 0;
	}
	.field-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 10px;
	}
	.field-group label {
		font-size: 0.8rem;
		font-weight: 600;
		color: #475569;
	}
	input,
	select {
		padding: 5px 8px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		font-size: 0.85rem;
		outline: none;
	}
	input:focus,
	select:focus {
		border-color: #3b82f6;
	}
	.btn-blue {
		background: #2563eb;
		color: white;
		border: none;
		padding: 6px 12px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 500;
		white-space: nowrap;
	}
	.btn-blue:hover {
		background: #1d4ed8;
	}
	.btn-blue:disabled,
	.btn-cancel:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.config-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
		margin-bottom: 1rem;
	}
	.config-table th {
		background: #f8fafc;
		border: 1px solid #cbd5e1;
		padding: 6px;
		text-align: left;
	}
	.config-table td {
		border: 1px solid #e2e8f0;
		padding: 6px;
		color: #334155;
	}
	.text-center {
		text-align: center;
	}
	.btn-icon-del,
	.btn-icon-edit {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 2px 4px;
	}
	.btn-icon-del:hover {
		opacity: 0.6;
	}
	.btn-icon-edit:hover {
		opacity: 0.6;
	}
	.editing-row {
		background-color: #fef9c3 !important;
	}
	.btn-cancel {
		background: #e2e8f0;
		color: #475569;
		border: none;
		padding: 6px 12px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.add-main-column-zone {
		display: flex;
		gap: 6px;
		align-items: center;
		background: #f8fafc;
		padding: 8px;
		border-radius: 4px;
		border: 1px solid #e2e8f0;
		flex-wrap: wrap;
	}
	.add-main-column-zone input,
	.add-main-column-zone select {
		flex: 1;
		min-width: 100px;
	}

	.sub-tabs-bar {
		display: flex;
		gap: 2px;
		border-bottom: 2px solid #cbd5e1;
		margin-bottom: 0.5rem;
		flex-wrap: wrap;
	}
	.sub-tab {
		background: #f1f5f9;
		border: 1px solid #cbd5e1;
		border-bottom: none;
		padding: 6px 14px;
		font-size: 0.8rem;
		cursor: pointer;
		color: #475569;
		border-radius: 4px 4px 0 0;
	}
	.sub-tab.active {
		background: #ffffff;
		border-bottom: 2px solid #2563eb;
		color: #1e3a8a;
		font-weight: 600;
	}
	.sub-tab.add-tab {
		background: none;
		border: 1px dashed #94a3b8;
		color: #64748b;
		font-weight: 700;
		font-size: 1rem;
		padding: 6px 12px;
	}
	.sub-tab.add-tab:hover {
		background: #f0fdf4;
		border-color: #16a34a;
		color: #16a34a;
	}
	.sub-new-flag {
		font-size: 0.7rem;
		color: #2563eb;
		font-weight: 400;
	}

	.sub-tab-content {
		border: 1px solid #e2e8f0;
		padding: 10px;
		border-radius: 4px;
		background: #fafafa;
	}
	.sub-tab-header {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.9rem;
		margin-bottom: 8px;
	}
	.sub-tab-header span {
		color: #64748b;
		font-size: 0.75rem;
	}
	.sub-tab-header .btn-icon-del {
		margin-left: auto;
	}

	.create-subtable-zone {
		border: 1px dashed #cbd5e1;
		padding: 12px;
		border-radius: 4px;
		background: #f8fafc;
	}
	.flex-inputs {
		display: flex;
		gap: 6px;
	}
	.flex-inputs input {
		flex: 1;
	}

	.config-section {
		border: 1px solid #e2e8f0;
		padding: 10px 12px;
		border-radius: 4px;
		background: #fafafa;
		margin-bottom: 1.5rem;
	}
	.config-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-bottom: 8px;
	}
	.cfg-check {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.85rem;
		cursor: pointer;
		color: #334155;
	}
	.cfg-check input {
		width: auto;
	}
	.cfg-status-readonly {
		border-top: 1px solid #e2e8f0;
		padding-top: 8px;
		margin-bottom: 8px;
	}
	.cfg-label {
		font-size: 0.8rem;
		font-weight: 600;
		color: #475569;
		display: block;
		margin-bottom: 4px;
	}
</style>
