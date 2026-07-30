<script lang="ts">
	let { value = $bindable(false), disabled = false, onChange = (_e: Event) => {} } = $props();
</script>

<input type="checkbox" bind:checked={value} onchange={(e: Event) => onChange(e)} {disabled} />
