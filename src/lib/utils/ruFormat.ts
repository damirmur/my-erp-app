// Универсальные примитивы разбора русского формата чисел/сумм/дат.
// Используются кодом-парсером банковских выписок (parser_code в каталоге
// «Банки») и сценариями через песочницу (хелперы parseNum/parseAmount/parseDate).

function clean(s: unknown): string {
	return String(s ?? '')
		.replace(/\u00a0/g, ' ')
		.trim();
}

// '47 643,12' → 47643.12; '−3 000,00' → −3000; '+3 000,00' → 3000.
export function parseRuNumber(s: unknown): number | null {
	const t = clean(s);
	if (!t) return null;
	const neg = t.startsWith('-') || t.startsWith('−');
	const core = t
		.replace(/^[+\-−]/, '')
		.replace(/\s+/g, '')
		.replace(',', '.');
	const n = parseFloat(core);
	if (!Number.isFinite(n)) return null;
	return neg ? -Math.abs(n) : Math.abs(n);
}

// Сумма операции: явный «+» — приход (положительная), явный «−» — расход,
// без знака — расход по умолчанию (в выписках приход обычно помечается «+»).
export function parseRuAmount(s: unknown): number | null {
	const t = clean(s);
	if (!t) return null;
	if (t.startsWith('+')) return parseRuNumber(t.slice(1));
	if (t.startsWith('-') || t.startsWith('−')) return parseRuNumber(t);
	const n = parseRuNumber(t);
	return n === null ? null : -Math.abs(n);
}

// '24.07.2026' / '2026-07-24' → 'YYYY-MM-DD'.
export function parseRuDate(s: unknown): string {
	const t = clean(s);
	let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
	if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
	m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
	return t;
}
