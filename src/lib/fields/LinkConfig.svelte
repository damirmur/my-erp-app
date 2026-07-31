<script lang="ts">
	import { db, type LocalTable } from '$lib/db/indexeddb';

	let { relatedTableId = $bindable(''), allTables = [] as LocalTable[] } = $props();
</script>

<select aria-label="Справочник связи" bind:value={relatedTableId}>
	<option value="">-- Выберите справочник --</option>
	{#each allTables.filter((t) => t.type === 'directory') as t}
		<option value={t.id}>{t.title}</option>
	{/each}
</select>
