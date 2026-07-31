<script lang="ts">
	import { defaultBirth, TZ_OPTIONS, tzLabel, birthToUtc, type BirthData } from './birth';

	let { value = $bindable(null), disabled = false, onChange = (_e: Event) => {} } = $props();

	// Внутреннее состояние; пишем обратно в value при каждом изменении.
	let internal = $state<BirthData>(defaultBirth());

	$effect(() => {
		const v = value;
		if (v == null || typeof v !== 'object') {
			internal = defaultBirth();
		} else {
			internal = { ...defaultBirth(), ...v };
		}
	});

	function emit() {
		value = internal;
		onChange(new Event('input'));
	}

	function setLocalPart(part: 'date' | 'time', raw: string) {
		const d = internal.local ? internal.local.split('T')[0] : '';
		const t = internal.local ? internal.local.split('T')[1] : '';
		internal.local = part === 'date' ? (t ? `${raw}T${t}` : raw) : d ? `${d}T${raw}` : raw;
		emit();
	}

	function setNumber(key: 'lat' | 'lon', raw: string) {
		const num = raw.trim() === '' ? null : parseFloat(raw);
		internal[key] = num !== null && isNaN(num) ? internal[key] : num;
		emit();
	}

	let utcHint = $derived(birthToUtc(internal));
</script>

<div class="birth-field">
	<div class="birth-row">
		<input
			type="date"
			value={internal.local.split('T')[0] ?? ''}
			onchange={(e) => setLocalPart('date', e.currentTarget.value)}
			{disabled}
		/>
		<input
			type="time"
			step="60"
			value={internal.local.split('T')[1] ?? ''}
			onchange={(e) => setLocalPart('time', e.currentTarget.value)}
			{disabled}
		/>
		<select bind:value={internal.tz} onchange={emit} {disabled}>
			{#each TZ_OPTIONS as tz}
				<option value={tz}>{tzLabel(tz)}</option>
			{/each}
		</select>
	</div>
	<div class="birth-row">
		<input
			type="number"
			step="any"
			value={internal.lat ?? ''}
			placeholder="Широта"
			oninput={(e) => setNumber('lat', e.currentTarget.value)}
			{disabled}
		/>
		<input
			type="number"
			step="any"
			value={internal.lon ?? ''}
			placeholder="Долгота"
			oninput={(e) => setNumber('lon', e.currentTarget.value)}
			{disabled}
		/>
		<input
			type="text"
			bind:value={internal.place}
			placeholder="Место рождения"
			oninput={emit}
			{disabled}
		/>
	</div>
	{#if utcHint}
		<div class="birth-utc">UTC: {utcHint.replace('T', ' ').replace('.000Z', 'Z')}</div>
	{/if}
</div>

<style>
	.birth-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.birth-row {
		display: flex;
		gap: 6px;
	}
	.birth-row input,
	.birth-row select {
		flex: 1;
		min-width: 0;
		padding: 4px 6px;
		border: 1px solid #cbd5e1;
		border-radius: 0.25rem;
		font-size: 0.8rem;
		outline: none;
		box-sizing: border-box;
	}
	.birth-row input:focus,
	.birth-row select:focus {
		border-color: #3b82f6;
	}
	.birth-utc {
		font-size: 0.75rem;
		color: #64748b;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
</style>
