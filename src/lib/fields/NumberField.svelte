<script lang="ts">
	let { value = $bindable(''), disabled = false, onChange = (_e: Event) => {} } = $props();
</script>

<input type="number" bind:value oninput={(e: Event) => onChange(e)} {disabled} />
