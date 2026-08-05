<script lang="ts">
	import LookupInput from '$lib/components/ui/LookupInput.svelte';
	import type { LocalRecord } from '$lib/db/indexeddb';

	let {
		value = $bindable(''),
		disabled = false,
		onChange = (_record: LocalRecord) => {},
		relatedTableId = ''
	} = $props();
</script>

<LookupInput
	bind:value
	targetTableId={relatedTableId}
	{disabled}
	onSelect={(record: LocalRecord) => onChange(record)}
/>
