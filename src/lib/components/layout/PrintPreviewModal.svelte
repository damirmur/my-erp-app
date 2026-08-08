<script lang="ts">
	import { workspace } from '$lib/state/workspace.svelte';

	// Печать содержимого предпросмотра (iframe) — как в окне печати, но без
	// отдельного всплывающего окна.
	function printPreview() {
		const frame = document.getElementById('print-preview-frame') as HTMLIFrameElement | null;
		frame?.contentWindow?.print();
	}
</script>

{#if workspace.printPreview}
	{@const preview = workspace.printPreview}
	<div class="print-preview-overlay" role="dialog" aria-modal="true">
		<div class="print-preview-modal">
			<div class="print-preview-header">
				<span class="print-preview-title">👁 {preview.title}</span>
				<div class="print-preview-actions">
					<button class="print-preview-btn" onclick={printPreview}>🖨️ Печать</button>
					<button
						class="print-preview-close"
						onclick={() => workspace.closePrintPreview()}
						title="Закрыть"
					>
						✕
					</button>
				</div>
			</div>
			<iframe
				id="print-preview-frame"
				class="print-preview-frame"
				title="Предпросмотр документа"
				srcdoc={preview.html}
			></iframe>
		</div>
	</div>
{/if}

<style>
	.print-preview-overlay {
		position: fixed;
		inset: 0;
		background: rgba(15, 23, 42, 0.45);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		z-index: 1000;
	}
	.print-preview-modal {
		background: #ffffff;
		border-radius: 0.5rem;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
		width: min(1000px, 100%);
		height: 90vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.print-preview-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.6rem 0.9rem;
		background: #f8fafc;
		border-bottom: 1px solid #e2e8f0;
	}
	.print-preview-title {
		font-weight: 600;
		font-size: 0.95rem;
		color: #1f2937;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.print-preview-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.print-preview-btn {
		padding: 0.35rem 0.8rem;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		background: #ffffff;
		color: #334155;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.print-preview-btn:hover {
		background: #e2e8f0;
	}
	.print-preview-close {
		background: none;
		border: none;
		cursor: pointer;
		color: #64748b;
		font-size: 1rem;
		padding: 2px 6px;
		border-radius: 0.25rem;
	}
	.print-preview-close:hover {
		background: #e2e8f0;
		color: #0f172a;
	}
	.print-preview-frame {
		flex: 1;
		width: 100%;
		border: none;
		background: #ffffff;
	}
</style>
