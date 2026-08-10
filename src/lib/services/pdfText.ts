import type { StoredFile } from '$lib/services/files';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Извлечение текста из PDF-выписки банка. Текстовые выписки содержат
// извлекаемый текст, поэтому координатная экстракция через
// pdf.js даёт и плоский текст (для regex по шапке), и «строки таблицы»
// (ячейки, сгруппированные по вертикали и отсортированные по горизонтали) —
// это позволяет надёжно разбирать многостолбцовые таблицы операций.
//
// pdfjs-dist загружается ЛЕНИВО (динамический import) в момент извлечения:
// он выполняется только в браузере и не попадает в серверный рендер, где
// pdf.js падает на отсутствии DOMMatrix в Node.

export interface PdfCell {
	x: number;
	text: string;
}

export interface PdfRow {
	y: number;
	cells: PdfCell[];
}

export interface PdfTextResult {
	text: string;
	rows: PdfRow[];
}

// Точность кластеризации строк: элементы с разницей y меньше порога
// считаются одной строкой таблицы.
const Y_EPS = 2.5;

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// Нормализация пробелов: банки часто ставят неразрывный пробел в суммах.
function norm(text: string): string {
	return text.replace(/\u00a0/g, ' ');
}

// Извлечь текст и «строки таблицы» из файла PDF (StoredFile, base64).
// Выполняется только в браузере (из importStatement по «▶️ Выполнить»).
export async function extractPdfText(file: StoredFile): Promise<PdfTextResult> {
	const pdfjsLib = await import('pdfjs-dist');
	pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
	const pdf = await pdfjsLib.getDocument({ data: base64ToBytes(file.data) }).promise;
	const allRows: PdfRow[] = [];
	const pagesText: string[] = [];

	for (let p = 1; p <= pdf.numPages; p++) {
		const page = await pdf.getPage(p);
		const viewport = page.getViewport({ scale: 1 });
		const tc = await page.getTextContent();

		// Элементы текста: координаты в системе страницы; y нормируем так,
		// чтобы верх страницы был 0 (сортировка строк сверху вниз).
		const items: { x: number; y: number; str: string }[] = [];
		for (const it of tc.items) {
			const item = it as { str: string; transform: number[] };
			if (!item.str) continue;
			items.push({
				x: item.transform[4],
				y: viewport.height - item.transform[5],
				str: norm(item.str)
			});
		}

		// Группировка в строки по y (нечёткая кластеризация по порядку).
		const lines: { y: number; cells: PdfCell[] }[] = [];
		for (const it of items) {
			const line = lines.find((l) => Math.abs(l.y - it.y) <= Y_EPS);
			if (line) line.cells.push({ x: it.x, text: it.str });
			else lines.push({ y: it.y, cells: [{ x: it.x, text: it.str }] });
		}

		lines.sort((a, b) => a.y - b.y);
		const pageRows: PdfRow[] = [];
		const pageTextLines: string[] = [];
		for (const line of lines) {
			line.cells.sort((a, b) => a.x - b.x);
			pageRows.push({ y: Math.round(line.y * 10) / 10, cells: line.cells });
			pageTextLines.push(line.cells.map((c) => c.text).join(' '));
		}

		allRows.push(...pageRows);
		pagesText.push(pageTextLines.join('\n'));
	}

	return { text: pagesText.join('\f'), rows: allRows };
}
