<script lang="ts">
	import { db, type LocalColumn, type LocalTable, type LocalLine } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { printerService } from '$lib/services/printer';
	import { numberService } from '$lib/services/numbers';
	import { isReadOnly } from '$lib/table-types';
	import Toolbar from './Toolbar.svelte';
	import TabularSection from './TabularSection.svelte';
	import StringField from '$lib/fields/StringField.svelte';
	import NumberField from '$lib/fields/NumberField.svelte';
	import BooleanField from '$lib/fields/BooleanField.svelte';
	import DateField from '$lib/fields/DateField.svelte';
	import LinkField from '$lib/fields/LinkField.svelte';

	let { tableId, recordId, tabId = '' } = $props();

	let columns = $state<LocalColumn[]>([]);
	let recordData = $state<Record<string, any>>({});
	let recordStatus = $state<'draft' | 'posted' | 'marked_for_deletion'>('draft');
	let tableTitle = $state('Документ');
	let tableMeta = $state<LocalTable | null>(null);

	let objectSubTables = $state<LocalTable[]>([]);
	let lines = $state<LocalLine[]>([]);
	let loading = $state(true);

	let tableType = $derived(tableMeta?.type ?? 'document');
	let tableConfig = $derived(tableMeta?.config ?? {});
	let readOnly = $derived(isReadOnly(tableType, recordStatus, tableConfig));

	let totalAmount = $derived(lines.reduce((sum, line) => sum + (parseFloat(line.data?.amount) || 0), 0));
	let totalQuantity = $derived(lines.reduce((sum, line) => sum + (parseFloat(line.data?.quantity) || 0), 0));

	async function loadForm() {
		loading = true;

		tableMeta = await db.meta_tables.get(tableId) ?? null;
		if (tableMeta) tableTitle = tableMeta.title;

		const allTables = await db.meta_tables.toArray();
		objectSubTables = allTables.filter(t => t.parent_table_id === tableId);

		columns = await db.meta_columns.where('table_id').equals(tableId).sortBy('sort_order');

		const existRecord = await db.data_records.get(recordId);
		if (existRecord) {
			recordData = { ...existRecord.data };
			recordStatus = existRecord.status;
			lines = await db.data_lines.where('record_id').equals(recordId).toArray();
		} else {
			const prefix = tableTitle.includes('Накладная') || tableTitle.includes('Реализация') ? 'РН-' : 'СП-';
			const nextNum = await numberService.getNextNumber(tableId, prefix);
			recordData = { number: nextNum, date: new Date().toISOString().split('T')[0] };
			recordStatus = 'draft';
			lines = [];
		}

		columns.forEach(col => { if (recordData[col.name] === undefined) recordData[col.name] = ''; });

		loading = false;
	}

	function markAsDirty() { workspace.setDirty(tabId, true); }

	async function saveToDb(targetStatus: string) {
		const cleanData = $state.snapshot(recordData);
		const cleanLines = $state.snapshot(lines);

		await db.transaction('rw', [db.data_records, db.data_lines], async () => {
			await db.data_records.put({
				id: recordId, table_id: tableId, status: targetStatus as any,
				is_folder: false, parent_id: null,
				data: { ...cleanData, total_amount: totalAmount }, is_dirty: 1, updated_at: new Date().toISOString()
			});

			await db.data_lines.where('record_id').equals(recordId).delete();
			for (const line of cleanLines) {
				await db.data_lines.put({ id: line.id, record_id: recordId, table_id: tableId, data: line.data, sort_order: line.sort_order || 0 });
			}
		});

		workspace.setDirty(tabId, false);
		workspace.updateTabTitle(tabId, `${tableTitle} №${recordData.number}`);
		if (targetStatus !== recordStatus) recordStatus = targetStatus as any;
	}

	async function handleAction(actionId: string, payload?: string) {
		switch (actionId) {
			case 'save': await saveToDb('draft'); break;
			case 'post': recordStatus = 'posted'; await saveToDb('posted'); break;
			case 'unpost': recordStatus = 'draft'; await saveToDb('draft'); workspace.setDirty(tabId, true); break;
			case 'markDelete': recordStatus = 'marked_for_deletion'; await saveToDb('marked_for_deletion'); break;
			case 'unmarkDelete': recordStatus = 'draft'; await saveToDb('draft'); break;
			case 'copy': await handleCopy(); break;
			case 'print': printerService.printRecords(tableId, [recordId]); break;
		}
	}

	async function handleCopy() {
		const newRecordId = crypto.randomUUID();
		const cleanData = $state.snapshot(recordData);
		const cleanLines = $state.snapshot(lines);

		const prefix = tableTitle.includes('Накладная') || tableTitle.includes('Реализация') ? 'РН-' : 'СП-';
		const nextFreeNumber = await numberService.getNextNumber(tableId, prefix);
		const newRecordData = { ...cleanData, number: nextFreeNumber, date: new Date().toISOString().split('T')[0] };

		await db.transaction('rw', [db.data_records, db.data_lines], async () => {
			await db.data_records.put({ id: newRecordId, table_id: tableId, status: 'draft', is_folder: false, parent_id: null, data: newRecordData, is_dirty: 1, updated_at: new Date().toISOString() });
			for (const line of cleanLines) {
				await db.data_lines.put({ id: crypto.randomUUID(), record_id: newRecordId, table_id: tableId, data: { ...line.data }, sort_order: line.sort_order || 0 });
			}
		});

		workspace.openForm(tableId, newRecordId, tableTitle, nextFreeNumber);
	}

	$effect(() => { recordId; loadForm(); });
</script>

<div class="form-container">
	<Toolbar mode="form" status={recordStatus} {tableId} onAction={handleAction} />

	{#if loading}
		<div class="p-6">Загрузка формы элемента...</div>
	{:else}
		<div class="form-body">
			<div class="form-grid">
				{#each columns as col}
					<div class="form-field">
						<label for={col.id}>{col.title}</label>
						{#if col.type === 'boolean'}
							<BooleanField bind:value={recordData[col.name]} disabled={readOnly} onChange={markAsDirty} />
						{:else if col.type === 'link'}
							<LinkField bind:value={recordData[col.name]} disabled={readOnly} relatedTableId={col.related_table_id ?? ''} onChange={markAsDirty} />
						{:else if col.type === 'date'}
							<DateField bind:value={recordData[col.name]} disabled={readOnly} onChange={markAsDirty} />
						{:else if col.type === 'number'}
							<NumberField bind:value={recordData[col.name]} disabled={readOnly} onChange={markAsDirty} />
						{:else}
							<StringField bind:value={recordData[col.name]} disabled={readOnly} onChange={markAsDirty} />
						{/if}
					</div>
				{/each}
			</div>

			{#if objectSubTables.length > 0}
				<div class="sub-tabs-wrapper">
					<div class="sub-tabs-header">
						{#each objectSubTables as subTab}
							<button class="sub-tab-btn active">📦 {subTab.title}</button>
						{/each}
					</div>
					<div class="sub-tab-content">
						{#each objectSubTables as subTab}
							<TabularSection bind:lines={lines} onChange={markAsDirty} readOnly={readOnly} {tableId} />
						{/each}
					</div>
				</div>
			{/if}
		</div>

		{#if objectSubTables.length > 0}
			<div class="form-footer-summary">
				<div class="summary-item">Всего строк: <strong>{lines.length}</strong></div>
				<div class="summary-item">Всего количество: <strong>{totalQuantity}</strong></div>
				<div class="summary-item total-price">Итого сумма: <span>{totalAmount}</span> руб.</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.form-container { display: flex; flex-direction: column; height: 100%; background: #ffffff; }
	.form-body { flex: 1; padding: 1rem; overflow-y: auto; }
	.form-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-bottom: 1.5rem; }
	.form-field { display: flex; flex-direction: column; gap: 4px; }
	.form-field label { font-size: 0.8rem; font-weight: 500; color: #475569; }
	.sub-tabs-wrapper { margin-top: 1.5rem; border-top: 1px solid #e2e8f0; }
	.sub-tabs-header { display: flex; gap: 2px; background: #f8fafc; border-bottom: 1px solid #cbd5e1; }
	.sub-tab-btn { background: none; border: none; padding: 6px 12px; font-size: 0.8rem; cursor: pointer; color: #64748b; }
	.sub-tab-btn.active { background: #ffffff; border-bottom: 2px solid #2563eb; color: #1e3a8a; font-weight: 600; }
	.form-footer-summary { background: #f1f5f9; border-top: 1px solid #cbd5e1; padding: 8px 16px; display: flex; justify-content: flex-end; align-items: center; gap: 24px; font-size: 0.85rem; color: #334155; }
	.total-price span { color: #16a34a; font-size: 1.1rem; font-weight: 700; }
</style>
