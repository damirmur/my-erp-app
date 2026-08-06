<script lang="ts">
	import { db, type LocalColumn, type LocalTable, type LocalLine } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { printerService } from '$lib/services/printer';
	import { numberService } from '$lib/services/numbers';
	import { physicalDeleteRecords } from '$lib/services/records';
	import {
		apiCall,
		runActionCode,
		runAnotherTable,
		saveRecordWithLines
	} from '$lib/services/actionRunner';
	import { supabase } from '$lib/db/supabase';
	import { isReadOnly, findParentColumn } from '$lib/table-types';
	import { fieldRegistry } from '$lib/fields';
	import { isValidBirthLocal, defaultBirth } from '$lib/fields/birth';
	import { buildRecordUrl, fullUrlFor, linkApi } from '$lib/services/deeplink';
	import Toolbar from './Toolbar.svelte';
	import TabularSection from './TabularSection.svelte';
	import PeriodsTable from './PeriodsTable.svelte';

	let { tableId, recordId, tabId = '', focusLineId = '' } = $props();

	let columns = $state<LocalColumn[]>([]);
	let recordData = $state<Record<string, any>>({});
	let recordStatus = $state<'draft' | 'posted' | 'marked_for_deletion'>('draft');
	let tableTitle = $state('Документ');
	let tableMeta = $state<LocalTable | null>(null);

	let objectSubTables = $state<LocalTable[]>([]);
	let activeSubTabIndex = $state<number>(0);
	let loading = $state(true);

	// Типы полей, у которых метка всегда над полем (не помещаются в одну строку)
	const wideFieldTypes = ['textarea', 'file', 'zip'];

	let tableType = $derived(tableMeta?.type ?? 'document');
	let tableConfig = $derived(tableMeta?.config ?? {});
	let readOnly = $derived(isReadOnly(tableType, recordStatus, tableConfig));
	let isConstant = $derived(tableType === 'constant');
	let isPeriodic = $derived(tableConfig.periodic === true && isConstant);
	let mainColName = $derived(columns[0]?.name ?? 'value');
	let mainColType = $derived(columns[0]?.type ?? 'string');

	let activeSubTable = $derived(objectSubTables[activeSubTabIndex]);

	// ---- sub-table lines ----
	// activeSubTableLines is the single $state array for the currently active sub-table.
	// TabularSection binds to it via `bind:lines`, so all mutations (push, splice, modify)
	// are tracked by Svelte 5's reactive proxy.
	let activeSubTableLines = $state<LocalLine[]>([]);

	// Plain backup copies for ALL sub-tables (used only to persist data across tab switches and for saving)
	let subTableBackup: Record<string, LocalLine[]> = {};

	function backupActiveLines() {
		if (activeSubTable) {
			subTableBackup[activeSubTable.id] = activeSubTableLines.map((l) => ({
				...l,
				data: { ...l.data }
			}));
		}
	}

	function restoreLinesToActive(forceEmpty = false) {
		const sub = activeSubTable;
		if (!sub) {
			activeSubTableLines = [];
			return;
		}
		const saved = subTableBackup[sub.id];
		if (saved && saved.length > 0 && !forceEmpty) {
			activeSubTableLines = saved.map((l) => ({ ...l, data: { ...l.data } }));
		} else {
			activeSubTableLines = [];
		}
	}

	function switchSubTab(index: number) {
		backupActiveLines();
		activeSubTabIndex = index;
		restoreLinesToActive();
	}

	// Footer totals
	let allLines = $state<LocalLine[]>([]);
	let totalAmount = $state(0);
	let totalQuantity = $state(0);

	$effect(() => {
		const _len = activeSubTableLines.length;
		const _tab = activeSubTabIndex;
		const flat: LocalLine[] = [];
		for (const [id, lines] of Object.entries(subTableBackup)) {
			if (id === activeSubTable?.id) {
				flat.push(...activeSubTableLines);
			} else {
				flat.push(...lines);
			}
		}
		allLines = flat;
		totalAmount = flat.reduce((sum, line) => sum + (parseFloat(line.data?.amount) || 0), 0);
		totalQuantity = flat.reduce((sum, line) => sum + (parseFloat(line.data?.quantity) || 0), 0);
	});

	async function loadForm() {
		loading = true;

		tableMeta = (await db.meta_tables.get(tableId)) ?? null;
		if (tableMeta) tableTitle = tableMeta.title;

		const allTables = await db.meta_tables.toArray();
		objectSubTables = allTables.filter((t) => t.parent_table_id === tableId);
		columns = await db.meta_columns.where('table_id').equals(tableId).sortBy('sort_order');

		const allLineRows = await db.data_lines.where('record_id').equals(recordId).toArray();
		const newBackup: Record<string, LocalLine[]> = {};
		for (const sub of objectSubTables) {
			newBackup[sub.id] = allLineRows.filter((l) => l.table_id === sub.id);
		}
		subTableBackup = newBackup;

		const existRecord = await db.data_records.get(recordId);
		if (existRecord) {
			recordData = { ...existRecord.data };
			recordStatus = existRecord.status;
		} else if (isConstant) {
			recordData = { value: '' };
			recordStatus = 'draft';
		} else {
			const prefix =
				tableTitle.includes('Накладная') || tableTitle.includes('Реализация') ? 'РН-' : 'СП-';
			const nextNum = await numberService.getNextNumber(tableId, prefix);
			recordData = { number: nextNum, date: new Date().toISOString().split('T')[0] };
			recordStatus = 'draft';
		}

		columns.forEach((col) => {
			if (recordData[col.name] === undefined) {
				recordData[col.name] =
					col.type === 'boolean' ? false : col.type === 'birth' ? defaultBirth() : '';
			}
		});

		// Populate activeSubTableLines from backup
		restoreLinesToActive();

		// Если форма открыта по ссылке на строку ТЧ — переключаемся на её табличную часть
		if (focusLineId) {
			const focusLine = allLineRows.find((l) => l.id === focusLineId);
			if (focusLine) {
				const subIndex = objectSubTables.findIndex((t) => t.id === focusLine.table_id);
				if (subIndex !== -1) activeSubTabIndex = subIndex;
			}
		}

		// Для периодической константы значение в шапке = значение последнего периода
		if (isPeriodic) {
			const latest = latestPeriodValue();
			if (latest !== undefined) recordData[mainColName] = latest;
		}

		loading = false;
	}

	// Значение последнего периода (актуальное)
	function latestPeriodValue(): any {
		const lines = activeSubTableLines
			.filter((l) => l.data?.period)
			.map((l) => ({ period: new Date(l.data.period).getTime(), value: l.data.value }));
		if (lines.length === 0) return undefined;
		lines.sort((a, b) => b.period - a.period);
		return lines[0].value;
	}

	// При изменении таблицы периодов обновляем значение в шапке
	$effect(() => {
		if (isPeriodic) {
			const latest = latestPeriodValue();
			if (latest !== undefined) recordData[mainColName] = latest;
		}
	});

	// Если фокус на строке ТЧ сменился (например, вкладка уже была открыта, а пользователь
	// открыл ссылку на другую строку) — переключаемся на табличную часть этой строки.
	$effect(() => {
		if (!focusLineId || objectSubTables.length === 0) return;
		let cancelled = false;
		db.data_lines
			.get(focusLineId)
			.then((line) => {
				if (cancelled || !line) return;
				const subIndex = objectSubTables.findIndex((t) => t.id === line.table_id);
				if (subIndex !== -1) activeSubTabIndex = subIndex;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	function markAsDirty() {
		workspace.setDirty(tabId, true);
	}

	async function saveToDb(targetStatus: string) {
		// Валидация JSON-полей перед записью; храним разобранный объект (настоящий jsonb)
		for (const col of columns) {
			if (col.type !== 'jsonb') continue;
			const raw = recordData[col.name];
			if (raw == null || String(raw).trim() === '') {
				recordData[col.name] = null;
				continue;
			}
			try {
				recordData[col.name] = JSON.parse(String(raw));
			} catch {
				alert(`Поле "${col.title}": некорректный JSON. Сохранение отменено.`);
				return;
			}
		}

		// Валидация полей «Момент рождения»: если заполнено хоть что-то — требуется дата и время
		for (const col of columns) {
			if (col.type !== 'birth') continue;
			const raw = recordData[col.name];
			if (!raw || typeof raw !== 'object') continue;
			const hasAny =
				raw.local || raw.place || raw.lat != null || raw.lon != null || raw.tz !== '+03:00';
			if (!hasAny) continue;
			if (!isValidBirthLocal(raw.local)) {
				alert(`Поле "${col.title}": заполните дату и время рождения. Сохранение отменено.`);
				return;
			}
		}

		backupActiveLines();

		// $state.snapshot снимает глубоко-реактивные Svelte-прокси, которые
		// IndexedDB не может клонировать (DataCloneError при put).
		const cleanData = $state.snapshot(recordData);

		const cleanLines: Array<{
			subTableId: string;
			lines: Array<{ id: string; data: Record<string, any>; sort_order: number }>;
		}> = [];
		for (const [subTableId, lines] of Object.entries(subTableBackup)) {
			cleanLines.push({
				subTableId,
				lines: lines.map((line) => ({
					id: line.id,
					data: $state.snapshot(line.data),
					sort_order: line.sort_order || 0
				}))
			});
		}

		try {
			// Родитель в форме задаётся колонкой-ссылкой на саму таблицу («Родитель»);
			// синхронизируем его в отдельное поле parent_id, по которому строится иерархия.
			const parentColumn = findParentColumn(columns, tableId);
			const parentId = parentColumn ? cleanData[parentColumn.name] || null : null;

			await db.transaction('rw', [db.data_records, db.data_lines], async () => {
				await db.data_records.put({
					id: recordId,
					table_id: tableId,
					status: targetStatus as any,
					is_folder: false,
					parent_id: parentId,
					data: { ...cleanData, total_amount: totalAmount },
					is_dirty: 1,
					updated_at: new Date().toISOString()
				});

				await db.data_lines.where('record_id').equals(recordId).delete();
				for (const { subTableId, lines } of cleanLines) {
					for (const line of lines) {
						await db.data_lines.put({
							id: line.id,
							record_id: recordId,
							table_id: subTableId,
							data: line.data,
							sort_order: line.sort_order
						});
					}
				}
			});
		} catch (e: any) {
			alert(`Ошибка сохранения: ${e?.message ?? e}`);
			return;
		}

		workspace.setDirty(tabId, false);
		workspace.updateTabTitle(
			tabId,
			isConstant ? tableTitle : `${tableTitle} №${recordData.number}`
		);
		if (targetStatus !== recordStatus) recordStatus = targetStatus as any;

		// Журнал изменений: факт сохранения (в т.ч. проведение/пометка на удаление)
		workspace.recordHistory(
			tableId,
			isConstant ? tableTitle : `${tableTitle} №${recordData.number}`,
			buildRecordUrl(recordId),
			'save',
			targetStatus
		);
	}

	async function handleAction(actionId: string) {
		switch (actionId) {
			case 'save':
				await saveToDb('draft');
				break;
			case 'post':
				recordStatus = 'posted';
				await saveToDb('posted');
				break;
			case 'unpost':
				recordStatus = 'draft';
				await saveToDb('draft');
				workspace.setDirty(tabId, true);
				break;
			case 'markDelete':
				recordStatus = 'marked_for_deletion';
				await saveToDb('marked_for_deletion');
				break;
			case 'unmarkDelete':
				recordStatus = 'draft';
				await saveToDb('draft');
				break;
			case 'delete':
				await handleDelete();
				break;
			case 'copy':
				await handleCopy();
				break;
			case 'print':
				printerService.printRecords(tableId, [recordId]);
				break;
			case 'run':
				await handleRun();
				break;
		}
	}

	async function copyRecordLink() {
		if (recordId === 'new') {
			alert('Сначала сохраните запись, чтобы получить её ссылку.');
			return;
		}
		const url = fullUrlFor(buildRecordUrl(recordId));
		try {
			await navigator.clipboard.writeText(url);
			alert('Ссылка на запись скопирована: ' + url);
		} catch {
			alert('Не удалось скопировать ссылку: ' + url);
		}
	}

	// ▶️ Выполнить: запуск пользовательского JS-кода по текущей записи
	async function handleRun() {
		if (recordId === 'new') return alert('Сначала сохраните запись');
		const code = tableMeta?.config?.runCode;
		if (!code?.trim())
			return alert('Код действия не задан. Откройте конфигуратор таблицы → «Выполнить (JS-код)».');
		const record = await db.data_records.get(recordId);
		if (!record) return alert('Запись не найдена');
		const lines = await db.data_lines.where('record_id').equals(recordId).toArray();
		try {
			await runActionCode(code, {
				record,
				records: [record],
				lines,
				db,
				supabase,
				save: saveRecordWithLines,
				log: (...args) => console.log('[Выполнить]', ...args),
				link: linkApi,
				apiCall,
				run: runAnotherTable
			});
			const updated = await db.data_records.get(recordId);
			if (updated) {
				recordData = { ...(updated.data ?? {}) };
			}
			workspace.setDirty(tabId, false);
		} catch (e: any) {
			alert(`Ошибка выполнения кода: ${e?.message ?? e}`);
		}
	}

	async function handleDelete() {
		if (recordId === 'new') return;
		if (!confirm('Безвозвратно удалить запись?')) return;
		try {
			await physicalDeleteRecords([recordId]);
		} catch (e: any) {
			alert(`Ошибка удаления: ${e?.message ?? e}`);
			return;
		}
		workspace.closeTabForce(tabId);
	}

	async function handleCopy() {
		const newRecordId = crypto.randomUUID();
		backupActiveLines();

		const cleanData = $state.snapshot(recordData);
		const cleanLines: Array<{
			subTableId: string;
			lines: Array<{ id: string; data: Record<string, any>; sort_order: number }>;
		}> = [];
		for (const [subTableId, lines] of Object.entries(subTableBackup)) {
			cleanLines.push({
				subTableId,
				lines: lines.map((line) => ({
					id: line.id,
					data: $state.snapshot(line.data),
					sort_order: line.sort_order || 0
				}))
			});
		}

		const prefix =
			tableTitle.includes('Накладная') || tableTitle.includes('Реализация') ? 'РН-' : 'СП-';
		const nextFreeNumber = await numberService.getNextNumber(tableId, prefix);
		const newRecordData = {
			...cleanData,
			number: nextFreeNumber,
			date: new Date().toISOString().split('T')[0]
		};

		await db.transaction('rw', [db.data_records, db.data_lines], async () => {
			await db.data_records.put({
				id: newRecordId,
				table_id: tableId,
				status: 'draft',
				is_folder: false,
				parent_id: null,
				data: newRecordData,
				is_dirty: 1,
				updated_at: new Date().toISOString()
			});
			for (const { subTableId, lines } of cleanLines) {
				for (const line of lines) {
					await db.data_lines.put({
						id: crypto.randomUUID(),
						record_id: newRecordId,
						table_id: subTableId,
						data: line.data,
						sort_order: line.sort_order
					});
				}
			}
		});

		workspace.openForm(tableId, newRecordId, tableTitle, nextFreeNumber);
	}

	$effect(() => {
		recordId;
		loadForm();
	});
</script>

<div class="form-container">
	<Toolbar mode="form" status={recordStatus} {tableId} onAction={handleAction} />
	<div class="form-link-row">
		<button
			type="button"
			class="btn-link-copy"
			onclick={() => copyRecordLink()}
			title="Скопировать уникальную ссылку на эту запись"
		>
			🔗 Копировать ссылку на запись
		</button>
	</div>

	{#if loading}
		<div class="p-6">Загрузка формы элемента...</div>
	{:else}
		<div class="form-body">
			<div class="form-grid">
				{#each columns as col}
					{@const FC = fieldRegistry[col.type]?.FormField}
					<div class="form-field" class:wide={wideFieldTypes.includes(col.type)}>
						<label for={col.id}>
							{col.title}
							{#if isPeriodic && col.name === mainColName}
								<span class="field-note">(актуальное значение)</span>
							{/if}
						</label>
						{#if FC}
							<FC
								bind:value={recordData[col.name]}
								disabled={readOnly || (isPeriodic && col.name === mainColName)}
								onChange={markAsDirty}
								relatedTableId={col.related_table_id ?? ''}
							/>
						{/if}
					</div>
				{/each}
			</div>

			{#if objectSubTables.length > 0 && (!isConstant || isPeriodic)}
				<div class="sub-tabs-wrapper">
					<div class="sub-tabs-header">
						{#each objectSubTables as subTab, i}
							<button
								class="sub-tab-btn"
								class:active={activeSubTabIndex === i}
								onclick={() => switchSubTab(i)}
							>
								📦 {subTab.title}
							</button>
						{/each}
					</div>
					{#if activeSubTable}
						<div class="sub-tab-content">
							{#if isConstant}
								<PeriodsTable
									bind:lines={activeSubTableLines}
									onChange={markAsDirty}
									{readOnly}
									valueType={mainColType}
								/>
							{:else}
								<TabularSection
									bind:lines={activeSubTableLines}
									onChange={markAsDirty}
									{readOnly}
									tableId={activeSubTable.id}
									{focusLineId}
								/>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		{#if objectSubTables.length > 0 && !isConstant}
			<div class="form-footer-summary">
				<div class="summary-item">Всего строк: <strong>{allLines.length}</strong></div>
				<div class="summary-item">Всего количество: <strong>{totalQuantity}</strong></div>
				<div class="summary-item total-price">Итого сумма: <span>{totalAmount}</span> руб.</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.form-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: #ffffff;
	}
	.form-body {
		flex: 1;
		padding: 1rem;
		overflow-y: auto;
	}
	.form-grid {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 1.5rem;
	}
	.form-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.form-field:not(.wide) {
		flex-direction: row;
		align-items: center;
		gap: 10px;
	}
	.form-field:not(.wide) label {
		flex: 0 0 200px;
		margin: 0;
	}
	.form-field:not(.wide) label::after {
		content: ':';
	}
	.form-field:not(.wide) :global(input),
	.form-field:not(.wide) :global(textarea),
	.form-field:not(.wide) :global(select) {
		flex: 1;
		min-width: 0;
	}
	.form-field :global(input),
	.form-field :global(textarea),
	.form-field :global(select) {
		width: 100%;
		box-sizing: border-box;
	}
	.form-field label {
		font-size: 0.8rem;
		font-weight: 500;
		color: #475569;
	}
	.field-note {
		font-size: 0.7rem;
		font-weight: 400;
		color: #94a3b8;
		margin-left: 4px;
	}
	.sub-tabs-wrapper {
		margin-top: 1.5rem;
		border-top: 1px solid #e2e8f0;
	}
	.sub-tabs-header {
		display: flex;
		gap: 2px;
		background: #f8fafc;
		border-bottom: 1px solid #cbd5e1;
	}
	.sub-tab-btn {
		background: none;
		border: none;
		padding: 6px 12px;
		font-size: 0.8rem;
		cursor: pointer;
		color: #64748b;
	}
	.sub-tab-btn.active {
		background: #ffffff;
		border-bottom: 2px solid #2563eb;
		color: #1e3a8a;
		font-weight: 600;
	}
	.form-footer-summary {
		background: #f1f5f9;
		border-top: 1px solid #cbd5e1;
		padding: 8px 16px;
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 24px;
		font-size: 0.85rem;
		color: #334155;
	}
	.total-price span {
		color: #16a34a;
		font-size: 1.1rem;
		font-weight: 700;
	}
	.form-link-row {
		display: flex;
		justify-content: flex-end;
		padding: 4px 12px;
		background-color: #f8fafc;
		border-bottom: 1px solid #e2e8f0;
	}
	.btn-link-copy {
		background: none;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		color: #475569;
		font-size: 0.75rem;
		padding: 3px 8px;
		cursor: pointer;
	}
	.btn-link-copy:hover {
		background-color: #e2e8f0;
	}
</style>
