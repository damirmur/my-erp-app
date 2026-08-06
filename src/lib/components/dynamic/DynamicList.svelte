<script lang="ts">
	import { db, type LocalColumn, type LocalRecord, type LocalTable } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { numberService } from '$lib/services/numbers';
	import { printerService } from '$lib/services/printer';
	import { getTableType, getEffectiveConfig, findParentColumn } from '$lib/table-types';
	import { formatFieldValue } from '$lib/fields';
	import { physicalDeleteRecords } from '$lib/services/records';
	import { runRecordAction, mergeParams } from '$lib/services/actionRunner';
	import { metadata } from '$lib/state/metadata';
	import { buildExecuteUrl, buildRecordUrl, fullUrlFor } from '$lib/services/deeplink';
	import { liveQuery } from 'dexie';
	import Toolbar from './Toolbar.svelte';
	import './erpTable.css';

	let { tableId, tabId = '' } = $props();

	const isCoarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

	let tableMeta = $state<LocalTable | null>(null);
	let allColumns = $state<LocalColumn[]>([]);
	let columns = $derived(allColumns.filter((col) => col.is_visible !== false));
	let records = $state<LocalRecord[]>([]);
	let selectedIds = $state<string[]>([]);
	let openMenuId = $state<string | null>(null);
	let loading = $state(false);

	let currentFolderId = $state<string | null>(null);

	// Режим показа иерархического списка: 'groups' — по группам (как сейчас),
	// 'all' — развёрнутый список всех записей справочника.
	let viewMode = $state<'groups' | 'all'>('groups');

	let sortField = $state<string>('number');
	let sortDirection = $state<'asc' | 'desc'>('asc');

	let tableType = $derived(tableMeta?.type ?? 'document');
	let tableTypeDef = $derived(getTableType(tableType));
	let isHierarchical = $derived(getEffectiveConfig(tableMeta).features.hierarchy);

	// Колонка «Родитель» (ссылка на саму таблицу): задаёт группу в форме иерархического справочника
	let parentColumnName = $derived(findParentColumn(allColumns, tableId)?.name ?? null);

	// Системные таблицы (например, история действий) по умолчанию сортируем
	// по дате открытия от новых к старым, а не по колонке "number".
	$effect(() => {
		if (tableMeta?.type === 'system' && sortField === 'number' && allColumns.length > 0) {
			sortField = allColumns.some((c) => c.name === 'opened_at')
				? 'opened_at'
				: (allColumns[0]?.name ?? 'number');
			sortDirection = 'desc';
		}
	});

	// Для констант: автоматически создаём единственную запись и открываем её форму.
	// Подавление повторного открытия живёт в workspace (переживает перемонтирование списка).
	// Таблицы с config.manyRecords — «одна таблица, много констант»: ведут себя как
	// обычный список (записи добавляются кнопкой ➕ Создать), автозапись не создаём.
	$effect(() => {
		if (tableType !== 'constant' || tableMeta?.config?.manyRecords) return;
		if (workspace.isConstantAutoOpenSuppressed(tableId)) return;
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
			return await db.meta_columns.where('table_id').equals(tableId).sortBy('sort_order');
		});
		const colSub = colObservable.subscribe({
			next: (data) => {
				allColumns = data;
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

	// ID всех папок: записи, родитель которых не папка (осиротевшие/недоступные),
	// показываем в корне, чтобы они никогда не пропадали из списка.
	let folderIds = $derived(new Set(records.filter((r) => r.is_folder).map((r) => r.id)));

	let filteredAndSortedRecords = $derived.by(() => {
		const currentLevelRecords = records.filter((r) => {
			if (!isHierarchical || viewMode === 'all') return true;
			// Родитель хранится в parent_id (папки) и/или в колонке-ссылке «Родитель» (форма).
			const parentValue = parentColumnName ? r.data?.[parentColumnName] || null : null;
			const parentId = r.parent_id ?? parentValue;
			if (currentFolderId === null) {
				return parentId == null || !folderIds.has(parentId);
			}
			return parentId === currentFolderId;
		});

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

	// Для link-колонок значение в данных — id записи; в ячейках списка показываем
	// наименование связанной записи (прекомпьютим мапу id → name текущих строк).
	// Для linelink-колонок id указывает на строку ТЧ (data_lines) — её заголовок
	// берём из данных строки.
	let linkDisplay = $state<Record<string, string>>({});

	function lineTitle(line: { data?: Record<string, any> } | undefined): string {
		const d = line?.data ?? {};
		if (d.name != null && String(d.name) !== '') return String(d.name);
		if (d.number != null && String(d.number) !== '') return String(d.number);
		for (const v of Object.values(d)) {
			if (v != null && String(v) !== '') return String(v);
		}
		return '…';
	}

	$effect(() => {
		const linkCols = columns.filter(
			(c) =>
				c.type === 'link' ||
				c.type === 'linelink' ||
				(c.type === 'universal' && records.some((r) => r.data?.[c.name]?.t === 'link'))
		);
		if (linkCols.length === 0) {
			linkDisplay = {};
			return;
		}
		const ids = new Set<string>();
		const lineIds = new Set<string>();
		for (const col of linkCols) {
			for (const r of filteredAndSortedRecords) {
				const v = r.data?.[col.name];
				if (col.type === 'linelink') {
					if (v && typeof v === 'string') lineIds.add(v);
					continue;
				}
				const id = col.type === 'link' ? v : v?.t === 'link' ? v?.v : null;
				if (id && typeof id === 'string') ids.add(id);
			}
		}
		const idArr = [...ids];
		db.data_records
			.bulkGet(idArr)
			.then((rows) => {
				const map: Record<string, string> = {};
				for (const col of linkCols) {
					if (col.type === 'linelink') continue;
					for (const r of filteredAndSortedRecords) {
						const v = r.data?.[col.name];
						const id = col.type === 'link' ? v : v?.t === 'link' ? v?.v : null;
						if (!id) continue;
						map[`${col.id}:${id}`] = rows.find((row) => row?.id === id)?.data?.name ?? String(id);
					}
				}
				linkDisplay = map;
			})
			.catch(() => {});
		if (lineIds.size > 0) {
			const lineIdArr = [...lineIds];
			db.data_lines
				.bulkGet(lineIdArr)
				.then((lines) => {
					const map: Record<string, string> = {};
					for (const col of linkCols) {
						if (col.type !== 'linelink') continue;
						for (const r of filteredAndSortedRecords) {
							const id = r.data?.[col.name];
							if (!id || typeof id !== 'string') continue;
							map[`${col.id}:${id}`] = lineTitle(lines.find((l) => l?.id === id));
						}
					}
					linkDisplay = { ...linkDisplay, ...map };
				})
				.catch(() => {});
		}
	});

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

		const folderData: Record<string, any> = { name: folderName, number: 'ПАПКА' };
		if (parentColumnName && currentFolderId) folderData[parentColumnName] = currentFolderId;

		await db.data_records.put({
			id: crypto.randomUUID(),
			table_id: tableId,
			status: 'draft',
			is_folder: true,
			parent_id: currentFolderId,
			data: folderData,
			is_dirty: 1,
			updated_at: new Date().toISOString()
		});
		selectedIds = [];
	}

	// Переименование группы (папки): у папок нет формы, имя меняем прямо в списке.
	async function handleRenameFolder(record: LocalRecord) {
		const currentName = record.data?.name ?? '';
		const folderName = prompt('Новое наименование группы (папки):', currentName);
		if (folderName === null || folderName.trim() === '') return;
		await db.data_records.update(record.id, {
			data: { ...record.data, name: folderName.trim() },
			is_dirty: 1
		});
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

		const newRecordData: Record<string, any> = {
			...sourceRecord.data,
			number: nextFreeNumber,
			date: new Date().toISOString().split('T')[0]
		};
		if (parentColumnName) newRecordData[parentColumnName] = currentFolderId ?? '';

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

	// ▶️ Выполнить: код действия по выбранным записям (или декларативный вызов
	// API-сервиса, если код не задан). Результат — в панели «API».
	async function handleRun() {
		if (selectedIds.length === 0) return alert('Выберите строки');
		const selected = records.filter((r) => selectedIds.includes(r.id));
		const result = await runRecordAction(selected[0]?.id ?? '', mergeParams(selected[0] ?? null));
		if (selected.length === 1 && selected[0]) {
			// Панель «API» — только при ошибке или реальном результате
			if (!result.ok || result.value !== undefined) {
				const num = selected[0].data?.number || selected[0].data?.name;
				workspace.showApiResult({
					href: buildExecuteUrl(selected[0].id),
					label: `${tableMeta?.title ?? ''} №${num || '…'} · Выполнить`,
					ok: result.ok,
					value: result.ok ? result.value : undefined,
					error: result.error,
					executedAt: new Date().toISOString()
				});
			}
		}
	}

	// Ячейка считается ссылкой, если значение начинается с http:// или https://
	function isHttpUrl(value: unknown): value is string {
		return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
	}

	// Форматирование ячейки списка. Для системных таблиц колонка opened_at хранит
	// полную ISO-метку (в Supabase нет enum datetime), показываем её как дату/время.
	function formatCell(col: LocalColumn, record: LocalRecord): string {
		const raw = record.data?.[col.name];
		if (tableMeta?.type === 'system' && col.name === 'opened_at' && raw) {
			const d = new Date(raw);
			if (!isNaN(d.getTime())) {
				return new Intl.DateTimeFormat(undefined, {
					dateStyle: 'short',
					timeStyle: 'short'
				}).format(d);
			}
		}
		// Ссылка хранит id записи — показываем наименование связанной записи
		if (col.type === 'link' && raw) {
			return linkDisplay[`${col.id}:${raw}`] ?? String(raw);
		}
		// Ссылка на строку ТЧ: значение — id строки data_lines
		if (col.type === 'linelink' && raw) {
			return linkDisplay[`${col.id}:${raw}`] ?? String(raw);
		}
		// Универсальное поле: если в записи выбран тип «Ссылка» — то же поведение
		if (col.type === 'universal' && raw?.t === 'link' && raw.v) {
			return linkDisplay[`${col.id}:${raw.v}`] ?? String(raw.v);
		}
		return formatFieldValue(col.type, raw);
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

	async function copyRecordLink(record: LocalRecord) {
		const url = fullUrlFor(buildRecordUrl(record.id));
		try {
			await navigator.clipboard.writeText(url);
			alert('Ссылка на запись скопирована: ' + url);
		} catch {
			alert('Не удалось скопировать ссылку: ' + url);
		}
	}

	function openRecord(record: LocalRecord) {
		// Системные таблицы (например, история): запись ведёт на исходный объект
		// через сохранённую ссылку, а не открывается как обычная форма.
		if (tableMeta?.type === 'system') {
			const link = record.data?.link;
			if (typeof link === 'string' && link) workspace.openFromLink(link);
			return;
		}

		if (record.is_folder && isHierarchical) {
			// В развёрнутом списке клик по папке переключает в режим «По группам» и открывает её
			if (viewMode === 'all') viewMode = 'groups';
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
	}

	async function postRecord(id: string) {
		await db.data_records.update(id, { status: 'posted', is_dirty: 1 });
		selectedIds = selectedIds.filter((i) => i !== id);
	}

	async function markForDeletion(id: string) {
		await db.data_records.update(id, { status: 'marked_for_deletion', is_dirty: 1 });
		selectedIds = selectedIds.filter((i) => i !== id);
	}

	async function restoreRecord(id: string) {
		await db.data_records.update(id, { status: 'draft', is_dirty: 1 });
		selectedIds = selectedIds.filter((i) => i !== id);
	}

	async function deleteRecord(id: string) {
		if (!confirm('Безвозвратно удалить запись?')) return;
		try {
			await physicalDeleteRecords([id]);
		} catch (e: any) {
			alert(`Ошибка удаления: ${e?.message ?? e}`);
			return;
		}
		workspace.closeTabForce(`form_${tableId}_${id}`);
		selectedIds = selectedIds.filter((i) => i !== id);
	}

	// Закрытие меню ⋮ при клике в любом месте вне кнопок меню.
	$effect(() => {
		if (!openMenuId) return;
		const close = () => (openMenuId = null);
		document.addEventListener('click', close);
		return () => document.removeEventListener('click', close);
	});
</script>

<div class="list-container">
	<Toolbar
		mode="list"
		{tableId}
		onAction={handleAction}
		columns={allColumns}
		onToggleColumn={async (colId: string, visible: boolean) => {
			await metadata.setColumnVisibility(colId, visible);
		}}
	/>

	{#if isHierarchical}
		<div class="hierarchy-breadcrumbs">
			{#if viewMode === 'groups'}
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
			{/if}
			<div class="hierarchy-view-toggle">
				<button
					class="view-toggle-btn"
					class:active={viewMode === 'groups'}
					onclick={() => {
						viewMode = 'groups';
					}}>По группам</button
				>
				<button
					class="view-toggle-btn"
					class:active={viewMode === 'all'}
					onclick={() => {
						viewMode = 'all';
						currentFolderId = null;
						selectedIds = [];
					}}>Все</button
				>
			</div>
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
						<th class="th-actions" title="Действия"></th>
					</tr>
				</thead>
				<tbody>
					{#if filteredAndSortedRecords.length === 0}
						<tr
							><td colSpan={columns.length + 3} class="empty-row">В этой папке нет элементов.</td
							></tr
						>
					{:else}
						{#each filteredAndSortedRecords as record (record.id)}
							<tr
								class="data-row"
								class:selected={selectedIds.includes(record.id)}
								class:deleted={record.status === 'marked_for_deletion'}
								class:folder-row={record.is_folder}
								onclick={() => isCoarse && openRecord(record)}
								ondblclick={() => !isCoarse && openRecord(record)}
							>
								<td style="text-align:center;" onclick={(e) => e.stopPropagation()}>
									<input
										type="checkbox"
										checked={selectedIds.includes(record.id)}
										onchange={() => toggleSelect(record.id)}
									/>
								</td>
								<td
									class="td-status-icon"
									onclick={() => {
										if (!isCoarse) toggleSelect(record.id);
									}}
								>
									{#if record.is_folder}📁
									{:else if record.status === 'posted'}🟢
									{:else if record.status === 'marked_for_deletion'}❌
									{:else}⚪{/if}
								</td>
								{#each columns as col}
									<td
										onclick={() => {
											if (!isCoarse) toggleSelect(record.id);
										}}
										class:bold-text={record.is_folder}
									>
										{#if isHttpUrl(record.data[col.name])}
											<a
												href={record.data[col.name]}
												target="_blank"
												rel="noopener noreferrer"
												class="cell-link"
												onclick={(e) => e.stopPropagation()}
												title="Открыть ссылку">{formatCell(col, record)}</a
											>
										{:else}
											{formatCell(col, record)}
										{/if}
									</td>
								{/each}
								<td class="td-actions">
									<button
										type="button"
										class="row-action-btn"
										title="Открыть"
										onclick={(e) => {
											e.stopPropagation();
											openRecord(record);
										}}>👁</button
									>
									<div class="row-menu-wrap">
										<button
											type="button"
											class="row-action-btn"
											title="Действия"
											onclick={(e) => {
												e.stopPropagation();
												openMenuId = openMenuId === record.id ? null : record.id;
											}}>⋮</button
										>
										{#if openMenuId === record.id}
											<div class="row-menu">
												<button
													type="button"
													class="row-menu-item"
													onclick={(e) => {
														e.stopPropagation();
														openMenuId = null;
														openRecord(record);
													}}
												>
													Открыть
												</button>
												{#if record.is_folder}
													<button
														type="button"
														class="row-menu-item"
														onclick={(e) => {
															e.stopPropagation();
															openMenuId = null;
															handleRenameFolder(record);
														}}
													>
														✏️ Переименовать группу
													</button>
												{/if}
												{#if !record.is_folder && tableType !== 'system'}
													<button
														type="button"
														class="row-menu-item"
														onclick={(e) => {
															e.stopPropagation();
															openMenuId = null;
															copyRecordLink(record);
														}}
													>
														🔗 Копировать ссылку
													</button>
												{/if}
												{#if !record.is_folder && tableTypeDef.statuses.some((s) => s.role === 'posted') && record.status !== 'posted'}
													<button
														type="button"
														class="row-menu-item"
														onclick={(e) => {
															e.stopPropagation();
															openMenuId = null;
															postRecord(record.id);
														}}
													>
														🟢 Провести
													</button>
												{/if}
												{#if !record.is_folder && tableTypeDef.statuses.some((s) => s.role === 'deleted') && record.status !== 'marked_for_deletion'}
													<button
														type="button"
														class="row-menu-item"
														onclick={(e) => {
															e.stopPropagation();
															openMenuId = null;
															markForDeletion(record.id);
														}}
													>
														🗑 Пометить на удаление
													</button>
												{/if}
												{#if !record.is_folder && record.status === 'marked_for_deletion'}
													<button
														type="button"
														class="row-menu-item"
														onclick={(e) => {
															e.stopPropagation();
															openMenuId = null;
															restoreRecord(record.id);
														}}
													>
														↩️ Восстановить
													</button>
													<button
														type="button"
														class="row-menu-item danger"
														onclick={(e) => {
															e.stopPropagation();
															openMenuId = null;
															deleteRecord(record.id);
														}}
													>
														❌ Удалить безвозвратно
													</button>
												{/if}
											</div>
										{/if}
									</div>
								</td>
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
	.hierarchy-view-toggle {
		margin-left: auto;
		display: flex;
		gap: 4px;
	}
	.view-toggle-btn {
		background: #ffffff;
		border: 1px solid #cbd5e1;
		font-size: 0.8rem;
		padding: 3px 10px;
		border-radius: 4px;
		cursor: pointer;
		color: #475569;
	}
	.view-toggle-btn:hover {
		background: #f1f5f9;
	}
	.view-toggle-btn.active {
		background: #2563eb;
		border-color: #2563eb;
		color: #ffffff;
		font-weight: 600;
	}
	.table-wrapper {
		flex: 1;
		overflow: auto;
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
	.th-actions {
		width: 64px;
	}
	.data-row {
		cursor: pointer;
		touch-action: manipulation;
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
	.cell-link {
		color: #2563eb;
		text-decoration: underline;
	}
	.cell-link:hover {
		color: #1d4ed8;
	}
	.td-status-icon {
		text-align: center;
		font-size: 0.75rem;
	}
	.td-actions {
		text-align: center;
		white-space: nowrap;
	}
	.row-action-btn {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 2px 6px;
		border-radius: 4px;
		line-height: 1;
	}
	.row-action-btn:hover {
		background: #e2e8f0;
	}
	.row-menu-wrap {
		position: relative;
		display: inline-block;
	}
	.row-menu {
		position: absolute;
		right: 0;
		top: 100%;
		z-index: 50;
		background: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		min-width: 190px;
		text-align: left;
	}
	.row-menu-item {
		display: block;
		width: 100%;
		background: none;
		border: none;
		padding: 8px 12px;
		font-size: 0.85rem;
		text-align: left;
		cursor: pointer;
		color: #334155;
	}
	.row-menu-item:hover {
		background: #f1f5f9;
	}
	.row-menu-item.danger {
		color: #dc2626;
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
