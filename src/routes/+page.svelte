<script lang="ts">
	import Sidebar from '$lib/components/layout/Sidebar.svelte';
	import Workspace from '$lib/components/layout/Workspace.svelte';
	import { syncService } from '$lib/services/sync';
	import { syncTableTypes } from '$lib/table-types';

	// Запускаем полную синхронизацию метаданных и данных при старте приложения
	$effect(() => {
		syncTableTypes();
		syncService.runFullSync();
		
		// Опционально: можно настроить ежеминутный фоновый обмен
		const interval = setInterval(() => syncService.runFullSync(), 60000);
		return () => clearInterval(interval);
	});
</script>

<div class="app-layout">
	<Sidebar />
	<Workspace />
</div>

<style>
	:global(body) { margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; }
	.app-layout { display: flex; width: 100vw; height: 100vh; overflow: hidden; }
</style>

