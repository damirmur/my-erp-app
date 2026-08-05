<script lang="ts">
	let { value = $bindable(''), disabled = false, onChange = (_e: Event) => {} } = $props();

	let isUrl = $derived(typeof value === 'string' && /^https?:\/\//i.test(value.trim()));

	function openUrl() {
		if (isUrl) window.open(value, '_blank', 'noopener');
	}
</script>

{#if disabled && isUrl}
	<a href={value} target="_blank" rel="noopener noreferrer" class="url-link" title="Открыть ссылку"
		>{value}</a
	>
{:else}
	<div class="string-field">
		<input type="text" bind:value oninput={(e: Event) => onChange(e)} {disabled} />
		{#if isUrl}
			<button
				type="button"
				class="open-url-btn"
				title="Открыть ссылку"
				onclick={(e) => {
					e.stopPropagation();
					openUrl();
				}}>🔗</button
			>
		{/if}
	</div>
{/if}

<style>
	.string-field {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.string-field input {
		flex: 1;
	}
	.url-link {
		color: #2563eb;
		text-decoration: underline;
		font-size: 0.9rem;
	}
	.url-link:hover {
		color: #1d4ed8;
	}
	.open-url-btn {
		background: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 2px 8px;
		line-height: 1.4;
	}
	.open-url-btn:hover {
		background: #eff6ff;
		border-color: #2563eb;
	}
</style>
