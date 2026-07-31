<script lang="ts">
	import { db, type LocalColumn, type LocalRecord, type LocalTable } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { numberService } from '$lib/services/numbers';
	import { printerService } from '$lib/services/printer';
	import { getTableType, getEffectiveConfig } from '$lib/table-types';
	import { formatFieldValue } from '$lib/fields';
	import { physicalDeleteRecords } from '$lib/services/records';
	import { runActionCode, saveRecordWithLines } from '$lib/services/actionRunner';
	import { supabase } from '$lib/db/supabase';
	import { liveQuery } from 'dexie';
	import Toolbar from './Toolbar.svelte';

	let { tableId, tabId = '' } = $props();

	let tableMeta = $state<LocalTable | null>(null);
	let columns = $state<LocalColumn[]>([]);
	let records = $state<LocalRecord[]>([]);
	let selectedIds = $state<string[]>([]);
	let loading = $state(false);

	let currentFolderId = $state<string | null>(null);

	let sortField = $state<string>('number');
	let sortDirection = $state<'asc' | 'desc'>('asc');

	let tableType = $derived(tableMeta?.type ?? 'document');
	let tableTypeDef = $derived(getTableType(tableType));
	let isHierarchical = $derived(getEffectiveConfig(tableMeta).features.hierarchy);

	// Для констант: автоматически создаём единственную запись и открываем её форму.
	// Подавление повторного открытия живёт в workspace (переживает перемонтирование списка).
	$effect(() => {
		if (tableType !== 'constant' || workspace.isConstantAutoOpenSuppressed(tableId)) return;
		if (!tableMeta || loading) return;
		if (records.length === 0) {
			db.data_records.put({
				id: crypto.randomUUID(),
				table_id: tableId,
				status: 'draft',
				is_folder: false,
				parent_id: null,
				data: { value: '' },
				is_dirty: 1,
				updated_at: new Date().toISOString()
			});
		} else {
			workspace.suppressConstantAutoOpen(tableId);
			const record = records[0];
			const name = tableMeta?.title ?? 'Константа';
			workspace.openForm(tableId, record.id, name);
		}
	});

	$effect(() => {
		loading = true;
		db.meta_tables.get(tableId).then((meta) => {
			tableMeta = meta ?? null;
		});

		const colObservable = liveQuery(async () => {
			const allCols = await db.meta_columns.where('table_id').equals(tableId).sortBy('sort_order');
			return allCols.filter((col) => col.is_visible !== false);
		});
		const colSub = colObservable.subscribe({
			next: (data) => {
				columns = data;
			},
			error: (err) => console.error('Ошибка загрузки колонок:', err)
		});

		const recObservable = liveQuery(() =>
			db.data_records.where('table_id').equals(tableId).toArray()
		);
		const recSub = recObservable.subscribe({
			next: (data) => {
				records = data;
				loading = false;
			},
			error: (err) => {
				console.error('Ошибка загрузки записей:', err);
				loading = false;
			}
		});

		return () => {
			colSub.unsubscribe();
			recSub.unsubscribe();
		};
	});

	let filteredAndSortedRecords = $derived.by(() => {
		const currentLevelRecords = records.filter((r) =>
			isHierarchical
				? currentFolderId === null
					? r.parent_id == null
					: r.parent_id === currentFolderId
				: true
		);

		return currentLevelRecords.sort((a, b) => {
			if (isHierarchical) {
				if (a.is_folder && !b.is_folder) return -1;
				if (!a.is_folder && b.is_folder) return 1;
			}

			let valA = a.data[sortField] ?? '';
			let valB = b.data[sortField] ?? '';

			if (typeof valA === 'string') valA = valA.toLowerCase();
			if (typeof valB === 'string') valB = valB.toLowerCase();

			if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
			if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
			return 0;
		});
	});

	function changeSort(fieldName: string) {
		if (sortField === fieldName) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = fieldName;
			sortDirection = 'asc';
		}
	}

	async function handleAction(actionId: string) {
		switch (actionId) {
			case 'create':
				workspace.openForm(tableId, 'new', tableMeta?.title ?? '');
				break;
			case 'createFolder':
				await handleCreateFolder();
				break;
			case 'moveUp':
				await handleMoveUp();
				break;
			case 'massPost':
				await handleMassPost();
				break;
			case 'massDelete':
				await handleMassDelete();
				break;
			case 'massRestore':
				await handleMassRestore();
				break;
			case 'purgeMarked':
				await handlePurgeMarked();
				break;
			case 'delete':
				await handleDeleteSelected();
				break;
			case 'copy':
				await handleCopy();
				break;
			case 'print':
				handleListPrint();
				break;
			case 'run':
				await handleRun();
				break;
		}
	}

	async function handleCreateFolder() {
		const folderName = prompt('Введите наименование новой группы (папки):');
		if (!folderName) return;

		await db.data_records.put({
			id: crypto.randomUUID(),
			table_id: tableId,
			status: 'draft',
			is_folder: true,
			parent_id: currentFolderId,
			data: { name: folderName, number: 'ПАПКА' },
			is_dirty: 1,
			updated_at: new Date().toISOString()
		});
		selectedIds = [];
	}

	async function handleMoveUp() {
		if (!currentFolderId) return;
		const folderRecord = await db.data_records.get(currentFolderId);
		currentFolderId = (folderRecord?.parent_id as string | null) ?? null;
		selectedIds = [];
	}

	async function handleCopy() {
		if (selectedIds.length !== 1) return alert('Выберите один элемент');
		const sourceId = selectedIds[0];
		const sourceRecord = await db.data_records.get(sourceId);
		if (!sourceRecord || sourceRecord.is_folder) return alert('Папки копировать нельзя');

		const sourceLines = await db.data_lines.where('record_id').equals(sourceId).toArray();
		const newRecordId = crypto.randomUUID();
		const prefix =
			tableMeta?.title?.includes('Накладная') || tableMeta?.title?.includes('Реализация')
				? 'РН-'
				: 'СП-';
		const nextFreeNumber = await numberService.getNextNumber(tableId, prefix);

		const newRecordData = {
			...sourceRecord.data,
			number: nextFreeNumber,
			date: new Date().toISOString().split('T')[0]
		};

		await db.transaction('rw', [db.data_records, db.data_lines], async () => {
			await db.data_records.put({
				id: newRecordId,
				table_id: tableId,
				status: 'draft',
				is_folder: false,
				parent_id: currentFolderId,
				data: newRecordData,
				is_dirty: 1,
				updated_at: new Date().toISOString()
			});
			for (const line of sourceLines) {
				await db.data_lines.put({
					id: crypto.randomUUID(),
					record_id: newRecordId,
					table_id: tableId,
					data: { ...line.data },
					sort_order: line.sort_order
				});
			}
		});

		workspace.openForm(tableId, newRecordId, tableMeta?.title ?? '', nextFreeNumber);
		selectedIds = [];
	}

	async function handleMassPost() {
		if (selectedIds.length === 0) return alert('Выберите строки');
		let skippedCount = 0;
		await db.transaction('rw', [db.data_records], async () => {
			for (const id of selectedIds) {
				const rec = await db.data_records.get(id);
				if (rec && (rec.status === 'marked_for_deletion' || rec.is_folder)) {
					skippedCount++;
					continue;
				}
				if (rec) await db.data_records.update(id, { status: 'posted', is_dirty: 1 });
			}
		});
		if (skippedCount > 0) alert(`Успешно. Пропущено папок или удаленных: ${skippedCount}`);
		selectedIds = [];
	}

	async function handleMassDelete() {
		if (selectedIds.length === 0) return alert('Выберите строки');
		await db.transaction('rw', [db.data_records], async () => {
			for (const id of selectedIds)
				await db.data_records.update(id, { status: 'marked_for_deletion', is_dirty: 1 });
		});
		selectedIds = [];
	}

	async function handleMassRestore() {
		if (selectedIds.length === 0) return alert('Выберите строки');
		await db.transaction('rw', [db.data_records], async () => {
			for (const id of selectedIds) {
				const rec = await db.data_records.get(id);
				if (rec && rec.status === 'marked_for_deletion')
					await db.data_records.update(id, { status: 'draft', is_dirty: 1 });
			}
		});
		selectedIds = [];
	}

	// Безвозвратное удаление записей, помеченных на удаление (как «Удаление помеченных объектов» в 1С)
	async function handlePurgeMarked() {
		const deletedStatus = tableTypeDef.statuses.find((s) => s.role === 'deleted')?.value;
		if (!deletedStatus) return;
		const marked = records.filter((r) => r.status === deletedStatus);
		if (marked.length === 0) return alert('Нет записей, помеченных на удаление');
		if (!confirm(`Безвозвратно удалить ${marked.length} записей?`)) return;
		try {
			await physicalDeleteRecords(marked.map((r) => r.id));
		} catch (e: any) {
			alert(`Ошибка удаления: ${e?.message ?? e}`);
			return;
		}
		for (const r of marked) workspace.closeTabForce(`form_${tableId}_${r.id}`);
		selectedIds = [];
	}

	// Физическое удаление выбранных записей (без пометки) — для типов с фичей delete
	async function handleDeleteSelected() {
		if (selectedIds.length === 0) return alert('Выберите строки');
		if (!confirm(`Безвозвратно удалить ${selectedIds.length} записей?`)) return;
		try {
			await physicalDeleteRecords(selectedIds);
		} catch (e: any) {
			alert(`Ошибка удаления: ${e?.message ?? e}`);
			return;
		}
		for (const id of selectedIds) workspace.closeTabForce(`form_${tableId}_${id}`);
		selectedIds = [];
	}

	function handleListPrint() {
		const cleanIds = filteredAndSortedRecords
			.filter((r) => selectedIds.includes(r.id) && !r.is_folder)
			.map((r) => r.id);
		if (cleanIds.length === 0) return alert('Выберите документы для печати (папки не печатаются)');
		printerService.printRecords(tableId, cleanIds);
	}

	// ▶️ Выполнить: запуск пользовательского JS-кода по выбранным записям
	async function handleRun() {
		const code = tableMeta?.config?.runCode;
		if (!code?.trim())
			return alert('Код действия не задан. Откройте конфигуратор таблицы → «Выполнить (JS-код)».');
		if (selectedIds.length === 0) return alert('Выберите строки');
		const selected = records.filter((r) => selectedIds.includes(r.id));
		try {
			await runActionCode(code, {
				record: selected[0] ?? null,
				records: selected,
				lines: [],
				db,
				supabase,
				save: saveRecordWithLines,
				log: (...args) => console.log('[Выполнить]', ...args)
			});
		} catch (e: any) {
			alert(`Ошибка выполнения кода: ${e?.message ?? e}`);
		}
	}

	function toggleSelect(id: string) {
		selectedIds = selectedIds.includes(id)
			? selectedIds.filter((item) => item !== id)
			: [...selectedIds, id];
	}

	function toggleAll() {
		selectedIds =
			selectedIds.length === filteredAndSortedRecords.length
				? []
				: filteredAndSortedRecords.map((r) => r.id);
	}
</script>

<div class="list-container">
	<Toolbar mode="list" {tableId} onAction={handleAction} />

	{#if isHierarchical}
		<div class="hierarchy-breadcrumbs">
			<button
				onclick={() => {
					currentFolderId = null;
					selectedIds = [];
				}}
				class="btn-crumb">📁 Корень каталога</button
			>
			{#if currentFolderId}
				<button onclick={handleMoveUp} class="btn-move-up">⬆️ На уровень вверх</button>
				<button onclick={handleCreateFolder} class="btn-add-folder">📁 Создать подгруппу</button>
			{:else}
				<button onclick={handleCreateFolder} class="btn-add-folder"
					>📁 Создать группу (папку)</button
				>
			{/if}
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">Загрузка журнала...</div>
	{:else}
		<div class="table-wrapper">
			<table class="erp-table">
				<thead>
					<tr>
						<th style="width: 40px; text-align:center;">
							<input
								type="checkbox"
								checked={selectedIds.length === filteredAndSortedRecords.length &&
									filteredAndSortedRecords.length > 0}
								onchange={toggleAll}
							/>
						</th>
						<th class="th-status">Статус</th>
						{#each columns as col}
							<th onclick={() => changeSort(col.name)} class="sortable-th">
								<div class="th-content">
									{col.title}
									{#if sortField === col.name}
										<span class="sort-arrow">{sortDirection === 'asc' ? ' ▴' : ' ▾'}</span>
									{/if}
								</div>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#if filteredAndSortedRecords.length === 0}
						<tr
							><td colSpan={columns.length + 2} class="empty-row">В этой папке нет элементов.</td
							></tr
						>
					{:else}
						{#each filteredAndSortedRecords as record (record.id)}
							<tr
								class="data-row"
								class:selected={selectedIds.includes(record.id)}
								class:deleted={record.status === 'marked_for_deletion'}
								class:folder-row={record.is_folder}
								ondblclick={() => {
									if (record.is_folder && isHierarchical) {
										currentFolderId = record.id;
										selectedIds = [];
									} else {
										workspace.openForm(
											tableId,
											record.id,
											tableMeta?.title ?? '',
											record.data.number || record.data.name
										);
									}
								}}
							>
								<td style="text-align:center;" onclick={(e) => e.stopPropagation()}>
									<input
										type="checkbox"
										checked={selectedIds.includes(record.id)}
										onchange={() => toggleSelect(record.id)}
									/>
								</td>
								<td class="td-status-icon" onclick={() => toggleSelect(record.id)}>
									{#if record.is_folder}📁
									{:else if record.status === 'posted'}🟢
									{:else if record.status === 'marked_for_deletion'}❌
									{:else}⚪{/if}
								</td>
								{#each columns as col}
									<td onclick={() => toggleSelect(record.id)} class:bold-text={record.is_folder}>
										{formatFieldValue(col.type, record.data[col.name])}
									</td>
								{/each}
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.list-container {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.hierarchy-breadcrumbs {
		background: #f8fafc;
		border-bottom: 1px solid #cbd5e1;
		padding: 6px 12px;
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.btn-crumb {
		background: none;
		border: none;
		font-size: 0.85rem;
		font-weight: 600;
		color: #1e40af;
		cursor: pointer;
	}
	.btn-move-up,
	.btn-add-folder {
		background: #ffffff;
		border: 1px solid #cbd5e1;
		font-size: 0.8rem;
		padding: 3px 10px;
		border-radius: 4px;
		cursor: pointer;
	}
	.btn-move-up:hover,
	.btn-add-folder:hover {
		background: #f1f5f9;
	}
	.table-wrapper {
		flex: 1;
		overflow: auto;
	}
	.erp-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
		text-align: left;
	}
	.erp-table th {
		background-color: #f1f5f9;
		color: #475569;
		font-weight: 600;
		border-right: 1px solid #cbd5e1;
		border-bottom: 2px solid #cbd5e1;
		padding: 6px 8px;
		position: sticky;
		top: 0;
		user-select: none;
	}
	.sortable-th {
		cursor: pointer;
	}
	.sortable-th:hover {
		background-color: #e2e8f0;
		color: #1e3a8a;
	}
	.th-content {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.sort-arrow {
		color: #2563eb;
		font-weight: bold;
		font-size: 0.9rem;
	}
	.th-status {
		width: 60px;
		text-align: center;
	}
	.erp-table td {
		border-right: 1px solid #e2e8f0;
		border-bottom: 1px solid #e2e8f0;
		padding: 6px 8px;
		color: #334155;
		white-space: nowrap;
	}
	.data-row {
		cursor: pointer;
	}
	.data-row:hover {
		background-color: #f8fafc;
	}
	.data-row.selected {
		background-color: #e0e7ff !important;
	}
	.data-row.deleted {
		color: #94a3b8;
		text-decoration: line-through;
	}
	.folder-row {
		background-color: #fefcf0;
	}
	.bold-text {
		font-weight: 700;
		color: #1e293b !important;
	}
	.td-status-icon {
		text-align: center;
		font-size: 0.75rem;
	}
	.empty-row {
		text-align: center;
		color: #94a3b8;
		padding: 2rem !important;
	}
	.loading-state {
		padding: 2rem;
		color: #64748b;
		text-align: center;
	}
</style>
