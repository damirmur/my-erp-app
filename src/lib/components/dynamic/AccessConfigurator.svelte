<script lang="ts">
	import { liveQuery } from 'dexie';
	import { db } from '$lib/db/indexeddb';
	import { auth } from '$lib/state/auth.svelte';
	import {
		teamMembers,
		setMemberRole,
		removeMember,
		accessRules,
		upsertRule,
		deleteRule,
		loadAccessMode,
		saveAccessMode,
		setTablePublic,
		tableIsPublic,
		ROLE_OWNER,
		ROLE_ADMIN,
		type AccessAction
	} from '$lib/state/access';
	import { metadata } from '$lib/state/metadata';
	import { syncService } from '$lib/services/sync';

	// Доступно только владельцу/админу (RLS всё равно защищает на сервере).
	let isAdmin = $derived(auth.isAdmin);

	// ---- Режим доступа -------------------------------------------------------
	let accessMode = $state<'open' | 'locked'>('open');

	async function loadMode() {
		accessMode = await loadAccessMode();
	}
	void loadMode();

	async function changeMode(mode: 'open' | 'locked') {
		accessMode = mode;
		await saveAccessMode(mode);
		await syncService.runFullSync();
	}

	// ---- Команда -------------------------------------------------------------
	let team = $state<
		{
			id: string;
			user_id: string;
			display_name: string;
			role: string;
			status: string;
			provider: string;
		}[]
	>([]);

	$effect(() => {
		const observable = liveQuery(() => teamMembers());
		const sub = observable.subscribe({
			next: (rows) => (team = rows),
			error: (e) => console.error('Ошибка чтения команды:', e)
		});
		return () => sub.unsubscribe();
	});

	async function changeRole(memberId: string, role: string) {
		await setMemberRole(memberId, role);
	}

	async function remove(memberId: string, displayName: string) {
		if (!confirm(`Удалить участника «${displayName}» из команды?`)) return;
		await removeMember(memberId);
	}

	// ---- Роли каталога -------------------------------------------------------
	let roles = $state<{ code: string; name: string }[]>([]);

	$effect(() => {
		const observable = liveQuery(async () => {
			const table = await db.meta_tables.where('name').equals('access_roles').first();
			if (!table) return [];
			const rows = await db.data_records.where('table_id').equals(table.id).toArray();
			return rows.map((r) => ({
				code: String(r.data?.code ?? ''),
				name: String(r.data?.name ?? r.data?.code ?? '')
			}));
		});
		const sub = observable.subscribe({
			next: (rows) => (roles = rows),
			error: (e) => console.error('Ошибка чтения ролей:', e)
		});
		return () => sub.unsubscribe();
	});

	// ---- Правила доступа -----------------------------------------------------
	let tables = $state<
		{ id: string; name?: string; title: string; type: string; public: boolean }[]
	>([]);
	let rules = $state<
		{
			id?: string;
			principal_type: string;
			principal_id: string;
			object_type: string;
			object_id: string;
			action: string;
		}[]
	>([]);

	$effect(() => {
		const observable = liveQuery(async () => {
			const tableRows = await db.meta_tables.toArray();
			const top = tableRows
				.filter((t) => !t.parent_table_id && t.type !== 'system' && t.type !== 'tabular')
				.sort((a, b) => a.title.localeCompare(b.title));
			const ruleRows = await accessRules();
			return { top, ruleRows };
		});
		const sub = observable.subscribe({
			next: ({ top, ruleRows }) => {
				tables = top.map((t) => ({
					id: t.id,
					name: t.name,
					title: t.title,
					type: t.type,
					public: tableIsPublic(t)
				}));
				rules = ruleRows as typeof rules;
			},
			error: (e) => console.error('Ошибка чтения правил:', e)
		});
		return () => sub.unsubscribe();
	});

	function hasRule(
		tableId: string,
		principalType: string,
		principalId: string,
		action: string
	): boolean {
		return rules.some(
			(r) =>
				r.object_type === 'table' &&
				r.object_id === tableId &&
				r.principal_type === principalType &&
				r.principal_id === principalId &&
				r.action === action
		);
	}

	async function toggleRule(
		tableId: string,
		principalType: 'anon' | 'role',
		principalId: string,
		action: AccessAction,
		on: boolean
	) {
		const existing = rules.find(
			(r) =>
				r.object_type === 'table' &&
				r.object_id === tableId &&
				r.principal_type === principalType &&
				r.principal_id === principalId &&
				r.action === action
		);
		if (on) {
			await upsertRule({
				principal_type: principalType,
				principal_id: principalId,
				object_type: 'table',
				object_id: tableId,
				action
			});
		} else if (existing?.id) {
			await deleteRule(existing.id);
		}
	}

	async function togglePublic(tableId: string, value: boolean) {
		await setTablePublic(tableId, value);
	}

	function roleTitle(code: string): string {
		return roles.find((r) => r.code === code)?.name ?? code;
	}

	function actionTitle(a: string): string {
		return a === 'view' ? '👁 Просмотр' : a === 'edit' ? '✏️ Изменение' : '▶️ Выполнить';
	}
</script>

<div class="access-layout">
	<div class="config-toolbar">
		<span class="cfg-table-name">🔐 Доступ и команда</span>
	</div>

	{#if !isAdmin}
		<div class="notice">Управление доступом доступно только владельцу и администратору.</div>
	{/if}

	<div class="access-body">
		<!-- 1. Режим доступа -->
		<section class="access-section">
			<h3>Режим доступа</h3>
			<p class="hint">
				<b>Открыт</b> — переходный период: все данные доступны всем (прежнее поведение).
				<b>Защищён</b> — доступ по ролям и правилам ниже; публичные таблицы остаются открытыми гостям.
			</p>
			<div class="mode-row">
				<button
					class="mode-btn"
					class:active={accessMode === 'open'}
					disabled={!isAdmin}
					onclick={() => changeMode('open')}
				>
					Открыт
				</button>
				<button
					class="mode-btn"
					class:active={accessMode === 'locked'}
					disabled={!isAdmin}
					onclick={() => changeMode('locked')}
				>
					Защищён
				</button>
			</div>
			{#if accessMode === 'locked'}
				<div class="lock-note">
					Защита включена: гости видят только публичные таблицы; участники — по своим правилам;
					владелец и администраторы — всё.
				</div>
			{/if}
		</section>

		<!-- 2. Команда -->
		<section class="access-section">
			<h3>Команда</h3>
			<p class="hint">
				Участники регистрируются сами (e-mail, ВКонтакте, Telegram) — их строки появляются здесь со
				статусом «приглашён». Назначьте роль, и участник получит доступ по правилам ниже. Первый
				зарегистрированный становится Владельцем.
			</p>
			{#if team.length === 0}
				<div class="empty">Пока нет участников.</div>
			{:else}
				<table class="team-table">
					<thead>
						<tr>
							<th>Участник</th>
							<th>Вход</th>
							<th>Статус</th>
							<th>Роль</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each team as m}
							<tr>
								<td>{m.display_name || m.user_id.slice(0, 8)}</td>
								<td class="muted">{m.provider}</td>
								<td class="muted">{m.status}</td>
								<td>
									<select
										value={m.role}
										disabled={!isAdmin}
										onchange={(e) => changeRole(m.id, (e.currentTarget as HTMLSelectElement).value)}
									>
										<option value="">— без роли —</option>
										{#each roles as r}
											<option value={r.code}>{r.name}</option>
										{/each}
									</select>
								</td>
								<td>
									{#if isAdmin}
										<button
											class="small-del"
											onclick={() => remove(m.id, m.display_name || m.user_id)}
											title="Удалить из команды">✕</button
										>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<!-- 3. Правила доступа по таблицам -->
		<section class="access-section">
			<h3>Правила доступа по таблицам</h3>
			<p class="hint">
				☑ Публичная — запись/таблица видна гостям без входа. Для ролей — доступ к таблице целиком.
				«Выполнить» доступно тем, кто может изменять таблицу.
			</p>
			{#if tables.length === 0}
				<div class="empty">Таблиц пока нет.</div>
			{:else}
				<table class="rules-table">
					<thead>
						<tr>
							<th>Таблица</th>
							<th title="Доступна гостям без входа">🌐 Публичная</th>
							{#each roles as r}
								<th colspan="2" class="role-col">{r.name}</th>
							{/each}
							<th title="Доступна гостям без входа">👤 Гости</th>
						</tr>
						<tr class="sub-head">
							<th></th>
							<th></th>
							{#each roles as r}
								<th class="sub-cell">👁</th>
								<th class="sub-cell">✏️</th>
							{/each}
							<th class="sub-cell">👁</th>
						</tr>
					</thead>
					<tbody>
						{#each tables as t}
							<tr>
								<td class="table-cell">
									{t.title}
									{#if t.name}<span class="muted code">{t.name}</span>{/if}
								</td>
								<td class="center">
									<input
										type="checkbox"
										checked={t.public}
										disabled={!isAdmin}
										onchange={(e) =>
											togglePublic(t.id, (e.currentTarget as HTMLInputElement).checked)}
									/>
								</td>
								{#each roles as r}
									<td class="center">
										<input
											type="checkbox"
											checked={hasRule(t.id, 'role', r.code, 'view')}
											disabled={!isAdmin || r.code === ROLE_OWNER || r.code === ROLE_ADMIN}
											onchange={(e) =>
												toggleRule(
													t.id,
													'role',
													r.code,
													'view',
													(e.currentTarget as HTMLInputElement).checked
												)}
											title={`${roleTitle(r.code)}: просмотр таблицы`}
										/>
									</td>
									<td class="center">
										<input
											type="checkbox"
											checked={hasRule(t.id, 'role', r.code, 'edit')}
											disabled={!isAdmin || r.code === ROLE_OWNER || r.code === ROLE_ADMIN}
											onchange={(e) =>
												toggleRule(
													t.id,
													'role',
													r.code,
													'edit',
													(e.currentTarget as HTMLInputElement).checked
												)}
											title={`${roleTitle(r.code)}: изменение таблицы`}
										/>
									</td>
								{/each}
								<td class="center">
									<input
										type="checkbox"
										checked={hasRule(t.id, 'anon', '', 'view')}
										disabled={!isAdmin}
										onchange={(e) =>
											toggleRule(
												t.id,
												'anon',
												'',
												'view',
												(e.currentTarget as HTMLInputElement).checked
											)}
										title="Гости: просмотр"
									/>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<div class="hint">
			Изменения публичности/правил применяются сразу; у других пользователей кэш данных очистится
			при следующей синхронизации.
		</div>
	</div>
</div>

<style>
	.access-layout {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: #f8fafc;
	}
	.config-toolbar {
		padding: 0.6rem 1rem;
		border-bottom: 1px solid #e2e8f0;
		background: #fff;
	}
	.cfg-table-name {
		font-weight: 700;
		font-size: 1rem;
		color: #1f2937;
	}
	.access-body {
		flex: 1;
		overflow: auto;
		padding: 1rem 1.25rem;
	}
	.access-section {
		background: #fff;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		padding: 1rem 1.25rem;
		margin-bottom: 1rem;
	}
	.access-section h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
		color: #1f2937;
	}
	.hint {
		font-size: 0.8rem;
		color: #64748b;
		margin: 0 0 0.75rem;
	}
	.mode-row {
		display: flex;
		gap: 8px;
	}
	.mode-btn {
		padding: 8px 18px;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		background: #fff;
		cursor: pointer;
		font-size: 0.9rem;
		color: #475569;
	}
	.mode-btn.active {
		background: #4f46e5;
		border-color: #4f46e5;
		color: #fff;
		font-weight: 600;
	}
	.mode-btn:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
	.lock-note {
		margin-top: 0.75rem;
		padding: 0.6rem 0.8rem;
		background: #fef3c7;
		border: 1px solid #fcd34d;
		border-radius: 6px;
		font-size: 0.8rem;
		color: #92400e;
	}
	.notice {
		padding: 0.75rem 1rem;
		background: #fee2e2;
		color: #991b1b;
		font-size: 0.85rem;
	}
	.empty {
		color: #94a3b8;
		font-size: 0.85rem;
		padding: 0.5rem 0;
	}
	.team-table,
	.rules-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.team-table th,
	.team-table td,
	.rules-table th,
	.rules-table td {
		border-bottom: 1px solid #e2e8f0;
		padding: 6px 8px;
		text-align: left;
	}
	.team-table th,
	.rules-table th {
		background: #f1f5f9;
		color: #475569;
		font-weight: 600;
		font-size: 0.78rem;
	}
	.muted {
		color: #94a3b8;
		font-size: 0.78rem;
	}
	.code {
		margin-left: 6px;
	}
	.center {
		text-align: center;
	}
	.table-cell {
		font-weight: 500;
	}
	.small-del {
		background: none;
		border: none;
		color: #dc2626;
		cursor: pointer;
		font-size: 0.8rem;
	}
	.role-col {
		text-align: center;
	}
	.sub-head th {
		font-size: 0.75rem;
		background: #f8fafc;
	}
	.sub-cell {
		text-align: center;
	}
	select {
		padding: 4px 6px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		font-size: 0.8rem;
	}
</style>
