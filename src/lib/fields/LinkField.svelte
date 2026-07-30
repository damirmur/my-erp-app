<script lang="ts">
	import LookupInput from '$lib/components/ui/LookupInput.svelte';

	let { value = $bindable(''), disabled = false, onChange = (_data: Record<string, unknown>) => {}, relatedTableId = '' } = $props();
</script>

<LookupInput bind:value targetTableId={relatedTableId} disabled onSelect={(data: Record<string, unknown>) => onChange(data)} />
