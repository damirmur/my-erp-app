<script lang="ts">
	import { workspace } from '$lib/state/workspace.svelte';

	let copied = $state(false);

	function handleCopyText(text: string) {
		navigator.clipboard.writeText(text).then(() => {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		});
	}
</script>

{#if workspace.apiResult}
	{@const result = workspace.apiResult}
	<div class="api-modal-overlay" role="dialog" aria-modal="true">
		<div class="api-modal">
			<div class="api-modal-header">
				<span class="api-modal-title">
					{result.ok ? '✓ ' : '✗ '}{result.label}
				</span>
				<button class="api-modal-close" onclick={() => workspace.closeApiResult()} title="Закрыть">
					✕
				</button>
			</div>

			{#if result.href}
				<div class="api-url-row">
					<input readonly value={result.href} class="api-url-input" />
					<button class="api-copy-btn" onclick={() => handleCopyText(result.href)}>
						{copied ? '✓ Скопировано' : 'Копировать URL'}
					</button>
				</div>
			{/if}

			<div class="api-status" class:error={!result.ok}>
				{#if result.ok}
					Результат (JSON), {new Date(result.executedAt).toLocaleString()}:
				{:else}
					Ошибка: {result.error}
				{/if}
			</div>

			{#if result.steps && result.steps.length > 0}
				<div class="api-steps">
					{#each result.steps as step (step.name)}
						<div
							class="api-step"
							class:error={step.status === 'error'}
							class:pending={step.status === 'pending'}
						>
							<span class="step-icon"
								>{step.status === 'ok' ? '✓' : step.status === 'error' ? '✗' : '⋯'}</span
							>
							<span class="step-name">{step.name}</span>
							{#if step.durationMs != null}
								<span class="step-dur">{step.durationMs} мс</span>
							{/if}
							{#if step.error}
								<div class="step-error">{step.error}</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			{#if result.ok}
				<pre class="api-json"><code>{JSON.stringify(result.value, null, 2)}</code></pre>
				<div class="api-actions">
					<button
						class="api-copy-btn"
						onclick={() => handleCopyText(JSON.stringify(result.value, null, 2))}
					>
						{copied ? '✓ Скопировано' : 'Копировать JSON'}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.api-modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(15, 23, 42, 0.45);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 2rem;
		z-index: 1000;
	}
	.api-modal {
		background: #ffffff;
		border-radius: 0.5rem;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
		width: min(900px, 100%);
		max-height: 90vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.api-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.6rem 0.9rem;
		background: #f8fafc;
		border-bottom: 1px solid #e2e8f0;
	}
	.api-modal-title {
		font-weight: 600;
		font-size: 0.95rem;
		color: #1f2937;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.api-modal-close {
		background: none;
		border: none;
		cursor: pointer;
		color: #64748b;
		font-size: 1rem;
		padding: 2px 6px;
		border-radius: 0.25rem;
	}
	.api-modal-close:hover {
		background: #e2e8f0;
		color: #0f172a;
	}
	.api-url-row {
		display: flex;
		gap: 0.5rem;
		padding: 0.6rem 0.9rem;
		border-bottom: 1px solid #e2e8f0;
	}
	.api-url-input {
		flex: 1;
		padding: 0.35rem 0.5rem;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		font-size: 0.8rem;
		color: #334155;
		background: #f8fafc;
	}
	.api-status {
		padding: 0.6rem 0.9rem;
		font-size: 0.85rem;
		color: #16a34a;
		border-bottom: 1px solid #f1f5f9;
	}
	.api-status.error {
		color: #dc2626;
	}
	.api-steps {
		padding: 0.6rem 0.9rem;
		border-bottom: 1px solid #f1f5f9;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.api-step {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		font-size: 0.8rem;
		padding: 0.25rem 0.5rem;
		background: #f8fafc;
		border-radius: 0.375rem;
		border: 1px solid #e2e8f0;
	}
	.api-step.error {
		border-color: #fca5a5;
		background: #fef2f2;
	}
	.api-step.pending {
		color: #94a3b8;
	}
	.step-icon {
		font-weight: 700;
	}
	.api-step.error .step-icon {
		color: #dc2626;
	}
	.step-name {
		font-weight: 600;
	}
	.step-dur {
		color: #94a3b8;
		margin-left: auto;
	}
	.step-error {
		width: 100%;
		color: #b91c1c;
		font-size: 0.75rem;
		margin-top: 0.15rem;
		word-break: break-word;
	}
	.api-json {
		flex: 1;
		overflow: auto;
		margin: 0;
		padding: 0.9rem;
		background: #0f172a;
		color: #e2e8f0;
		font-size: 0.8rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.api-actions {
		display: flex;
		justify-content: flex-end;
		padding: 0.6rem 0.9rem;
		border-top: 1px solid #e2e8f0;
	}
	.api-copy-btn {
		padding: 0.35rem 0.8rem;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		background: #f8fafc;
		color: #334155;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.api-copy-btn:hover {
		background: #e2e8f0;
	}
</style>
