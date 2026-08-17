<script lang="ts">
	import { db, type LocalTable, type LocalRecord } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { metadata } from '$lib/state/metadata';
	import { syncService } from '$lib/services/sync';
	import { liveQuery } from 'dexie';
	import { tableTypeList } from '$lib/table-types';
	import {
		APP_SETTINGS_TABLE,
		NAV_ORDER_KEY,
		TRANSLATE_SERVICE_KEY,
		clearNavOrder as resetPersistedNavOrder,
		saveNavOrder as persistNavOrder,
		saveTranslateConfig as persistTranslateConfig
	} from '$lib/state/settings';

	// Вкладка «Интерфейс»: настройки основного режима — порядок типов и таблиц,
	// видимость таблиц в основном меню и сервис перевода имён полей.

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

	$effect(() => {
		const observable = liveQuery(() => db.meta_tables.orderBy('name').toArray());
		const subscription = observable.subscribe({
			next: (data) => {
				tables = data;
				loading = false;
			},
			error: (err) => console.error('Ошибка живого запроса интерфейса:', err)
		});
		return () => subscription.unsubscribe();
	});

	let tablesById = $derived(new Map(tables.map((t) => [t.id, t])));

	// Таблица скрыта из основного режима, если в её config выставлен флаг hiddenInMain
	function isVisibleInMain(table: LocalTable): boolean {
		return table.config?.hiddenInMain !== true;
	}

	// Все таблицы верхнего уровня (без табличных частей), по алфавиту
	let constructorTables = $derived(
		tables.filter((t) => !t.parent_table_id).sort((a, b) => a.title.localeCompare(b.title))
	);

	// ---- Настраиваемый порядок меню основного режима ----
	// Порядок групп типов и таблиц внутри них хранится в системной таблице
	// app_settings (запись с ключом main_nav_order).
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

	// Редактирование порядка и видимости: правки копятся в черновиках,
	// «Сохранить» пишет их в app_settings (порядок) и в config таблиц (видимость).
	let editingNavOrder = $state(false);
	let draftTypeOrder = $state<string[]>([]);
	let draftTableOrder = $state<Record<string, string[]>>({});
	let draftVisibility = $state<Record<string, boolean>>({});

	function toggleEditNavOrder() {
		if (editingNavOrder) {
			cancelNavOrder();
			return;
		}
		draftTypeOrder = orderedTypeList.map((t) => t.type);
		draftTableOrder = {};
		draftVisibility = {};
		for (const t of orderedTypeList) {
			const top = constructorTables.filter((tbl) => tbl.type === t.type);
			const configured = new Set(navOrder.tableOrder[t.type] ?? []);
			const ordered = (navOrder.tableOrder[t.type] ?? []).filter((id) => tablesById.has(id));
			const rest = top.filter((tbl) => !configured.has(tbl.id)).map((tbl) => tbl.id);
			draftTableOrder[t.type] = [...ordered, ...rest];
			for (const tbl of top) {
				draftVisibility[tbl.id] = isVisibleInMain(tbl);
			}
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

	function toggleTableVisibility(tableId: string) {
		draftVisibility = { ...draftVisibility, [tableId]: !draftVisibility[tableId] };
	}

	async function saveNavOrder() {
		try {
			await persistNavOrder({ typeOrder: draftTypeOrder, tableOrder: draftTableOrder });
			// Применяем изменения видимости таблиц в основном меню
			for (const tbl of constructorTables) {
				const target = draftVisibility[tbl.id];
				if (target === undefined) continue;
				if (isVisibleInMain(tbl) !== target) {
					await metadata.setTableHiddenInMain(tbl.id, !target);
				}
			}
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
		draftVisibility = {};
		await syncService.runFullSync();
	}

	function cancelNavOrder() {
		editingNavOrder = false;
		draftTypeOrder = [];
		draftTableOrder = {};
		draftVisibility = {};
	}

	// ---- Настройка «Сервис перевода» (автоперевод имён полей из синонима) ----
	// Выбор сервиса-переводчика из каталога «Сервисы API» + языки (пусто = по
	// умолчанию: источник — язык браузера, цель — en). Конфиг живёт в app_settings
	// (ключ translate_service) и используется конфигуратором через nameAuto.
	let translateServices = $state<LocalRecord[]>([]);
	let translateConfig = $state<{ serviceId: string; sourceLang: string; targetLang: string }>({
		serviceId: '',
		sourceLang: '',
		targetLang: ''
	});

	$effect(() => {
		const observable = liveQuery(async () => {
			const table = await db.meta_tables.where('name').equals('api_services').first();
			if (!table) return [];
			return await db.data_records.where('table_id').equals(table.id).toArray();
		});
		const subscription = observable.subscribe({
			next: (records) => {
				translateServices = records;
			},
			error: (err) => console.error('Ошибка чтения сервисов API:', err)
		});
		return () => subscription.unsubscribe();
	});

	$effect(() => {
		const observable = liveQuery(async () => {
			const table = await db.meta_tables.where('name').equals(APP_SETTINGS_TABLE).first();
			if (!table) return null;
			const rows = await db.data_records.where('table_id').equals(table.id).toArray();
			return rows.find((r) => r.data?.key === TRANSLATE_SERVICE_KEY) ?? null;
		});
		const subscription = observable.subscribe({
			next: (rec) => {
				const d = rec?.data ?? {};
				translateConfig = {
					serviceId: typeof d.serviceId === 'string' ? d.serviceId : '',
					sourceLang: typeof d.sourceLang === 'string' ? d.sourceLang : '',
					targetLang: typeof d.targetLang === 'string' ? d.targetLang : ''
				};
			},
			error: (err) => console.error('Ошибка чтения настроек перевода:', err)
		});
		return () => subscription.unsubscribe();
	});

	async function handleTranslateServiceChange(e: Event) {
		translateConfig = {
			...translateConfig,
			serviceId: (e.currentTarget as HTMLSelectElement).value
		};
		try {
			await persistTranslateConfig(translateConfig);
		} catch (err: any) {
			alert(`Ошибка сохранения настроек перевода: ${err?.message ?? err}`);
		}
	}

	function handleTranslateSourceChange(e: Event) {
		translateConfig = {
			...translateConfig,
			sourceLang: (e.currentTarget as HTMLInputElement).value.trim()
		};
		persistTranslateConfig(translateConfig).catch(() => {});
	}

	function handleTranslateTargetChange(e: Event) {
		translateConfig = {
			...translateConfig,
			targetLang: (e.currentTarget as HTMLInputElement).value.trim()
		};
		persistTranslateConfig(translateConfig).catch(() => {});
	}
</script>

<div class="configurator-layout">
	<div class="meta-editor-box">
		<div class="config-toolbar">
			<span class="cfg-table-name">🖥 Интерфейс</span>
			<div class="toolbar-spacer"></div>
		</div>
		<hr class="divider" />

		{#if loading}
			<div class="navorder-hint">Загрузка конфигурации...</div>
		{:else}
			<div class="navorder-section">
				<div class="group-header-row">
					<span class="group-title">🔀 Порядок и видимость меню (основной режим)</span>
					{#if !editingNavOrder}
						<button
							class="group-add-btn"
							onclick={toggleEditNavOrder}
							title="Настроить порядок типов и таблиц, видимость в основном меню"
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
									<span class="navorder-group-title">{groupTitle(typeDef.type, typeDef.label)}</span
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
												<label class="navorder-visibility" title="Показывать в основном меню">
													<input
														type="checkbox"
														checked={draftVisibility[tableId]}
														onchange={() => toggleTableVisibility(tableId)}
													/>
													<span class="navorder-table-title">{table.title}</span>
												</label>
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
					<div class="navorder-hint">
						Галочка у таблицы — показ в основном режиме. Скрытые таблицы не пропадают из списка: их
						видно и можно вернуть обратно.
					</div>
				{:else}
					<div class="navorder-hint">
						Порядок групп и таблиц основного режима. Нажмите «✎», чтобы менять порядок и видимость
						таблиц в основном меню.
					</div>
				{/if}
			</div>

			<div class="navorder-section">
				<div class="group-header-row">
					<span class="group-title">🌐 Сервис перевода</span>
				</div>
				<div class="translate-config">
					<label class="translate-label">
						Переводчик (синоним → имя поля)
						<select
							bind:value={translateConfig.serviceId}
							onchange={handleTranslateServiceChange}
							class="translate-select"
						>
							<option value="">— автоматически (astro3d переводчик) —</option>
							{#each translateServices as svc}
								<option value={svc.id}>{svc.data?.name || 'Сервис'}</option>
							{/each}
						</select>
					</label>
					<div class="translate-langs">
						<label class="translate-label">
							Язык синонима
							<input
								type="text"
								bind:value={translateConfig.sourceLang}
								oninput={handleTranslateSourceChange}
								placeholder="напр. ru (пусто = язык браузера)"
								class="translate-input"
							/>
						</label>
						<label class="translate-label">
							Язык имени
							<input
								type="text"
								bind:value={translateConfig.targetLang}
								oninput={handleTranslateTargetChange}
								placeholder="напр. en"
								class="translate-input"
							/>
						</label>
					</div>
					<div class="navorder-hint">
						Используется в конфигураторе при вводе синонима: name подставляется переводом (или
						транслитерацией, если сервис/интернет недоступны).
					</div>
				</div>
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
		max-width: 700px;
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
	.toolbar-spacer {
		flex: 1;
	}
	.divider {
		border: 0;
		border-top: 1px solid #e2e8f0;
		margin: 12px 0;
	}
	.navorder-section {
		margin-bottom: 1.25rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid #e5e7eb;
	}
	.group-header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		margin-bottom: 0.5rem;
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
	.navorder-visibility {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
		cursor: pointer;
	}
	.navorder-visibility input {
		width: auto;
		flex-shrink: 0;
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
	.translate-config {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 0 0.25rem;
	}
	.translate-label {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 0.7rem;
		font-weight: 600;
		color: #6b7280;
	}
	.translate-select,
	.translate-input {
		width: 100%;
		box-sizing: border-box;
		padding: 4px 6px;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		font-size: 0.8rem;
		color: #1f2937;
		outline: none;
	}
	.translate-langs {
		display: flex;
		gap: 6px;
	}
	.translate-langs .translate-label {
		flex: 1;
	}
	.navorder-hint {
		font-size: 0.68rem;
		color: #9ca3af;
		line-height: 1.3;
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
</style>
