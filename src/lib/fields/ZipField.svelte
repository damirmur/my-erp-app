<script lang="ts">
	import {
		base64ToBlob,
		blobToBase64,
		checkFileSize,
		downloadBlob,
		formatBytes,
		hydrateFileValue,
		MAX_FILE_SIZE,
		type StoredZip
	} from '$lib/services/files';
	import { onMount } from 'svelte';

	let { value = $bindable<any>(), disabled = false, onChange = (_e: Event) => {} } = $props();

	type Entry = { name: string; size: number; blob: Blob };

	let entries = $state<Entry[]>([]);
	let fileInput = $state<HTMLInputElement | null>(null);
	let busy = $state(false);

	// useCompressionStream: false — обход бага нативного CompressionStream
	const zipOpts = { useWebWorkers: false, useCompressionStream: false };

	let current = $derived<StoredZip | null>(
		value && typeof value === 'object' && Array.isArray(value.files) ? value : null
	);
	let totalSize = $derived(entries.reduce((sum, e) => sum + e.size, 0));

	// zip.js загружается из вендорного модуля при первом использовании поля
	async function loadZipApi() {
		const mod: any = await import('$lib/vendor/zip.min.js');
		return mod;
	}

	async function readEntries(zipBlob: Blob): Promise<Entry[]> {
		const { ZipReader, BlobReader, BlobWriter } = await loadZipApi();
		const reader = new ZipReader(new BlobReader(zipBlob), zipOpts);
		const list = await reader.getEntries();
		const result: Entry[] = [];
		for (const entry of list) {
			const data = await entry.getData(new BlobWriter(), zipOpts);
			result.push({
				name: entry.filename,
				size: entry.uncompressedSize ?? data.size,
				blob: data
			});
		}
		await reader.close();
		return result;
	}

	async function rebuildZip(): Promise<string> {
		const { ZipWriter, BlobWriter, BlobReader } = await loadZipApi();
		const blobWriter = new BlobWriter('application/zip');
		const writer = new ZipWriter(blobWriter, zipOpts);
		for (const entry of entries) {
			await writer.add(entry.name, new BlobReader(entry.blob), { level: 1 });
		}
		const zipBlob = await writer.close();
		return blobToBase64(zipBlob);
	}

	// Обновляем значение поля после изменения списка файлов
	async function commit() {
		busy = true;
		try {
			if (entries.length === 0) {
				value = '';
				onChange(new Event('change'));
				return;
			}
			const name = current?.name ?? 'archive.zip';
			const data = await rebuildZip();
			value = {
				name,
				files: entries.map((e) => ({ name: e.name, size: e.size })),
				data
			};
			onChange(new Event('change'));
		} finally {
			busy = false;
		}
	}

	onMount(async () => {
		const cur = current;
		if (!cur) return;
		busy = true;
		try {
			const file = ((await hydrateFileValue(cur)) ?? cur) as StoredZip;
			if (!file || !file.data) return;
			entries = await readEntries(base64ToBlob(file.data, 'application/zip'));
		} catch (err) {
			console.error('Ошибка чтения архива:', err);
			alert('Не удалось прочитать содержимое ZIP-архива');
		} finally {
			busy = false;
		}
	});

	async function handleAdd(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		if (files.length === 0) return;

		const oversize = files.map(checkFileSize).find(Boolean);
		if (oversize) return alert(oversize);

		const addedSize = files.reduce((s, f) => s + f.size, 0);
		if (totalSize + addedSize > MAX_FILE_SIZE) {
			return alert(
				`Суммарный размер архива превысит ${formatBytes(MAX_FILE_SIZE)}. Добавление отменено.`
			);
		}

		const duplicates = files.filter((f) => entries.some((e) => e.name === f.name));
		if (duplicates.length > 0) {
			return alert(`В архиве уже есть файл(ы): ${duplicates.map((d) => d.name).join(', ')}`);
		}

		busy = true;
		try {
			entries = [...entries, ...files.map((f) => ({ name: f.name, size: f.size, blob: f }))];
			await commit();
		} catch (err) {
			console.error('Ошибка добавления файла в архив:', err);
			alert('Ошибка добавления файла в архив');
		} finally {
			busy = false;
		}
	}

	async function handleRemoveEntry(name: string) {
		if (!confirm(`Удалить файл «${name}» из архива?`)) return;
		busy = true;
		try {
			entries = entries.filter((e) => e.name !== name);
			await commit();
		} catch (err) {
			console.error('Ошибка удаления файла из архива:', err);
			alert('Ошибка удаления файла из архива');
		} finally {
			busy = false;
		}
	}

	async function handleDownload() {
		const cur = current;
		if (!cur) return;
		const file = ((await hydrateFileValue(cur)) ?? cur) as StoredZip;
		if (!file || !file.data) return;
		downloadBlob(base64ToBlob(file.data, 'application/zip'), file.name);
	}
</script>

<div class="zip-field">
	<div class="zip-header">
		<span class="zip-name" title={current?.name ?? ''}>🗜 {current?.name ?? 'ZIP-архив'}</span>
		<span class="zip-size">
			{entries.length === 0
				? 'архив пуст'
				: `${entries.length} файл(ов), ${formatBytes(totalSize)}`}
		</span>
		<div class="zip-actions">
			<button
				type="button"
				class="btn-file"
				onclick={handleDownload}
				disabled={disabled || !current}
			>
				⬇ Скачать архив
			</button>
			{#if !disabled}
				<button type="button" class="btn-file" onclick={() => fileInput?.click()} disabled={busy}
					>📂 Добавить файлы</button
				>
			{/if}
		</div>
	</div>

	{#if entries.length > 0}
		<ul class="zip-list">
			{#each entries as entry (entry.name)}
				<li class="zip-entry">
					<span class="zip-entry-name" title={entry.name}>📄 {entry.name}</span>
					<span class="zip-entry-size">{formatBytes(entry.size)}</span>
					{#if !disabled}
						<button
							type="button"
							class="btn-file btn-file-remove"
							onclick={() => handleRemoveEntry(entry.name)}
							disabled={busy}
							title="Удалить из архива">🗑</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if busy}
		<div class="zip-busy">⏳ Обработка архива...</div>
	{/if}

	<input
		bind:this={fileInput}
		type="file"
		multiple
		class="hidden-input"
		onchange={handleAdd}
		{disabled}
	/>
</div>

<style>
	.zip-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.zip-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		background: #f8fafc;
		min-height: 32px;
	}
	.zip-name {
		font-size: 0.85rem;
		color: #1e293b;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.zip-size {
		font-size: 0.75rem;
		color: #64748b;
		white-space: nowrap;
	}
	.zip-actions {
		margin-left: auto;
		display: flex;
		gap: 6px;
	}
	.zip-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		overflow: hidden;
		max-height: 240px;
		overflow-y: auto;
	}
	.zip-entry {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		border-bottom: 1px solid #f1f5f9;
		background: #ffffff;
	}
	.zip-entry:last-child {
		border-bottom: none;
	}
	.zip-entry-name {
		font-size: 0.82rem;
		color: #334155;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.zip-entry-size {
		font-size: 0.72rem;
		color: #94a3b8;
		white-space: nowrap;
	}
	.zip-entry .btn-file-remove {
		margin-left: auto;
		padding: 2px 8px;
	}
	.zip-busy {
		font-size: 0.78rem;
		color: #2563eb;
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
