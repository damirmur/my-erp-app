<script lang="ts">
	let {
		value = $bindable(''),
		disabled = false,
		onChange = (_e: Event) => {},
		autogrow = false
	} = $props();

	let textarea: HTMLTextAreaElement | undefined = $state();

	// Высота по содержимому (autogrow: true для шаблона печатной формы)
	function autoGrow() {
		if (!autogrow || !textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = textarea.scrollHeight + 'px';
	}

	$effect(() => {
		if (autogrow && textarea) autoGrow();
	});
</script>

<textarea
	bind:value
	bind:this={textarea}
	oninput={(e: Event) => {
		onChange(e);
		autoGrow();
	}}
	{disabled}
	rows="4"
	class="textarea-field"></textarea>

<style>
	.textarea-field {
		width: 100%;
		box-sizing: border-box;
		font-family: inherit;
		font-size: 0.85rem;
		padding: 6px 8px;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		outline: none;
		resize: vertical;
		min-height: 40px;
	}
	.textarea-field:focus {
		border-color: #3b82f6;
	}
</style>
