<script lang="ts">
	import { fieldRegistry, fieldTypeList } from './index';
	import { defaultBirth } from './birth';

	// Хранимое значение — объект { t: тип, v: значение }: в разных записях одной
	// таблицы тип поля может быть своим (строка, датавремя, ссылка и т.д.).
	// Для «Ссылка» значение — id связанной записи (разрезолвится по любой таблице).
	interface UniversalValue {
		t: string;
		v: any;
	}

	let {
		value = $bindable<UniversalValue | null>(null),
		disabled = false,
		onChange = (_e: Event) => {},
		relatedTableId = ''
	} = $props();

	// Кандидаты: все зарегистрированные типы с редактором, кроме самого «Универсального»
	let candidates = $derived(fieldTypeList.filter((f) => f.FormField && f.type !== 'universal'));

	// Нормализуем значение: при отсутствии/устаревшей структуре подставляем строку
	// (для пустой строки сохраняем её как значение строки).
	$effect(() => {
		const v = value;
		if (v == null || typeof v !== 'object' || typeof v.t !== 'string') {
			if (typeof v === 'string') {
				value = { t: 'string', v };
			} else {
				value = { t: 'string', v: '' };
			}
		}
	});

	function defaultFor(t: string): any {
		if (t === 'boolean') return false;
		if (t === 'birth') return defaultBirth();
		return '';
	}

	function changeType(t: string) {
		value = { t, v: defaultFor(t) };
		onChange(new Event('change'));
	}

	let currentType = $derived(value?.t ?? 'string');
	let currentFC = $derived(fieldRegistry[currentType]?.FormField);
</script>

<div class="universal-field">
	{#if !disabled}
		<select
			class="universal-type"
			value={currentType}
			onchange={(e) => changeType(e.currentTarget.value)}
			title="Тип значения этой записи"
		>
			{#each candidates as c}
				<option value={c.type}>{c.label}</option>
			{/each}
		</select>
	{/if}
	{#if value && currentFC}
		{@const SubField = currentFC}
		<SubField bind:value={value.v} {disabled} {onChange} {relatedTableId} />
	{/if}
</div>

<style>
	.universal-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.universal-type {
		width: fit-content;
		font-size: 0.75rem;
		padding: 2px 6px;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		background: #f8fafc;
		color: #334155;
		outline: none;
	}
</style>
