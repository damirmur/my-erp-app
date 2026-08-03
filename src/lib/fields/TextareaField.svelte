<script lang="ts">
	let { value = $bindable(''), disabled = false, onChange = (_e: Event) => {} } = $props();
</script>

<textarea bind:value oninput={(e: Event) => onChange(e)} {disabled} rows="4" class="textarea-field"
></textarea>

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
	}
	.textarea-field:focus {
		border-color: #3b82f6;
	}
</style>
