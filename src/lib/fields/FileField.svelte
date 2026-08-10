<script lang="ts">
	import {
		checkFileSize,
		base64ToBlob,
		blobToBase64,
		downloadBlob,
		formatBytes,
		hydrateFileValue,
		type StoredFile
	} from '$lib/services/files';

	let { value = $bindable<any>(), disabled = false, onChange = (_e: Event) => {} } = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let busy = $state(false);

	// Текущее значение: inline (только что выбранный файл) или развёрнутая из
	// хранилища ссылка (fileId → содержимое загружается асинхронно).
	let current = $state<StoredFile | null>(null);

	$effect(() => {
		const v = value;
		if (v && typeof v === 'object' && typeof v.data === 'string') {
			current = v;
			return;
		}
		if (v && typeof v === 'object' && typeof v.fileId === 'string') {
			let cancelled = false;
			hydrateFileValue(v).then((h) => {
				if (!cancelled) current = h ? (h as StoredFile) : null;
			});
			return () => {
				cancelled = true;
			};
		}
		current = null;
	});

	async function handleSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const err = checkFileSize(file);
		if (err) {
			alert(err);
			input.value = '';
			return;
		}
		busy = true;
		try {
			value = await blobToBase64(file);
			// Сохраняем метаданные рядом с base64
			value = {
				name: file.name,
				size: file.size,
				type: file.type || 'application/octet-stream',
				data: value
			};
			onChange(e);
		} finally {
			busy = false;
			input.value = '';
		}
	}

	function handleDownload() {
		if (!current) return;
		const blob = base64ToBlob(current.data, current.type);
		downloadBlob(blob, current.name);
	}

	function handleRemove() {
		value = '';
		onChange(new Event('change'));
	}
</script>

<div class="file-field">
	{#if current}
		<div class="file-item">
			<span class="file-name" title={current.name}>📄 {current.name}</span>
			<span class="file-size">{formatBytes(current.size)}</span>
			<div class="file-actions">
				<button type="button" class="btn-file" onclick={handleDownload} {disabled}>⬇ Скачать</button
				>
				{#if !disabled}
					<button type="button" class="btn-file btn-file-remove" onclick={handleRemove}
						>🗑 Удалить</button
					>
				{/if}
			</div>
		</div>
	{:else}
		<div class="file-item">
			<span class="file-empty">Файл не выбран</span>
			{#if !disabled}
				<button type="button" class="btn-file" onclick={() => fileInput?.click()} disabled={busy}>
					{busy ? '⏳ Чтение...' : '📂 Выбрать файл'}
				</button>
			{/if}
		</div>
	{/if}
	<input
		bind:this={fileInput}
		type="file"
		class="hidden-input"
		onchange={handleSelect}
		{disabled}
	/>
</div>

<style>
	.file-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.file-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		background: #f8fafc;
		min-height: 32px;
	}
	.file-name {
		font-size: 0.85rem;
		color: #1e293b;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.file-size {
		font-size: 0.75rem;
		color: #64748b;
		white-space: nowrap;
	}
	.file-empty {
		flex: 1;
		font-size: 0.85rem;
		color: #94a3b8;
	}
	.file-actions {
		margin-left: auto;
		display: flex;
		gap: 6px;
	}
	.btn-file {
		background: #e2e8f0;
		border: none;
		border-radius: 4px;
		padding: 4px 10px;
		font-size: 0.8rem;
		cursor: pointer;
		color: #1e293b;
		white-space: nowrap;
	}
	.btn-file:hover:not(:disabled) {
		background: #cbd5e1;
	}
	.btn-file-remove:hover:not(:disabled) {
		background: #fee2e2;
		color: #b91c1c;
	}
	.btn-file:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.hidden-input {
		display: none;
	}
</style>
