<script lang="ts">
	import type { LocalTable } from '$lib/db/indexeddb';

	let { relatedTableId = $bindable(''), allTables = [] as LocalTable[] } = $props();

	// Ссылаться можно на любую таблицу верхнего уровня (кроме табличных частей)
	let linkTargets = $derived(allTables.filter((t) => !t.parent_table_id));
</script>

<select aria-label="Таблица связи" bind:value={relatedTableId}>
	<option value="">-- Выберите таблицу --</option>
	{#each linkTargets as t}
		<option value={t.id}>{t.title} ({t.type})</option>
	{/each}
</select>
