<script lang="ts">
	let { value = $bindable(''), disabled = false, onChange = (_e: Event) => {} } = $props();

	let error = $state('');

	function validate(raw: string): boolean {
		if (!raw.trim()) {
			error = '';
			return true;
		}
		try {
			JSON.parse(raw);
			error = '';
			return true;
		} catch (e: any) {
			error = e?.message ?? 'Некорректный JSON';
			return false;
		}
	}

	// Нормализуем значение: null/undefined -> '', объект -> строка
	$effect(() => {
		if (value == null) {
			value = '';
		} else if (typeof value !== 'string') {
			value = JSON.stringify(value, null, 2);
		}
	});

	function handleInput(e: Event) {
		validate(value);
		onChange(e);
	}
</script>

<div class="json-field">
	<textarea
		bind:value
		oninput={handleInput}
		{disabled}
		rows="5"
		spellcheck="false"
		class="json-textarea"
		class:invalid={!!error}></textarea>
	{#if error}
		<div class="json-error">Некорректный JSON: {error}</div>
	{/if}
</div>

<style>
	.json-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.json-textarea {
		width: 100%;
		box-sizing: border-box;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8rem;
		padding: 6px 8px;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		outline: none;
		resize: vertical;
	}
	.json-textarea:focus {
		border-color: #3b82f6;
	}
	.json-textarea.invalid {
		border-color: #ef4444;
	}
	.json-error {
		font-size: 0.75rem;
		color: #ef4444;
	}
</style>
