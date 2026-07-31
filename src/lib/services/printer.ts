import { db } from '$lib/db/indexeddb';

export const printerService = {
	/**
	 * Универсальный метод рендеринга одного или нескольких документов по их ID
	 */
	async printRecords(tableId: string, recordIds: string[]) {
		if (recordIds.length === 0) {
			alert('Не выбраны записи для печати.');
			return;
		}

		// 1. Получаем имя таблицы метаданных
		const metaTable = await db.meta_tables.get(tableId);
		const tableTitle = metaTable ? metaTable.title : 'Документ';

		// 2. Получаем дефолтный HTML-макет печатной формы
		const defaultForm = await db
			.table('print_forms')
			.where('table_id')
			.equals(tableId)
			.filter((f) => f.is_default === true || f.is_default === 1)
			.first();

		// Базовый макет-заглушка на случай, если в БД нет шаблона
		let templateHtml = defaultForm
			? defaultForm.template
			: `
            <div style="font-family: sans-serif; padding: 20px;">
                <h2>{{doc.title}} № {{doc.number}}</h2>
                <p>Дата: {{doc.date}}</p>
                <table style="width:100%; border-collapse:collapse; margin-top:20px;" border="1">
                    <thead><tr><th>№</th><th>Наименование</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead>
                    <tbody>{{#each lines}}<tr><td>{{@index + 1}}</td><td>{{this.product}}</td><td>{{this.quantity}}</td><td>{{this.price}}</td><td>{{this.amount}}</td></tr>{{/each}}</tbody>
                </table>
                <h3 style="text-align:right;">Итого: {{doc.total_amount}} руб.</h3>
            </div>
        `;

		let finalFullHtml = '';

		// 3. Циклом собираем HTML для всех переданных документов
		for (let i = 0; i < recordIds.length; i++) {
			const recordId = recordIds[i];

			// Загружаем шапку и строки из IndexedDB
			const record = await db.data_records.get(recordId);
			if (!record) continue;

			const lines = await db.data_lines.where('record_id').equals(recordId).toArray();

			// Вычисляем итоги для текущего документа
			const totalAmount = lines.reduce((sum, l) => sum + (parseFloat(l.data?.amount) || 0), 0);

			// Подставляем данные шапки
			let renderedDoc = templateHtml
				.replace(/\{\{doc\.title\}\}/g, tableTitle)
				.replace(/\{\{doc\.number\}\}/g, record.data.number || '')
				.replace(/\{\{doc\.date\}\}/g, record.data.date || '')
				.replace(/\{\{doc\.counterparty\}\}/g, record.data.counterparty || '')
				.replace(/\{\{doc\.total_amount\}\}/g, totalAmount.toString());

			// Парсим табличную часть {{#each lines}}...{{/each}}
			const eachRegex = /\{\{#each lines\}\}([\s\S]*?)\{\{\/each\}\}/;
			const match = renderedDoc.match(eachRegex);

			if (match && match[1]) {
				const rowTemplate = match[1];
				const rowsHtml = lines
					.map((line, index) => {
						return rowTemplate
							.replace(/\{\{@index \+ 1\}\}/g, (index + 1).toString())
							.replace(/\{\{this\.product\}\}/g, line.data?.product || '')
							.replace(/\{\{this\.quantity\}\}/g, (line.data?.quantity || 0).toString())
							.replace(/\{\{this\.price\}\}/g, (line.data?.price || 0).toString())
							.replace(/\{\{this\.amount\}\}/g, (line.data?.amount || 0).toString());
					})
					.join('');

				renderedDoc = renderedDoc.replace(eachRegex, rowsHtml);
			}

			// Добавляем документ в общий пул печати
			// Если это не последний документ в списке, добавляем CSS-разрыв страницы для принтера
			const pageBreak = i < recordIds.length - 1 ? '<div class="page-break"></div>' : '';
			finalFullHtml += `<div class="print-item">${renderedDoc}</div>${pageBreak}`;
		}

		// 4. Открываем универсальное окно печати
		const printWindow = window.open('', '_blank');
		if (!printWindow) {
			alert('Браузер заблокировал всплывающее окно. Разрешите всплывающие окна в настройках.');
			return;
		}

		printWindow.document.documentElement.innerHTML = `
            <html>
            <head>
                <title>Печать документов пакетно</title>
                <style>
                    body { margin: 0; padding: 0; background: #fff; }
                    .print-item { box-sizing: border-box; }
                    /* Жесткий разрыв страницы при печати на А4 */
                    .page-break { page-break-after: always; break-after: page; clear: both; }
                    @media print {
                        body { padding: 0; }
                        .page-break { page-break-after: always; break-after: page; }
                    }
                </style>
            </head>
            <body>
                ${finalFullHtml}
            </body>
            </html>
        `;

		// Даем браузеру время отрендерить DOM и вызываем системную печать
		setTimeout(() => {
			printWindow.print();
			printWindow.close();
		}, 400);
	}
};
