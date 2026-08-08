<script lang="ts">
	import Sidebar from '$lib/components/layout/Sidebar.svelte';
	import Workspace from '$lib/components/layout/Workspace.svelte';
	import ApiResultModal from '$lib/components/layout/ApiResultModal.svelte';
	import PrintPreviewModal from '$lib/components/layout/PrintPreviewModal.svelte';
	import { syncService } from '$lib/services/sync';
	import { syncTableTypes } from '$lib/table-types';
	import { workspace } from '$lib/state/workspace.svelte';
	import { metadata } from '$lib/state/metadata';

	// При первом запуске и при смене hash (кнопки назад/вперёд, ручной ввод ссылки)
	// открываем объект по уникальной ссылке #/t/..., #/r/..., #/l/...
	async function openFromHash() {
		if (typeof location === 'undefined' || !location.hash) return;
		await workspace.openFromLink(location.hash);
	}

	$effect(() => {
		syncTableTypes();

		// Системные таблицы (например, «История») создаём до первой синхронизации,
		// чтобы и офлайн, и после pullMetadata они существовали в локальном кэше
		metadata.ensureSystemTables().then(() => {
			// Сначала загружаем метаданные/данные, затем открываем объект из адресной строки
			syncService.runFullSync().then(() => openFromHash());
		});

		// Опционально: можно настроить ежеминутный фоновый обмен
		const interval = setInterval(() => syncService.runFullSync(), 60000);

		// Реагируем на изменение hash (кнопки навигации браузера, вставка ссылки вручную)
		const onHashChange = () => openFromHash();
		window.addEventListener('hashchange', onHashChange);

		return () => {
			clearInterval(interval);
			window.removeEventListener('hashchange', onHashChange);
		};
	});
</script>

<div class="app-layout">
	<Sidebar />
	<Workspace />
</div>

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
</style>
