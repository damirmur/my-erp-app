import { db } from '$lib/db/indexeddb';

export const numberService = {
	/**
	 * Генерирует следующий уникальный номер для таблицы по маске (например, РН-0001 -> РН-0002)
	 */
	async getNextNumber(tableId: string, prefix: string = 'РН-'): Promise<string> {
		// 1. Берем все записи этой таблицы
		const records = await db.data_records.where('table_id').equals(tableId).toArray();

		let maxNumber = 0;

		// 2. Ищем максимальное числовое значение в существующих номерах
		records.forEach((r) => {
			const numStr = r.data.number || '';
			if (numStr.startsWith(prefix)) {
				// Извлекаем цифры после префикса (например, из "РН-0005" берем "0005")
				const digits = parseInt(numStr.replace(prefix, ''), 10);
				if (!isNaN(digits) && digits > maxNumber) {
					maxNumber = digits;
				}
			}
		});

		// 3. Увеличиваем номер на 1 и дополняем нулями до 4 знаков (0001, 0002...)
		const nextDigits = maxNumber + 1;
		const paddedDigits = nextDigits.toString().padStart(4, '0');

		return `${prefix}${paddedDigits}`;
	}
};
