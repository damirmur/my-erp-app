<script lang="ts">
	import { supabase } from '$lib/db/supabase';
	import { db, type LocalTable, type LocalColumn } from '$lib/db/indexeddb';
	import { metadata } from '$lib/state/metadata';
	import { syncService } from '$lib/services/sync';
	import { fieldTypeList } from '$lib/fields';
	import LinkConfig from '$lib/fields/LinkConfig.svelte';
	import { liveQuery } from 'dexie';
	import { getTableType, getEffectiveConfig, tableTypeList, saveTableTypeToDB, deleteTableTypeFromDB, type TableTypeModule } from '$lib/table-types';

	let { tabId = '' } = $props();

	let newTableTitle = $state('');
	let newTableType = $state('directory');
	let creatableTypes = $derived($tableTypeList.filter(t => t.type !== 'template'));

	// Состояние редактора выбранного объекта
	let selectedTableId = $state('');
	let tableColumns = $state<LocalColumn[]>([]);
	let subTables = $state<LocalTable[]>([]);

	// Параметры добавления реквизита
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
	let subTableColumns = $state<Map<string, LocalColumn[]>>(new Map());

	// Режим редактирования колонки
	let editingColId = $state<string | null>(null);
	let editingTargetTableId = $state<string | null>(null);

	// Настройки объекта
	let selectedTableMeta = $state<LocalTable | null>(null);
	let editConfig = $state<{ features: Record<string, boolean>; hiddenActions: string[]; statusReadOnly: Record<string, boolean> }>({ features: {}, hiddenActions: [], statusReadOnly: {} });
	let selectedTypeDef = $state<TableTypeModule | null>(null);
	let configSaving = $state(false);

	// Управление типами таблиц
	let newTypeName = $state('');
	let newTypeLabel = $state('');
	let newTypeBase = $state('document');
	let typeSaving = $state(false);
	let typeList = $derived($tableTypeList);

	async function handleCreateType() {
		if (!newTypeName || !newTypeLabel) return alert('Заполните имя и метку типа!');
		typeSaving = true;
		const base = getTableType(newTypeBase);
		try {
			await saveTableTypeToDB(newTypeName, newTypeLabel, base);
			newTypeName = ''; newTypeLabel = '';
		} catch (e: any) {
			alert(`Ошибка: ${e.message}`);
		}
		typeSaving = false;
	}

	async function handleDeleteType(name: string) {
		if (!confirm(`Удалить тип "${name}"? Это не удалит таблицы этого типа.`)) return;
		try {
			await deleteTableTypeFromDB(name);
		} catch (e: any) {
			alert(`Ошибка: ${e.message}`);
		}
	}

	async function loadConfig() {
		if (!selectedTableId) return;
		selectedTableMeta = await db.meta_tables.get(selectedTableId) ?? null;
		if (!selectedTableMeta) return;
		selectedTypeDef = getTableType(selectedTableMeta.type);
		const effective = getEffectiveConfig(selectedTableMeta);
		editConfig = {
			features: { ...effective.features },
			hiddenActions: [...(effective.hiddenActions ?? [])],
			statusReadOnly: { ...(effective.statusReadOnly ?? {}) }
		};
	}

	async function saveConfig() {
		if (!selectedTableMeta) return;
		configSaving = true;
		await metadata.updateTableConfig(selectedTableMeta.id, editConfig);
		configSaving = false;
		await syncService.runFullSync();
	}

	$effect(() => {
		const sub = liveQuery(() => db.meta_tables.toArray()).subscribe({
			next: (tables) => {
				allTables = tables;
			}
		});
		return () => sub.unsubscribe();
	});

	async function loadTableData() {
		if (!selectedTableId) return;
		tableColumns = await db.meta_columns.where('table_id').equals(selectedTableId).sortBy('sort_order');
		subTables = allTables.filter(t => t.parent_table_id === selectedTableId);

		const colMap = new Map<string, LocalColumn[]>();
		for (const sub of subTables) {
			colMap.set(sub.id, await db.meta_columns.where('table_id').equals(sub.id).sortBy('sort_order'));
		}
		subTableColumns = colMap;
		if (activeSubIndex >= subTables.length) activeSubIndex = 0;
	}

	$effect(() => {
		if (selectedTableId) { loadTableData(); loadConfig(); }
	});

	async function handleCreateTable() {
		if (!newTableTitle) return alert('Заполните название!');
		await metadata.createNewTable(newTableTitle, newTableType);
		newTableTitle = '';
		await syncService.runFullSync();
		await loadTableData();
	}

	async function handleCreateSubTable() {
		if (!newSubTitle || !selectedTableId) return alert('Заполните синоним ТЧ!');
		const subName = newSubName || genSlug(newSubTitle, 'tbl');
		await metadata.createNewTable(newSubTitle, 'template', subName, selectedTableId);
		newSubName = ''; newSubTitle = '';
		activeSubIndex = subTables.length;
		await syncService.runFullSync();
		await loadTableData();
	}

	function genSlug(text: string, prefix = 'col'): string {
		return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `${prefix}_${Date.now().toString(36)}`;
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

	function handleEditColumn(col: LocalColumn) {
		editingColId = col.id;
		editingTargetTableId = col.table_id;
		newColName = col.name;
		newColTitle = col.title;
		newColType = col.type;
		newColRelatedTableId = col.related_table_id ?? '';
	}

	function handleCancelEdit() {
		editingColId = null;
		editingTargetTableId = null;
		newColName = '';
		newColTitle = '';
		newColType = 'string';
		newColRelatedTableId = '';
	}

	async function handleAddColumn(targetTableId: string) {
		if (!newColTitle) return alert('Заполните заголовок реквизита!');
		const colName = newColName || genSlug(newColTitle);
		const colId = editingColId && editingTargetTableId === targetTableId ? editingColId : 'new';
		await metadata.saveOrUpdateColumn(targetTableId, colId, {
			name: colName, title: newColTitle, 			type: newColType as LocalColumn['type'], sort_order: 10,
			related_table_id: newColRelatedTableId || null
		});
		handleCancelEdit();
		await syncService.runFullSync();
		await loadTableData();
	}

	async function handleDeleteColumn(colId: string) {
		if (confirm('Вы уверены, что хотите удалить этот реквизит? Структура формы изменится.')) {
			await metadata.deleteColumn(colId);
			await syncService.runFullSync();
			await loadTableData();
		}
	}

	async function handleDeleteSubTable(subId: string) {
		if (!confirm(`Удалить табличную часть "${subTables.find(s => s.id === subId)?.title}"? Это также удалит все её реквизиты.`)) return;
		await metadata.deleteColumnsByTable(subId);
		await metadata.deleteTable(subId);
		await syncService.runFullSync();
		await loadTableData();
	}


</script>

<div class="configurator-layout">
	<div class="meta-creator-box">
		<h3>➕ Новая таблица (1С-стиль)</h3>
		<hr class="divider"/>

		<div class="field-group">
			<label for="n-title">Название</label>
			<input id="n-title" type="text" bind:value={newTableTitle} placeholder="e.g., Контрагенты" />
		</div>

		<div class="field-group">
			<label for="n-type">Тип объекта конфигурации</label>
			<select id="n-type" bind:value={newTableType}>
				{#each creatableTypes as tt}
					<option value={tt.type}>{tt.label} ({tt.type})</option>
				{/each}
			</select>
		</div>

		<button onclick={handleCreateTable} class="btn-submit">Создать объект</button>

		<h3 style="margin-top:1.5rem;">⚙️ Типы таблиц</h3>
		<hr class="divider"/>
		<div class="type-list">
			{#each typeList as tt}
				<div class="type-item">
					<span class="type-badge">{tt.label}</span>
					<code class="type-code">{tt.type}</code>
					<span class="type-meta">{tt.statuses.length} статусов, {tt.actions.length} действий</span>
					{#if !['directory','document','template'].includes(tt.type)}
						<button onclick={() => handleDeleteType(tt.type)} class="btn-icon-del-sm" title="Удалить тип">✕</button>
					{/if}
				</div>
			{/each}
		</div>

		<details style="margin-top:0.5rem;">
			<summary style="cursor:pointer;font-size:0.85rem;color:#2563eb;">➕ Новый тип</summary>
			<div class="field-group" style="margin-top:0.5rem;">
				<label for="nt-name">Имя типа (лат., одно слово)</label>
				<input id="nt-name" type="text" bind:value={newTypeName} placeholder="ai_skill" />
			</div>
			<div class="field-group">
				<label for="nt-label">Метка</label>
				<input id="nt-label" type="text" bind:value={newTypeLabel} placeholder="Навык ИИ" />
			</div>
			<div class="field-group">
				<label for="nt-base">На основе</label>
				<select id="nt-base" bind:value={newTypeBase}>
					{#each typeList as tt}
						<option value={tt.type}>{tt.label}</option>
					{/each}
				</select>
			</div>
			<button onclick={handleCreateType} class="btn-blue" disabled={typeSaving} style="width:100%;">
				{typeSaving ? '⏳...' : '➕ Создать тип'}
			</button>
		</details>
	</div>

	<div class="meta-editor-box">
		<h3>📝 Палитра свойств и Табличных частей</h3>
		<hr class="divider"/>

		<div class="field-group">
			<label for="cfg-main-select">Выберите Справочник или Документ для настройки</label>
			<select id="cfg-main-select" bind:value={selectedTableId}>
				<option value="">-- Выберите объект --</option>
				{#each allTables.filter(t => t.type !== 'template') as t}
					<option value={t.id}>{t.title} [{t.name ?? t.id.slice(0, 8)}]</option>
				{/each}
			</select>
		</div>

		{#if selectedTableId}
			<div class="editor-workspace">
				<!-- 1. Реквизиты Шапки -->
				<h4>1. Реквизиты Шапки:</h4>
				<table class="config-table" border="1">
					<thead>
						<tr><th>Имя</th><th>Заголовок</th><th>Тип реквизита</th><th style="width:80px;">Действия</th></tr>
					</thead>
					<tbody>
						{#each tableColumns as col}
							<tr class:editing-row={editingColId === col.id}>
								<td>{col.name}</td>
								<td>{col.title}</td>
								<td>{col.type}</td>
								<td class="text-center">
									<button onclick={() => handleEditColumn(col)} class="btn-icon-edit" title="Редактировать реквизит">✏️</button>
									<button onclick={() => handleDeleteColumn(col.id)} class="btn-icon-del" title="Удалить реквизит">❌</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>

				<div class="add-main-column-zone">
					<input aria-label="Имя нового поля" type="text" bind:value={newColName} placeholder="Имя реквизита" />
					<input aria-label="Синоним нового поля" type="text" bind:value={newColTitle} placeholder="Синоним" />
					<select aria-label="Тип нового поля" bind:value={newColType}>
						{#each fieldTypeList as ft}
							<option value={ft.type}>{ft.label}</option>
						{/each}
					</select>

					{#if newColType === 'link'}
						<LinkConfig bind:relatedTableId={newColRelatedTableId} {allTables} />
					{/if}
					<button onclick={() => handleAddColumn(selectedTableId)} class="btn-blue">
						{editingColId && editingTargetTableId === selectedTableId ? '💾 Сохранить' : '➕ Добавить в шапку'}
					</button>
					{#if editingColId && editingTargetTableId === selectedTableId}
						<button onclick={handleCancelEdit} class="btn-cancel">Отмена</button>
					{/if}
				</div>

				<!-- 2. Настройки объекта -->
				<h4 style="margin-top:2rem;">2. Настройки объекта:</h4>
				{#if selectedTypeDef}
					<div class="config-section">
						<div class="config-grid">
							<label class="cfg-check">
								<input type="checkbox" bind:checked={editConfig.features.hierarchy} /> Иерархия (группы/папки)
							</label>
							<label class="cfg-check">
								<input type="checkbox" bind:checked={editConfig.features.copy} /> Копирование
							</label>
							<label class="cfg-check">
								<input type="checkbox" bind:checked={editConfig.features.print} /> Печать
							</label>
							<label class="cfg-check">
								<input type="checkbox" bind:checked={editConfig.features.tabularSections} /> Табличные части
							</label>
						</div>

						{#if selectedTypeDef.statuses.length > 1}
							<div class="cfg-status-readonly">
								<span class="cfg-label">Статусы «только чтение»:</span>
								{#each selectedTypeDef.statuses as st}
									<label class="cfg-check">
										<input type="checkbox" bind:checked={editConfig.statusReadOnly[st.value]} /> {st.icon} {st.label}
									</label>
								{/each}
							</div>
						{/if}

						<div class="cfg-actions-bar">
							<button onclick={saveConfig} class="btn-blue" disabled={configSaving}>
								{configSaving ? '⏳ Сохранение...' : '💾 Сохранить настройки'}
							</button>
						</div>
					</div>
				{/if}

				<!-- 3. Табличные части — вкладки -->
				<h4 style="margin-top:2rem;">3. Табличные части:</h4>

				<div class="sub-tabs-bar">
					{#each subTables as sub, i}
						<button class="sub-tab" class:active={activeSubIndex === i} onclick={() => activeSubIndex = i}>
							{sub.title}
						</button>
					{/each}
					<button class="sub-tab add-tab" onclick={() => activeSubIndex = subTables.length}>+</button>
				</div>

				{#if activeSubIndex < subTables.length}
					{@const sub = subTables[activeSubIndex]}
					{@const subCols = subTableColumns.get(sub.id) ?? []}
					<div class="sub-tab-content">
						<div class="sub-tab-header">
							<strong>{sub.title}</strong> <span>[{sub.name ?? sub.id.slice(0, 8)}]</span>
							<button onclick={() => handleDeleteSubTable(sub.id)} class="btn-icon-del" title="Удалить ТЧ">🗑️</button>
						</div>

						<table class="config-table" border="1">
							<thead>
								<tr><th>Имя</th><th>Заголовок</th><th>Тип реквизита</th><th style="width:80px;">Действия</th></tr>
							</thead>
							<tbody>
								{#each subCols as col}
									<tr class:editing-row={editingColId === col.id}>
										<td>{col.name}</td>
										<td>{col.title}</td>
										<td>{col.type}</td>
										<td class="text-center">
											<button onclick={() => handleEditColumn(col)} class="btn-icon-edit" title="Редактировать реквизит">✏️</button>
											<button onclick={() => handleDeleteColumn(col.id)} class="btn-icon-del" title="Удалить реквизит">❌</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>

						<div class="add-main-column-zone">
							<input aria-label="Имя поля ТЧ" type="text" bind:value={newColName} placeholder="Имя реквизита" />
							<input aria-label="Синоним поля ТЧ" type="text" bind:value={newColTitle} placeholder="Синоним" />
							<select aria-label="Тип поля ТЧ" bind:value={newColType}>
								{#each fieldTypeList as ft}
									<option value={ft.type}>{ft.label}</option>
								{/each}
							</select>
							{#if newColType === 'link'}
								<LinkConfig bind:relatedTableId={newColRelatedTableId} {allTables} />
							{/if}
							<button onclick={() => handleAddColumn(sub.id)} class="btn-blue">
								{editingColId && editingTargetTableId === sub.id ? '💾 Сохранить' : '➕ Добавить в ТЧ'}
							</button>
							{#if editingColId && editingTargetTableId === sub.id}
								<button onclick={handleCancelEdit} class="btn-cancel">Отмена</button>
							{/if}
						</div>
					</div>
				{:else}
					<div class="create-subtable-zone">
						<h5>➕ Добавить новую Табличную Часть:</h5>
						<div class="flex-inputs">
							<input aria-label="Имя новой ТЧ" type="text" bind:value={newSubName} placeholder="Имя ТЧ (e.g., contacts)" />
							<input aria-label="Синоним новой ТЧ" type="text" bind:value={newSubTitle} placeholder="Синоним ТЧ (e.g., Контакты)" />
							<button onclick={handleCreateSubTable} class="btn-blue">Создать ТЧ</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
<style>
	.configurator-layout { display: flex; gap: 1.5rem; padding: 1rem; box-sizing: border-box; height: 100%; overflow-y: auto; background-color: #f1f5f9; }
	.meta-creator-box { flex: 1; border: 1px solid #cbd5e1; padding: 1rem; border-radius: 6px; background: #ffffff; height: fit-content; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
	.meta-editor-box { flex: 2; border: 1px solid #cbd5e1; padding: 1rem; border-radius: 6px; background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
	h3 { margin-top: 0; color: #1e293b; font-size: 1.1rem; }
	h4 { color: #334155; margin-bottom: 0.5rem; font-size: 0.95rem; }
	h5 { margin: 0 0 8px 0; color: #475569; font-size: 0.85rem; }
	.divider { border: 0; border-top: 1px solid #e2e8f0; margin: 12px 0; }
	.field-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
	.field-group label { font-size: 0.8rem; font-weight: 600; color: #475569; }
	input, select { padding: 5px 8px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 0.85rem; outline: none; }
	input:focus, select:focus { border-color: #3b82f6; }
	.btn-submit { background: #16a34a; color: white; border: none; padding: 7px; border-radius: 4px; cursor: pointer; font-weight: 500; font-size: 0.85rem; width: 100%; }
	.btn-submit:hover { background: #15803d; }
	.btn-blue { background: #2563eb; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; font-weight: 500; white-space: nowrap; }
	.btn-blue:hover { background: #1d4ed8; }

	.config-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 1rem; }
	.config-table th { background: #f8fafc; border: 1px solid #cbd5e1; padding: 6px; text-align: left; }
	.config-table td { border: 1px solid #e2e8f0; padding: 6px; color: #334155; }
	.text-center { text-align: center; }
	.btn-icon-del, .btn-icon-edit { background: none; border: none; cursor: pointer; font-size: 0.9rem; padding: 2px 4px; }
	.btn-icon-del:hover { opacity: 0.6; }
	.btn-icon-edit:hover { opacity: 0.6; }
	.editing-row { background-color: #fef9c3 !important; }
	.btn-cancel { background: #e2e8f0; color: #475569; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }

	.add-main-column-zone { display: flex; gap: 6px; align-items: center; background: #f8fafc; padding: 8px; border-radius: 4px; border: 1px solid #e2e8f0; flex-wrap: wrap; }
	.add-main-column-zone input, .add-main-column-zone select { flex: 1; min-width: 100px; }

	.sub-tabs-bar { display: flex; gap: 2px; border-bottom: 2px solid #cbd5e1; margin-bottom: 0.5rem; flex-wrap: wrap; }
	.sub-tab { background: #f1f5f9; border: 1px solid #cbd5e1; border-bottom: none; padding: 6px 14px; font-size: 0.8rem; cursor: pointer; color: #475569; border-radius: 4px 4px 0 0; }
	.sub-tab.active { background: #ffffff; border-bottom: 2px solid #2563eb; color: #1e3a8a; font-weight: 600; }
	.sub-tab.add-tab { background: none; border: 1px dashed #94a3b8; color: #64748b; font-weight: 700; font-size: 1rem; padding: 6px 12px; }
	.sub-tab.add-tab:hover { background: #f0fdf4; border-color: #16a34a; color: #16a34a; }

	.sub-tab-content { border: 1px solid #e2e8f0; padding: 10px; border-radius: 4px; background: #fafafa; }
	.sub-tab-header { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; margin-bottom: 8px; }
	.sub-tab-header span { color: #64748b; font-size: 0.75rem; }
	.sub-tab-header .btn-icon-del { margin-left: auto; }

	.create-subtable-zone { border: 1px dashed #cbd5e1; padding: 12px; border-radius: 4px; background: #f8fafc; }
	.flex-inputs { display: flex; gap: 6px; }
	.flex-inputs input { flex: 1; }

	.config-section { border: 1px solid #e2e8f0; padding: 10px 12px; border-radius: 4px; background: #fafafa; margin-bottom: 1.5rem; }
	.config-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
	.cfg-check { display: flex; align-items: center; gap: 4px; font-size: 0.85rem; cursor: pointer; color: #334155; }
	.cfg-check input { width: auto; }
	.cfg-status-readonly { border-top: 1px solid #e2e8f0; padding-top: 8px; margin-bottom: 8px; }
	.cfg-label { font-size: 0.8rem; font-weight: 600; color: #475569; display: block; margin-bottom: 4px; }
	.cfg-actions-bar { border-top: 1px solid #e2e8f0; padding-top: 8px; }
	.type-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
	.type-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; background: #f8fafc; border-radius: 4px; font-size: 0.8rem; }
	.type-badge { font-weight: 600; color: #1e293b; }
	.type-code { color: #64748b; font-size: 0.75rem; }
	.type-meta { color: #94a3b8; font-size: 0.7rem; margin-left: auto; }
	.btn-icon-del-sm { background: none; border: none; cursor: pointer; color: #ef4444; font-size: 0.8rem; padding: 0 4px; }
	.btn-icon-del-sm:hover { color: #dc2626; }
</style>
