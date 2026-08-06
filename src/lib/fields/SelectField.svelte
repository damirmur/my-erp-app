<script lang="ts">
	// Поле «Выбор из списка»: <select> из переданных options [{value,label}].
	// Если options не заданы (колонка без регистрации списка) — обычный ввод.
	let {
		value = $bindable(''),
		disabled = false,
		onChange = (() => {}) as (e: Event) => void,
		options = [] as { value: string; label: string }[]
	} = $props();
</script>

{#if options.length > 0}
	<select {disabled} bind:value onchange={onChange}>
		<option value="">-- выберите --</option>
		{#each options as opt (opt.value)}
			<option value={opt.value}>{opt.label}</option>
		{/each}
	</select>
{:else}
	<input type="text" {disabled} bind:value oninput={onChange} />
{/if}
