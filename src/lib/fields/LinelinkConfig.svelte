<script lang="ts">
	import { db, type LocalLine, type LocalTable } from '$lib/db/indexeddb';

	// Конфигуратор типа поля «Ссылка на строку ТЧ»: целевая ТЧ — любая табличная
	// часть (таблица с parent_table_id). В отличие от «Ссылки» на верхнеуровневые
	// таблицы, здесь выбираются строки ТЧ текущей записи.
	let { relatedTableId = $bindable(''), allTables = [] as LocalTable[] } = $props();

	// Ссылаться можно на любую табличную часть (подчинённую таблицу)
	let linkTargets = $derived(allTables.filter((t) => t.parent_table_id));
</script>

<select aria-label="Табличная часть" bind:value={relatedTableId}>
	<option value="">-- Выберите табличную часть --</option>
	{#each linkTargets as t}
		<option value={t.id}>{t.title}</option>
	{/each}
</select>
