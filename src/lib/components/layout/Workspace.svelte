<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { workspace } from '$lib/state/workspace.svelte';
	import { auth } from '$lib/state/auth.svelte';
	import { syncService, clearAppStorage } from '$lib/services/sync';
	import { db } from '$lib/db/indexeddb';
	import { buildRecordUrl, buildListUrl } from '$lib/services/deeplink';
	import DynamicList from '../dynamic/DynamicList.svelte';
	import DynamicForm from '../dynamic/DynamicForm.svelte';
	import ConfiguratorForm from '../dynamic/ConfiguratorForm.svelte';
	import TypeConfiguratorForm from '../dynamic/TypeConfiguratorForm.svelte';
	import InterfaceConfigurator from '../dynamic/InterfaceConfigurator.svelte';
	import InfoBaseConfigurator from '../dynamic/InfoBaseConfigurator.svelte';
	import TypesSectionForm from '../dynamic/TypesSectionForm.svelte';
	import AccessConfigurator from '../dynamic/AccessConfigurator.svelte';

	let syncing = $state(false);

	// Синхронизация адресной строки с активной вкладкой: при переключении вкладки
	// обновляем hash-часть URL через replaceState из $app/navigation (не создаёт
	// лишних записей в истории и не триггерит hashchange).
	$effect(() => {
		const tab = workspace.activeTab;
		if (!tab || typeof history === 'undefined') return;
		if (tab.type === 'list' && tab.tableId !== 'SYSTEM_CONFIUGRATOR_ID') {
			replaceState(buildListUrl(tab.tableId), {});
		} else if (
			tab.type === 'form' &&
			tab.recordId &&
			tab.tableId !== 'SYSTEM_CONFIUGRATOR_ID' &&
			tab.tableId !== 'SYSTEM_TYPE_CONFIGURATOR_ID' &&
			tab.tableId !== 'SYSTEM_INTERFACE_CONFIGURATOR_ID' &&
			tab.tableId !== 'SYSTEM_INFOBASE_CONFIGURATOR_ID' &&
			tab.tableId !== 'SYSTEM_TYPES_SECTION_ID' &&
			tab.tableId !== 'SYSTEM_ACCESS_CONFIGURATOR_ID'
		) {
			replaceState(buildRecordUrl(tab.recordId), {});
		}
	});

	// Полное обновление: выталкиваем локальные изменения, очищаем локальный кэш
	// и перезагружаем страницу, чтобы браузер загрузил свежие модули и данные
	async function handleSync() {
		if (syncing) return;
		if (!navigator.onLine) {
			alert('Нет соединения с сервером. Полное обновление невозможно.');
			return;
		}
		if (
			!confirm(
				'Полное обновление:\n1. Отправить локальные изменения на сервер\n2. Очистить локальные данные (IndexedDB), кэш браузера и настройки приложения\n3. Перезагрузить приложение'
			)
		)
			return;
		syncing = true;
		try {
			// 1. Сначала отправляем локальные изменения на сервер
			await syncService.runFullSync();

			// 2. Очищаем локальный кэш IndexedDB (свежие данные подтянутся при старте)
			await db.transaction(
				'rw',
				[db.meta_tables, db.meta_columns, db.data_records, db.data_lines, db.data_files],
				async () => {
					await db.meta_tables.clear();
					await db.meta_columns.clear();
					await db.data_records.clear();
					await db.data_lines.clear();
					await db.data_files.clear();
				}
			);

			// 3. Сбрасываем HTTP-кэш браузера (модули приложения)
			if ('caches' in window) {
				const keys = await caches.keys();
				await Promise.all(keys.map((k) => caches.delete(k)));
			}

			// 4. Сбрасываем ключи приложения в localStorage (версия сидов, якорь
			// синка, версия метаданных, настройки меню). Сессию Supabase не трогаем.
			clearAppStorage();

			// 5. Жёсткая перезагрузка: новый URL, чтобы страница не взялась из кэша.
			// После загрузки приложение само выполнит полную синхронизацию (см. +page.svelte)
			const url = new URL(location.href);
			url.searchParams.set('hard', String(Date.now()));
			location.replace(url.toString());
		} catch (e: any) {
			console.error('Ошибка полного обновления:', e);
			alert(`Ошибка полного обновления: ${e?.message ?? e}`);
			syncing = false;
		}
	}
</script>

<main class="workspace">
	<!-- 1. Панель вкладок (Верхняя командная строка окон) -->
	<div class="tabs-bar">
		<button
			onclick={() => workspace.toggleSidebar()}
			class="sidebar-toggle-btn"
			title={workspace.sidebarCollapsed ? 'Показать панель разделов' : 'Скрыть панель разделов'}
		>
			{workspace.sidebarCollapsed ? '▶' : '◀'}
		</button>

		<button
			onclick={handleSync}
			class="sync-btn"
			class:syncing
			disabled={syncing}
			title="Полное обновление: синхронизация + очистка локального кэша + перезагрузка"
		>
			{syncing ? '⏳' : '🔄'}
		</button>
		{#if workspace.tabs.length === 0}
			<div class="tabs-empty-text">Нет открытых окон. Выберите раздел слева.</div>
		{/if}

		<div class="tabs-scroll-container">
			{#each workspace.tabs as tab (tab.id)}
				<div class="tab-button" class:active={workspace.activeTabId === tab.id}>
					<!-- Клик по названию переключает активное окно -->
					<button onclick={() => (workspace.activeTabId = tab.id)} class="tab-title-btn">
						{tab.title}
						{#if tab.isDirty}<span class="dirty-marker">*</span>{/if}
					</button>

					<!-- Кнопка закрытия окна (крестик) -->
					<button
						onclick={() => workspace.closeTab(tab.id)}
						class="tab-close-btn"
						title="Закрыть вкладку"
					>
						✕
					</button>
				</div>
			{/each}
		</div>

		<div class="user-area">
			{#if auth.isAuthenticated}
				<span class="user-chip" title={auth.user?.email ?? ''}>
					<span class="user-dot"></span>
					{auth.displayName || 'Пользователь'}
					{#if auth.role}<span class="user-role">({auth.role})</span>{/if}
				</span>
				<button class="logout-btn" onclick={() => auth.signOut()} title="Выйти">⎋</button>
			{:else}
				<span class="user-chip"><span class="user-dot user-dot-guest"></span>Гость</span>
				<button class="logout-btn" onclick={() => (auth.showLogin = true)} title="Войти">🔐</button>
			{/if}
		</div>
	</div>

	<!-- 2. Контентная область окон. Все открытые вкладки держим в DOM (keep-alive):
	     состояние списков/форм сохраняется при переключении — не перечитываем
	     IndexedDB при каждом переключении, не теряем незаписанные правки. -->
	<div class="workspace-content">
		{#if workspace.tabs.length === 0}
			<div class="empty-workspace-state">
				<div class="hero-logo">🛠️ Low-Code «Our life - our rules»</div>
				<p>Система готова к работе. Настройте её правила под комфортный work-life balance.</p>
			</div>
		{:else}
			{#each workspace.tabs as tab (tab.id)}
				<div class="tab-pane" style={workspace.activeTabId === tab.id ? '' : 'display: none'}>
					{#if tab.tableId === 'SYSTEM_CONFIUGRATOR_ID'}
						<ConfiguratorForm tabId={tab.id} tableId={tab.recordId ?? ''} />
					{:else if tab.tableId === 'SYSTEM_TYPE_CONFIGURATOR_ID'}
						<TypeConfiguratorForm tabId={tab.id} typeName={tab.recordId ?? ''} />
					{:else if tab.tableId === 'SYSTEM_INTERFACE_CONFIGURATOR_ID'}
						<InterfaceConfigurator />
					{:else if tab.tableId === 'SYSTEM_INFOBASE_CONFIGURATOR_ID'}
						<InfoBaseConfigurator />
					{:else if tab.tableId === 'SYSTEM_TYPES_SECTION_ID'}
						<TypesSectionForm />
					{:else if tab.tableId === 'SYSTEM_ACCESS_CONFIGURATOR_ID'}
						<AccessConfigurator />
					{:else if tab.type === 'list'}
						<DynamicList tableId={tab.tableId} tabId={tab.id} />
					{:else if tab.type === 'form'}
						<DynamicForm
							tableId={tab.tableId}
							recordId={tab.recordId}
							tabId={tab.id}
							focusLineId={tab.focusLineId ?? ''}
							initialParentId={tab.initialParentId ?? ''}
						/>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</main>

<style>
	.workspace {
		flex: 1;
		display: flex;
		flex-direction: column;
		height: 100vh;
		background-color: #ffffff;
		overflow: hidden;
	}
	.tabs-bar {
		background-color: #eaeded;
		border-bottom: 1px solid #cbd5e1;
		min-height: 40px;
		display: flex;
		align-items: center;
		padding: 0 0.5rem;
		gap: 4px;
	}
	.sidebar-toggle-btn {
		background: none;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		color: #475569;
		font-size: 0.75rem;
		width: 28px;
		height: 28px;
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background-color 0.2s,
			color 0.2s;
	}
	.sidebar-toggle-btn:hover {
		background-color: #e2e8f0;
		color: #1f2937;
	}
	.sync-btn {
		background: none;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		color: #475569;
		font-size: 0.8rem;
		width: 28px;
		height: 28px;
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background-color 0.2s,
			color 0.2s;
	}
	.sync-btn:hover:not(:disabled) {
		background-color: #e2e8f0;
		color: #1f2937;
	}
	.sync-btn:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.tabs-empty-text {
		font-size: 0.85rem;
		color: #94a3b8;
		padding-left: 0.5rem;
	}
	.tabs-scroll-container {
		display: flex;
		gap: 4px;
		overflow-x: auto;
		flex: 1;
	}
	.user-area {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		margin-left: 6px;
	}
	.user-chip {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 0.8rem;
		color: #475569;
		background: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 999px;
		padding: 3px 10px;
		white-space: nowrap;
	}
	.user-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #22c55e;
		flex-shrink: 0;
	}
	.user-dot-guest {
		background: #94a3b8;
	}
	.user-role {
		color: #94a3b8;
		font-size: 0.7rem;
	}
	.logout-btn {
		background: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		width: 28px;
		height: 28px;
		cursor: pointer;
		color: #64748b;
		font-size: 0.85rem;
		flex-shrink: 0;
	}
	.logout-btn:hover {
		background: #fee2e2;
		color: #dc2626;
	}
	/* Стилизация вкладки в духе嚴форм 1С */
	.tab-button {
		display: flex;
		align-items: center;
		background-color: #e2e8f0;
		border: 1px solid #cbd5e1;
		border-bottom: none;
		border-top-left-radius: 4px;
		border-top-right-radius: 4px;
		padding: 4px 8px;
		font-size: 0.85rem;
		height: 32px;
		margin-top: 8px;
		user-select: none;
	}
	.tab-button.active {
		background-color: #ffffff;
		border-color: #cbd5e1;
		position: relative;
		z-index: 1;
		font-weight: 500;
		box-shadow: 0 -2px 4px rgba(0, 0, 0, 0.05);
	}
	.tab-title-btn {
		background: none;
		border: none;
		padding: 0;
		margin-right: 8px;
		color: #334155;
		cursor: pointer;
		display: flex;
		align-items: center;
		white-space: nowrap;
	}
	.dirty-marker {
		color: #ef4444;
		font-weight: bold;
		margin-left: 2px;
	}
	.tab-close-btn {
		background: none;
		border: none;
		color: #94a3b8;
		cursor: pointer;
		font-size: 0.75rem;
		padding: 2px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
	}
	.tab-close-btn:hover {
		background-color: #f1f5f9;
		color: #64748b;
	}
	.workspace-content {
		flex: 1;
		overflow: auto;
		position: relative;
		background-color: #ffffff;
	}
	.tab-pane {
		height: 100%;
	}
	.empty-workspace-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: #64748b;
		text-align: center;
	}
	.hero-logo {
		font-size: 2.5rem;
		font-weight: 800;
		color: #cbd5e1;
		margin-bottom: 1rem;
	}
</style>
