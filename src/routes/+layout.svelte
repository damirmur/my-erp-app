<script lang="ts">
	import { dev } from '$app/environment';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	$effect(() => {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js', { type: dev ? 'module' : 'classic' });
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
