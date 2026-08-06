<script lang="ts">
	import {
		getTableType,
		tableTypeList,
		saveTableTypeDefinitionDB,
		FEATURE_KEYS,
		FEATURE_LABELS,
		type TableTypeModule
	} from '$lib/table-types';
	import { fieldTypeList } from '$lib/fields';
	import { supabase } from '$lib/db/supabase';
	import { workspace } from '$lib/state/workspace.svelte';

	// Вкладка редактирования типов таблиц: показывает «предустановки» типа
	// (статусы, фичи, шаблон полей) и позволяет их менять. Вкладка общая —
	// typeName (recordId) переключается через выпадающий список.
	let { tabId = '', typeName = '' } = $props();

	interface StatusDraft {
		key: string;
		value: string;
		label: string;
		icon: string;
		badgeClass: string;
		isReadOnly: boolean;
		role: '' | 'posted' | 'deleted';
	}
	interface FieldDraft {
		key: string;
		name: string;
		title: string;
		type: string;
	}

	let selectedTypeName = $state('');
	let label = $state('');
	let statuses = $state<StatusDraft[]>([]);
	let features = $state<Record<string, boolean>>({});
	let fields = $state<FieldDraft[]>([]);
	let displayActions = $state<TableTypeModule['actions']>([]);
	let originalActions: TableTypeModule['actions'] = [];
	let rawDefinition: Record<string, any> | null = null;
	let selectValue = $state('');
	let saving = $state(false);

	let dirty = $derived(workspace.tabs.find((t) => t.id === tabId)?.isDirty ?? false);

	let typeOptions = $derived.by(() => {
		const list = [...$tableTypeList];
		list.sort((a, b) => a.label.localeCompare(b.label));
		return list;
	});

	function markDirty() {
		workspace.setDirty(tabId, true);
	}

	async function load(name: string) {
		const mod = getTableType(name);
		selectedTypeName = name;
		selectValue = name;
		label = mod.label;
		originalActions = mod.actions;
		displayActions = mod.actions;
		statuses = mod.statuses.map((s) => ({
			key: crypto.randomUUID(),
			value: s.value,
			label: s.label,
			icon: s.icon,
			badgeClass: s.badgeClass,
			isReadOnly: s.isReadOnly,
			role: s.role ?? ''
		}));
		features = { ...mod.features };
		fields = (mod.fields ?? []).map((f) => ({
			key: crypto.randomUUID(),
			name: f.name,
			title: f.title,
			type: f.type
		}));
		// Сырое определение (в т.ч. действия с showWhen) — сохраняем при записи,
		// чтобы не потерять условия показа кастомных кнопок.
		rawDefinition = null;
		try {
			const { data } = await supabase
				.from('meta_table_types')
				.select('definition')
				.eq('name', name)
				.maybeSingle();
			rawDefinition = (data?.definition as any) ?? null;
		} catch {
			rawDefinition = null;
		}
		workspace.updateTabTitle(tabId, `🗂 Тип: ${label}`);
	}

	$effect(() => {
		if (typeName && typeName !== selectedTypeName) {
			load(typeName);
		}
	});

	function handleTypeSwitch() {
		const next = selectValue;
		if (next === selectedTypeName) return;
		if (dirty && !confirm('Переключиться на другой тип? Несохранённые изменения будут потеряны.')) {
			selectValue = selectedTypeName;
			return;
		}
		const mod = getTableType(next);
		workspace.openTypeConfigurator(next, mod.label);
	}

	// ==== Статусы ====
	function addStatus() {
		statuses = [
			...statuses,
			{
				key: crypto.randomUUID(),
				value: 'new_status',
				label: 'Новый статус',
				icon: '⚪',
				badgeClass: 'status-draft',
				isReadOnly: false,
				role: ''
			}
		];
		markDirty();
	}
	function removeStatus(i: number) {
		statuses = statuses.filter((_, idx) => idx !== i);
		markDirty();
	}
	function moveStatus(i: number, dir: number) {
		const j = i + dir;
		if (j < 0 || j >= statuses.length) return;
		const arr = [...statuses];
		[arr[i], arr[j]] = [arr[j], arr[i]];
		statuses = arr;
		markDirty();
	}

	// ==== Шаблон полей ====
	function addField() {
		fields = [
			...fields,
			{ key: crypto.randomUUID(), name: 'field', title: 'Поле', type: 'string' }
		];
		markDirty();
	}
	function removeField(i: number) {
		fields = fields.filter((_, idx) => idx !== i);
		markDirty();
	}
	function moveField(i: number, dir: number) {
		const j = i + dir;
		if (j < 0 || j >= fields.length) return;
		const arr = [...fields];
		[arr[i], arr[j]] = [arr[j], arr[i]];
		fields = arr;
		markDirty();
	}

	async function handleSave() {
		if (!selectedTypeName) return;
		saving = true;
		try {
			const finalLabel = label.trim() || selectedTypeName;
			const definition = {
				statuses: statuses.map((s) => ({
					value: s.value.trim() || 'draft',
					label: s.label.trim() || s.value.trim() || 'Статус',
					icon: s.icon.trim() || '⚪',
					badgeClass: s.badgeClass.trim() || 'status-draft',
					isReadOnly: s.isReadOnly,
					role: s.role || undefined
				})),
				features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, !!features[k]])),
				fields: fields
					.filter((f) => f.name.trim())
					.map((f) => ({ name: f.name.trim(), title: f.title.trim(), type: f.type })),
				// Действия сохраняем в исходном виде (сырое определение или пусто)
				actions: Array.isArray(rawDefinition?.actions) ? rawDefinition.actions : []
			};
			await saveTableTypeDefinitionDB(selectedTypeName, finalLabel, definition);
			workspace.setDirty(tabId, false);
			workspace.updateTabTitle(tabId, `🗂 Тип: ${finalLabel}`);
			alert('Тип сохранён');
		} catch (e: any) {
			alert(`Ошибка сохранения типа: ${e?.message ?? e}`);
		} finally {
			saving = false;
		}
	}

	async function handleCancel() {
		if (dirty && !confirm('Отменить все несохраненные изменения?')) return;
		workspace.setDirty(tabId, false);
		await load(selectedTypeName);
	}
</script>

<div class="configurator-layout">
	<div class="meta-editor-box">
		<div class="config-toolbar">
			<span class="cfg-table-name">🗂 Типы таблиц</span>
			<select class="type-switch" value={selectValue} onchange={handleTypeSwitch}>
				{#each typeOptions as t}
					<option value={t.type}>{t.label} ({t.type})</option>
				{/each}
			</select>
			{#if dirty}<span class="dirty-flag">*</span>{/if}
			<div class="toolbar-spacer"></div>
			<button onclick={handleSave} class="btn-blue" disabled={saving}>
				{saving ? '⏳ Запись...' : '💾 Записать'}
			</button>
			<button onclick={handleCancel} class="btn-cancel" disabled={!dirty}>✕ Отмена</button>
		</div>
		<hr class="divider" />

		<div class="field-group">
			<label for="type-label">Синоним типа</label>
			<input
				id="type-label"
				type="text"
				bind:value={label}
				oninput={markDirty}
				placeholder="Синоним (рус.)"
			/>
			<div class="cfg-type-hint">Код типа: {selectedTypeName}</div>
		</div>

		<!-- 1. Статусы -->
		<h4>1. Статусы записей:</h4>
		<table class="config-table">
			<thead>
				<tr>
					<th class="text-center"></th>
					<th>Код</th>
					<th>Название</th>
					<th>Иконка</th>
					<th>Бейдж (CSS-класс)</th>
					<th class="text-center">ReadOnly</th>
					<th>Роль</th>
				</tr>
			</thead>
			<tbody>
				{#each statuses as st, i}
					<tr>
						<td class="text-center">
							<button
								class="btn-icon-edit"
								onclick={() => moveStatus(i, -1)}
								title="Выше"
								disabled={i === 0}>▲</button
							>
							<button
								class="btn-icon-edit"
								onclick={() => moveStatus(i, 1)}
								title="Ниже"
								disabled={i === statuses.length - 1}>▼</button
							>
							<button class="btn-icon-del" onclick={() => removeStatus(i)} title="Удалить">✕</button
							>
						</td>
						<td><input type="text" bind:value={st.value} oninput={markDirty} /></td>
						<td><input type="text" bind:value={st.label} oninput={markDirty} /></td>
						<td
							><input type="text" bind:value={st.icon} oninput={markDirty} style="width:48px" /></td
						>
						<td><input type="text" bind:value={st.badgeClass} oninput={markDirty} /></td>
						<td class="text-center">
							<input type="checkbox" bind:checked={st.isReadOnly} onchange={markDirty} />
						</td>
						<td>
							<select bind:value={st.role} onchange={markDirty}>
								<option value="">—</option>
								<option value="posted">Проведение</option>
								<option value="deleted">Удаление</option>
							</select>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<button onclick={addStatus} class="btn-blue">➕ Добавить статус</button>
		<div class="cfg-type-hint">
			Роль статуса управляет стандартными кнопками: «Проведение» — Провести/Отменить проведение,
			«Удаление» — Пометить на удаление/Восстановить.
		</div>

		<!-- 2. Фичи -->
		<h4 style="margin-top:2rem;">2. Возможности (кнопки и режимы):</h4>
		<div class="config-grid">
			{#each FEATURE_KEYS as fk}
				<label class="cfg-check">
					<input type="checkbox" bind:checked={features[fk]} onchange={markDirty} />
					{FEATURE_LABELS[fk]}
				</label>
			{/each}
		</div>

		<!-- 3. Шаблон полей -->
		<h4 style="margin-top:2rem;">3. Шаблон полей (создаются при создании таблицы):</h4>
		<table class="config-table">
			<thead>
				<tr>
					<th class="text-center"></th>
					<th>Код</th>
					<th>Название</th>
					<th>Тип</th>
				</tr>
			</thead>
			<tbody>
				{#each fields as f, i}
					<tr>
						<td class="text-center">
							<button
								class="btn-icon-edit"
								onclick={() => moveField(i, -1)}
								title="Выше"
								disabled={i === 0}>▲</button
							>
							<button
								class="btn-icon-edit"
								onclick={() => moveField(i, 1)}
								title="Ниже"
								disabled={i === fields.length - 1}>▼</button
							>
							<button class="btn-icon-del" onclick={() => removeField(i)} title="Удалить">✕</button>
						</td>
						<td><input type="text" bind:value={f.name} oninput={markDirty} /></td>
						<td><input type="text" bind:value={f.title} oninput={markDirty} /></td>
						<td>
							<select bind:value={f.type} onchange={markDirty}>
								{#each fieldTypeList as ft}
									<option value={ft.type}>{ft.label}</option>
								{/each}
							</select>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<button onclick={addField} class="btn-blue">➕ Добавить поле</button>

		<!-- 4. Кастомные действия -->
		<h4 style="margin-top:2rem;">4. Кастомные действия (доп. кнопки):</h4>
		{#if displayActions.length === 0}
			<div class="cfg-type-hint">
				Кастомных действий нет — кнопки формируются автоматически из фич выше.
			</div>
		{:else}
			<ul class="type-actions-list">
				{#each displayActions as a}
					<li>
						{a.icon}
						{a.label}
						<span class="cfg-type-hint">({a.type === 'list' ? 'список' : 'форма'})</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<style>
	.configurator-layout {
		padding: 16px;
		max-width: 900px;
	}
	.meta-editor-box {
		background: #fff;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		padding: 16px;
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
	.dirty-flag {
		color: #ef4444;
		font-weight: bold;
	}
	.toolbar-spacer {
		flex: 1;
	}
	.type-switch {
		min-width: 220px;
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
	.cfg-type-hint {
		font-size: 0.75rem;
		color: #64748b;
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
	.btn-cancel {
		background: #e2e8f0;
		color: #475569;
		border: none;
		padding: 6px 12px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
	}
	h4 {
		margin: 0.5rem 0;
		font-size: 0.9rem;
		color: #334155;
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
	.config-table input,
	.config-table select {
		width: 100%;
		box-sizing: border-box;
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
	.btn-icon-del:hover,
	.btn-icon-edit:hover {
		opacity: 0.6;
	}
	.btn-icon-edit:disabled {
		opacity: 0.3;
		cursor: default;
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
	.type-actions-list {
		margin: 0;
		padding-left: 1.2rem;
		font-size: 0.85rem;
		color: #334155;
	}
</style>
