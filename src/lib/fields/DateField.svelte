<script lang="ts">
	let { value = $bindable(''), disabled = false, onChange = (_e: Event) => {} } = $props();
</script>

<input type="date" bind:value oninput={(e: Event) => onChange(e)} {disabled} />
