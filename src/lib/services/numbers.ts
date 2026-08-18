import { db } from '$lib/db/indexeddb';

// Сегодняшняя дата в формате YYYY-MM-DD (как хранится в колонках типа «date»).
export function todayIso(): string {
	return new Date().toISOString().split('T')[0];
}

// Год из значения даты: 'YYYY-MM-DD', ISO-строка или Date. Пустое/битое — текущий год.
export function yearOf(value: unknown): number {
	if (!value) return new Date().getFullYear();
	const s = String(value);
	const m = s.match(/^(\d{4})/);
	if (m) return parseInt(m[0], 10);
	const d = new Date(s);
	return isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
}

// Префикс номера по названию таблицы (историческая эвристика из формы).
export function numberPrefixForTitle(title: string): string {
	return title.includes('Накладная') || title.includes('Реализация') ? 'РН-' : 'СП-';
}

export const numberService = {
	/**
	 * Следующий номер для таблицы. Нумерация в пределах года (если year задан):
	 * учитываются только записи с датой в этом году. Способ подсчёта — по последнему
	 * большему: из номера каждой записи выбрасываются ВСЕ не цифровые символы
	 * (например, "СП-0003" -> 3), берётся максимум и прибавляется 1. Префикс
	 * результата берётся из записи с максимальным номером, иначе — defaultPrefix.
	 */
	async getNextNumber(
		tableId: string,
		year?: number,
		defaultPrefix: string = 'СП-'
	): Promise<string> {
		const records = await db.data_records.where('table_id').equals(tableId).toArray();

		let max = 0;
		let prefix = defaultPrefix;
		for (const r of records) {
			const numStr = String(r.data?.number ?? '');
			if (!numStr.trim()) continue;
			if (year !== undefined) {
				const d = r.data?.date;
				if (!d || yearOf(d) !== year) continue; // нумерация в пределах года
			}
			const digits = parseInt(numStr.replace(/\D/g, ''), 10);
			if (!isNaN(digits) && digits > max) {
				max = digits;
				const m = numStr.match(/^\D+/);
				if (m && m[0].trim()) prefix = m[0];
			}
		}
		return `${prefix}${(max + 1).toString().padStart(4, '0')}`;
	}
};

// Автозаполнение служебных полей документа при записи (форма или программно):
//   date   — если пустая, подставляется сегодня;
//   number — если пустой, следующий номер в пределах года даты записи.
// Заполняются только колонки, которые реально есть в таблице. Для не-документов
// (справочники и т.п.) номер считается по всем записям (без привязки к году),
// константы и системные таблицы не трогаем.
export async function autoFillDocumentFields(
	tableId: string,
	data: Record<string, any>
): Promise<Record<string, any>> {
	const out = { ...data };
	const [cols, table] = await Promise.all([
		db.meta_columns.where('table_id').equals(tableId).toArray(),
		db.meta_tables.get(tableId)
	]);
	if (!table || table.type === 'constant' || table.type === 'system') return out;

	const names = new Set(cols.map((c) => c.name));
	const hasDate = names.has('date');
	const hasNumber = names.has('number');
	if (!hasDate && !hasNumber) return out;

	if (hasDate && !out.date) {
		// datetime-колонки — полноценный ISO (дата+время, UTC); иначе — только дата.
		const colType = cols.find((c) => c.name === 'date')?.type;
		out.date = colType === 'datetime' ? new Date().toISOString() : todayIso();
	}

	if (hasNumber && !out.number) {
		const isDocument = table.type === 'document';
		const year = isDocument ? yearOf(out.date) : undefined;
		out.number = await numberService.getNextNumber(
			tableId,
			year,
			numberPrefixForTitle(table.title ?? '')
		);
	}
	return out;
}
