<script lang="ts">
	import LookupInput from '$lib/components/ui/LookupInput.svelte';
	import type { LocalRecord } from '$lib/db/indexeddb';

	// Поле «Группа» (иерархия): выбор родительской папки. В отличие от обычного
	// поля-ссылки показывает ТОЛЬКО папки (is_folder) и исключает из списка выбора
	// записи из набора forbidden (сама запись, её текущая группа, все потомки —
	// полная защита от циклов).
	let {
		value = $bindable(''),
		disabled = false,
		tableId = '',
		forbidden = new Set<string>(),
		onChange = (_record: LocalRecord) => {}
	} = $props<{
		value: string;
		disabled?: boolean;
		tableId: string;
		forbidden?: Set<string>;
		onChange?: (record: LocalRecord) => void;
	}>();
</script>

<LookupInput
	bind:value
	targetTableId={tableId}
	{disabled}
	filter={(r) => r.is_folder === true && !forbidden.has(r.id)}
	onSelect={(record: LocalRecord) => onChange(record)}
/>
