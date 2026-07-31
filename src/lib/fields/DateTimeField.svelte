<script lang="ts">
	// ДатаВремя: хранение — ISO 8601 UTC (со «Z»), ввод/вывод — локальное время браузера.
	let { value = $bindable(''), disabled = false, onChange = (_e: Event) => {} } = $props();

	// ISO -> значение для <input type="datetime-local">
	function toLocalInput(iso: string | null | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// Локальная строка datetime-local -> ISO UTC
	function fromLocalInput(v: string): string {
		if (!v) return '';
		const d = new Date(v);
		return isNaN(d.getTime()) ? '' : d.toISOString();
	}

	function handleChange(e: Event) {
		value = fromLocalInput((e.currentTarget as HTMLInputElement).value);
		onChange(e);
	}
</script>

<input type="datetime-local" value={toLocalInput(value)} onchange={handleChange} {disabled} />
