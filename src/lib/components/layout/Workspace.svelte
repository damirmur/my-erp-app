<script lang="ts">
	import { workspace } from '$lib/state/workspace.svelte';
	import { syncService } from '$lib/services/sync';
	import DynamicList from '../dynamic/DynamicList.svelte';
	import DynamicForm from '../dynamic/DynamicForm.svelte';
	import ConfiguratorForm from '../dynamic/ConfiguratorForm.svelte';

	let syncing = $state(false);
	let lastSyncLabel = $state<string | null>(null);

	async function handleSync() {
		if (syncing) return;
		syncing = true;
		await syncService.runFullSync();
		syncing = false;
		lastSyncLabel = navigator.onLine
			? `Обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
			: 'Нет соединения';
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
			title={lastSyncLabel ?? 'Синхронизировать с сервером'}
		>
			{syncing ? '⏳' : '🔄'}
		</button>
		{#if lastSyncLabel}
			<span class="sync-label" class:offline={!navigator.onLine}>{lastSyncLabel}</span>
		{/if}

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
	</div>

	<!-- 2. Контентная область активного окна (Динамический рендерер) -->
	<div class="workspace-content">
		{#if workspace.activeTab}
			{#if workspace.activeTab.tableId === 'SYSTEM_CONFIUGRATOR_ID'}
				<ConfiguratorForm
					tabId={workspace.activeTab.id}
					tableId={workspace.activeTab.recordId ?? ''}
				/>
			{:else if workspace.activeTab.type === 'list'}
				<DynamicList tableId={workspace.activeTab.tableId} tabId={workspace.activeTab.id} />
			{:else if workspace.activeTab.type === 'form'}
				<DynamicForm
					tableId={workspace.activeTab.tableId}
					recordId={workspace.activeTab.recordId}
					tabId={workspace.activeTab.id}
				/>
			{/if}
		{:else}
			<div class="empty-workspace-state">
				<div class="hero-logo">📦 Low-Code ERP</div>
				<p>Система готова к работе. Выберите справочник или документ на панели навигации.</p>
			</div>
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
	.sync-label {
		font-size: 0.75rem;
		color: #64748b;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.sync-label.offline {
		color: #dc2626;
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
