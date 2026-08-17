<script lang="ts">
	import { db, type LocalTable } from '$lib/db/indexeddb';
	import { workspace } from '$lib/state/workspace.svelte';
	import { metadata } from '$lib/state/metadata';
	import { syncService } from '$lib/services/sync';
	import { liveQuery } from 'dexie';
	import { tableTypeList, deleteTableTypeFromDB, createTableTypeFromBase } from '$lib/table-types';
	import { translit } from '$lib/services/nameAuto';

	// Вкладка «Работа с типами таблиц»: список типов, создание от базового, удаление.

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

	// Типы таблиц (встроенные + из БД), по алфавиту для списка
	let typeList = $derived.by(() => {
		const types = [...$tableTypeList];
		types.sort((a, b) => a.label.localeCompare(b.label));
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
			error: (err) => console.error('Ошибка живого запроса типов:', err)
		});
		return () => subscription.unsubscribe();
	});

	// Таблицы, сгруппированные по типу (для счётчиков и удаления типа)
	let tablesByType = $derived.by(() => {
		const map: Record<string, LocalTable[]> = {};
		tables.forEach((table) => {
			(map[table.type] ??= []).push(table);
		});
		return map;
	});

	// ---- Создание и удаление типов ----
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
		const tbls = tablesByType[typeName] ?? [];
		if (tbls.length > 0) {
			// Разрешаем удаление, только если у типа нет таблиц с данными.
			// Пустые таблицы (ошибочно созданные) удаляем вместе с типом.
			const withData: LocalTable[] = [];
			const empty: LocalTable[] = [];
			for (const t of tbls) {
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

	// Фокус на поле создания при появлении
	function autofocusInput(node: HTMLInputElement) {
		node.focus();
	}
</script>

<div class="configurator-layout">
	<div class="meta-editor-box">
		<div class="config-toolbar">
			<span class="cfg-table-name">🗂 Работа с типами таблиц</span>
			<div class="toolbar-spacer"></div>
		</div>
		<hr class="divider" />

		{#if loading}
			<div class="navorder-hint">Загрузка конфигурации...</div>
		{:else}
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
								onclick={() => workspace.openTypeConfigurator(t.type, groupTitle(t.type, t.label))}
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
				<div class="navorder-hint">
					Каждый тип — это набор статусов, возможностей (кнопок) и шаблона полей. «✎» открывает
					редактор предустановок типа.
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
	.types-section {
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
	.group-add-btn.active {
		background-color: #e5e7eb;
		color: #16a34a;
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
	.nav-item-code {
		font-size: 0.7rem;
		color: #9ca3af;
		flex-shrink: 0;
		max-width: 90px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row-edit-btn,
	.row-del-btn {
		background: none;
		border: none;
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
		color: #64748b;
	}
	.row-del-btn {
		color: #ef4444;
	}
	.row-edit-btn:hover {
		background: #e2e8f0;
		color: #1f2937;
	}
	.row-del-btn:hover {
		background-color: #fee2e2;
	}
	.type-row:hover .row-edit-btn,
	.type-row:hover .row-del-btn {
		visibility: visible;
		opacity: 1;
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
	.navorder-hint {
		font-size: 0.68rem;
		color: #9ca3af;
		line-height: 1.3;
		margin-top: 0.5rem;
	}
</style>
