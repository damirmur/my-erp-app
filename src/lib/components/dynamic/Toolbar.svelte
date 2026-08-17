<script lang="ts">
	import { db, type LocalColumn, type LocalTable } from '$lib/db/indexeddb';
	import { getTableType, getActions, getStatusDef } from '$lib/table-types';
	import { liveQuery } from 'dexie';
	import { auth } from '$lib/state/auth.svelte';

	let {
		mode = 'list',
		status = 'draft',
		tableId = '',
		onAction = null,
		columns = [] as LocalColumn[],
		onToggleColumn = null,
		onCopyTableLink = null
	} = $props();

	let tableMeta = $state<LocalTable | null>(null);
	let printForms = $state<{ id: string; name: string; is_default: boolean; delivery: string }[]>(
		[]
	);
	let showPrintMenu = $state(false);
	let showMoreMenu = $state(false);
	let showColumnsMenu = $state(false);
	let hasPrintForms = $derived(printForms.length > 0);

	// Способы вывода документа. Код в колонке delivery печатной формы
	// («print,screen,send,download», пусто = все) определяет, какие пункты меню
	// показываются для конкретной формы.
	const DELIVERY_MODES: { id: string; icon: string; label: string; action: string }[] = [
		{ id: 'print', icon: '🖨️', label: 'Печать', action: 'print' },
		{ id: 'screen', icon: '👁', label: 'На экране', action: 'preview' },
		{ id: 'send', icon: '✉️', label: 'Отправить', action: 'send' },
		{ id: 'download', icon: '💾', label: 'Скачать', action: 'download' }
	];

	function modesFor(form: {
		delivery: string;
	}): { id: string; icon: string; label: string; action: string }[] {
		const codes = form.delivery
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		return codes.length > 0 ? DELIVERY_MODES.filter((m) => codes.includes(m.id)) : DELIVERY_MODES;
	}

	// Печатные формы таблицы: записи data_records системной таблицы print_forms,
	// привязанные к текущей таблице колонкой target_table. Следим через liveQuery.
	$effect(() => {
		if (!tableId) return;
		db.meta_tables.get(tableId).then((t) => (tableMeta = t ?? null));

		const observable = liveQuery(async () => {
			const pfTable = await db.meta_tables.where('name').equals('print_forms').first();
			if (!pfTable) return [];
			const rows = await db.data_records.where('table_id').equals(pfTable.id).toArray();
			return rows
				.filter((r) => r.data?.target_table === tableId && !r.is_folder)
				.sort((a, b) => (a.data?.sort_order ?? 0) - (b.data?.sort_order ?? 0))
				.map((r) => ({
					id: r.id,
					name: String(r.data?.name ?? ''),
					is_default: r.data?.is_default === true || r.data?.is_default === 1,
					delivery: String(r.data?.delivery ?? '')
				}));
		});
		const sub = observable.subscribe({
			next: (pf) => (printForms = pf),
			error: (err) => console.error('Ошибка чтения печатных форм:', err)
		});
		return () => sub.unsubscribe();
	});

	let tableTypeName = $derived(tableMeta?.type ?? '');
	let tableConfig = $derived(tableMeta?.config ?? {});

	// Кнопка «Печать» показывается только если для таблицы есть хоть одна
	// печатная форма: 1 форма → прямая печать, несколько → выпадающий список.
	let printActionVisible = $derived(hasPrintForms);

	// Права на таблицу: изменяющие действия скрыты без права редактирования,
	// «Выполнить» требует права на выполнение (доступно и редакторам).
	let canEdit = $derived(auth.canEditTable(tableId));
	let canExecute = $derived(auth.canExecuteTable(tableId));

	// Действия, меняющие данные: требуют права на изменение таблицы.
	const MUTATING_ACTIONS = new Set([
		'create',
		'createFolder',
		'save',
		'post',
		'unpost',
		'markDelete',
		'unmarkDelete',
		'copy',
		'massPost',
		'massDelete',
		'massRestore',
		'purgeMarked',
		'delete'
	]);

	// Остальные кнопки (кроме print) — из фич типа таблицы. Изменяющие действия
	// скрыты без права на редактирование, «Выполнить» — без права на выполнение.
	let actions = $derived(
		getActions(tableTypeName, mode, tableConfig)
			.filter((a) => a.id !== 'print')
			.filter((a) => (a.id === 'run' ? canExecute : !MUTATING_ACTIONS.has(a.id) || canEdit))
	);

	let currentStatusDef = $derived(getStatusDef(tableTypeName, status));

	// Закрытие выпадающих меню при клике вне кнопок меню
	// (клики внутри .toolbar-menu-wrap и .print-dropdown-wrapper не закрывают меню —
	// чтобы можно было переключать несколько чекбоксов видимости или раскрывать
	// вложенное меню печатных форм подряд)
	$effect(() => {
		if (!showMoreMenu && !showColumnsMenu && !showPrintMenu) return;
		const close = (e: MouseEvent) => {
			const target = e.target as Element;
			if (target.closest?.('.toolbar-menu-wrap') || target.closest?.('.print-dropdown-wrapper'))
				return;
			showMoreMenu = false;
			showColumnsMenu = false;
			showPrintMenu = false;
		};
		document.addEventListener('click', close);
		return () => document.removeEventListener('click', close);
	});

	function handleDeliveryClick(action: string, formId: string) {
		showPrintMenu = false;
		onAction?.(action, formId);
	}
</script>

{#if tableMeta}
	<div class="toolbar">
		<div class="toolbar-actions">
			{#each actions as act}
				<button
					onclick={() => onAction?.(act.id)}
					class="btn"
					class:btn-primary={act.variant === 'primary'}
					class:btn-success={act.variant === 'success'}
					class:btn-danger={act.variant === 'danger'}
					class:btn-warning={act.variant === 'warning'}
					class:btn-text-danger={act.variant === 'text-danger'}
					class:btn-text-success={act.variant === 'text-success'}
					hidden={act.show && !act.show(status)}
					disabled={act.disabled?.(status) ?? false}
				>
					{act.icon}
					{act.label}
				</button>
			{/each}
			{#if printActionVisible}
				<div class="print-dropdown-wrapper">
					<button onclick={() => (showPrintMenu = !showPrintMenu)} class="btn">
						🖨️ Вывод
						<span class="print-caret">▾</span>
					</button>
					{#if showPrintMenu && hasPrintForms}
						<div class="print-menu">
							{#each printForms as pf}
								{@const modes = modesFor(pf)}
								<div class="print-menu-form">
									{#if printForms.length === 1}
										{#each modes as mode}
											<button
												type="button"
												class="print-menu-item print-menu-mode"
												onclick={() => handleDeliveryClick(mode.action, pf.id)}
											>
												{mode.icon}
												{mode.label}
											</button>
										{/each}
									{:else}
										<div class="print-menu-item print-menu-form-label">
											<span class="print-menu-form-name">
												{pf.name}
												{pf.is_default ? '✓' : ''}
											</span>
										</div>
										{#each modes as mode}
											<button
												type="button"
												class="print-menu-item print-menu-mode"
												onclick={() => handleDeliveryClick(mode.action, pf.id)}
											>
												{mode.icon}
												{mode.label}
											</button>
										{/each}
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			{#if mode === 'list' && onCopyTableLink}
				<button
					class="btn btn-icon-only"
					title="Копировать ссылку на таблицу"
					onclick={(e) => {
						e.stopPropagation();
						onCopyTableLink();
					}}
				>
					🔗
				</button>
			{/if}
			{#if mode === 'list'}
				<div class="toolbar-menu-wrap">
					<button
						class="btn btn-icon-only"
						title="Все действия"
						onclick={(e) => {
							e.stopPropagation();
							showMoreMenu = !showMoreMenu;
							showColumnsMenu = false;
						}}
					>
						⋮
					</button>
					{#if showMoreMenu}
						<div class="toolbar-menu">
							{#each actions as act}
								{#if !act.show || act.show(status)}
									<button
										type="button"
										class="toolbar-menu-item"
										class:disabled={act.disabled?.(status) ?? false}
										onclick={() => {
											showMoreMenu = false;
											onAction?.(act.id);
										}}
									>
										{act.icon}
										{act.label}
									</button>
								{/if}
							{/each}
						</div>
					{/if}
				</div>
				{#if columns.length > 0}
					<div class="toolbar-menu-wrap">
						<button
							class="btn btn-icon-only"
							title="Настройка колонок списка"
							onclick={(e) => {
								e.stopPropagation();
								showColumnsMenu = !showColumnsMenu;
								showMoreMenu = false;
							}}
						>
							⚙️
						</button>
						{#if showColumnsMenu}
							<div class="toolbar-menu toolbar-menu-columns">
								{#each columns as col}
									<label class="toolbar-menu-check">
										<input
											type="checkbox"
											checked={col.is_visible !== false}
											onchange={(e) => {
												const checked = (e.target as HTMLInputElement).checked;
												onToggleColumn?.(col.id, checked);
											}}
										/>
										{col.title}
									</label>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
		<div class="toolbar-status" hidden={mode !== 'form'}>
			<span class="badge {currentStatusDef?.badgeClass ?? 'status-draft'}">
				{currentStatusDef?.icon ?? '⚪'}
				{currentStatusDef?.label ?? status}
			</span>
		</div>
	</div>
{/if}

<style>
	.toolbar {
		background-color: #f8fafc;
		border-bottom: 1px solid #cbd5e1;
		padding: 6px 12px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		min-height: 42px;
	}
	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.btn {
		background-color: #ffffff;
		border: 1px solid #cbd5e1;
		padding: 4px 12px;
		font-size: 0.85rem;
		border-radius: 4px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		color: #334155;
		font-weight: 500;
	}
	.btn:hover:not(:disabled) {
		background-color: #f1f5f9;
		border-color: #94a3b8;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.btn-primary {
		background-color: #2563eb;
		color: #fff;
		border-color: #1d4ed8;
	}
	.btn-primary:hover:not(:disabled) {
		background-color: #1d4ed8;
	}
	.btn-success {
		background-color: #16a34a;
		color: #fff;
		border-color: #15803d;
	}
	.btn-success:hover:not(:disabled) {
		background-color: #15803d;
	}
	.btn-danger {
		background-color: #ef4444;
		color: #fff;
		border-color: #dc2626;
	}
	.btn-danger:hover:not(:disabled) {
		background-color: #dc2626;
	}
	.btn-warning {
		background-color: #f59e0b;
		color: #fff;
		border-color: #d97706;
	}
	.btn-warning:hover:not(:disabled) {
		background-color: #d97706;
	}
	.btn-text-danger {
		color: #ef4444;
		border: none;
		background: none;
	}
	.btn-text-danger:hover {
		text-decoration: underline;
		background: none !important;
	}
	.btn-text-success {
		color: #16a34a;
		border: none;
		background: none;
	}
	.btn-text-success:hover {
		text-decoration: underline;
		background: none !important;
	}
	[hidden] {
		display: none;
	}

	.print-dropdown-wrapper {
		position: relative;
	}
	.print-caret {
		margin-left: 4px;
		font-size: 0.7rem;
	}
	.print-menu {
		position: absolute;
		top: 100%;
		left: 0;
		background: #fff;
		border: 1px solid #cbd5e1;
		box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
		border-radius: 4px;
		z-index: 50;
		min-width: 180px;
		margin-top: 4px;
	}
	.print-menu-item {
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 6px 12px;
		font-size: 0.85rem;
		cursor: pointer;
		color: #334155;
	}
	.print-menu-item:hover {
		background-color: #f1f5f9;
	}
	.print-menu-form {
		border-bottom: 1px solid #f1f5f9;
	}
	.print-menu-form:last-child {
		border-bottom: none;
	}
	.print-menu-form-label {
		cursor: default;
		font-weight: 600;
		color: #64748b;
		background: #f8fafc;
		padding: 5px 12px;
	}
	.print-menu-form-label:hover {
		background: #f8fafc;
	}
	.print-menu-form-name {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.print-menu-mode {
		padding-left: 20px;
		font-size: 0.82rem;
	}

	.toolbar-menu-wrap {
		position: relative;
		display: inline-block;
	}
	.btn-icon-only {
		padding: 4px 10px;
	}
	.toolbar-menu {
		position: absolute;
		top: 100%;
		right: 0;
		background: #fff;
		border: 1px solid #cbd5e1;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		border-radius: 6px;
		z-index: 50;
		min-width: 190px;
		margin-top: 4px;
		max-height: 300px;
		overflow-y: auto;
	}
	.toolbar-menu-columns {
		min-width: 200px;
	}
	.toolbar-menu-item {
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 8px 12px;
		font-size: 0.85rem;
		cursor: pointer;
		color: #334155;
	}
	.toolbar-menu-item:hover {
		background-color: #f1f5f9;
	}
	.toolbar-menu-item.disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.toolbar-menu-check {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		font-size: 0.85rem;
		cursor: pointer;
		color: #334155;
		white-space: nowrap;
	}
	.toolbar-menu-check:hover {
		background-color: #f1f5f9;
	}
	.toolbar-menu-check input {
		width: auto;
		margin: 0;
	}

	.badge {
		font-size: 0.75rem;
		padding: 2px 8px;
		border-radius: 9999px;
		font-weight: 600;
	}
	.status-draft {
		background-color: #e2e8f0;
		color: #475569;
	}
	.status-posted {
		background-color: #dcfce7;
		color: #166534;
	}
	.status-marked_for_deletion {
		background-color: #fee2e2;
		color: #991b1b;
	}
</style>
