<script lang="ts">
	import Sidebar from '$lib/components/layout/Sidebar.svelte';
	import Workspace from '$lib/components/layout/Workspace.svelte';
	import LoginScreen from '$lib/components/layout/LoginScreen.svelte';
	import ApiResultModal from '$lib/components/layout/ApiResultModal.svelte';
	import PrintPreviewModal from '$lib/components/layout/PrintPreviewModal.svelte';
	import { syncService } from '$lib/services/sync';
	import { syncTableTypes } from '$lib/table-types';
	import { workspace } from '$lib/state/workspace.svelte';
	import { metadata } from '$lib/state/metadata';
	import { auth } from '$lib/state/auth.svelte';
	import { registerSandboxPlugins } from '$lib/services/sandboxPlugins';

	// При первом запуске и при смене hash (кнопки назад/вперёд, ручной ввод ссылки)
	// открываем объект по уникальной ссылке #/t/..., #/r/..., #/l/...
	async function openFromHash() {
		if (typeof location === 'undefined' || !location.hash) return;
		await workspace.openFromLink(location.hash);
	}

	// Гостевой режим и вход разрешают работу с данными; пока статус loading —
	// показываем заглушку и синхронизацию не запускаем.
	function canWork(): boolean {
		return auth.isAuthenticated || auth.isGuest;
	}

	$effect(() => {
		syncTableTypes();

		// Хелперы песочницы (parsePdf, runCode, parseNum/parseAmount/parseDate — лениво).
		registerSandboxPlugins();

		// Авторизация: восстановление сессии / возврат от шлюза, затем boot.
		auth.init().then(async () => {
			if (!canWork()) return;
			// Системные таблицы (например, «История») создаём до первой синхронизации,
			// чтобы и офлайн, и после pullMetadata они существовали в локальном кэше.
			await metadata.ensureSystemTables();
			// Сначала загружаем метаданные/данные, затем открываем объект из адресной строки.
			await syncService.runFullSync();
			await openFromHash();
		});

		// Ежеминутный фоновый обмен — только когда есть сессия/гостевой режим.
		const interval = setInterval(() => {
			if (canWork()) void syncService.runFullSync();
		}, 60000);

		// Реагируем на изменение hash (кнопки навигации браузера, вставка ссылки вручную)
		const onHashChange = () => openFromHash();
		window.addEventListener('hashchange', onHashChange);

		return () => {
			clearInterval(interval);
			window.removeEventListener('hashchange', onHashChange);
		};
	});
</script>

{#if auth.status === 'loading'}
	<div class="boot-screen">
		<div class="boot-spinner">⏳</div>
		<div class="boot-text">Подключение к системе…</div>
	</div>
{:else if auth.showLogin}
	<LoginScreen />
{:else if !auth.isAuthenticated && !auth.isGuest}
	<LoginScreen />
{:else}
	<div class="app-layout">
		<Sidebar />
		<Workspace />
	</div>
{/if}

<ApiResultModal />
<PrintPreviewModal />

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
		overflow: hidden;
	}
	.app-layout {
		position: relative;
		display: flex;
		width: 100vw;
		height: 100vh;
		overflow: hidden;
	}
	.boot-screen {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100vh;
		width: 100vw;
		background: #f8fafc;
		color: #64748b;
	}
	.boot-spinner {
		font-size: 2.5rem;
		margin-bottom: 0.75rem;
	}
	.boot-text {
		font-size: 0.95rem;
	}
</style>
