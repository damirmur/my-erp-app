import { db, type LocalRecord } from '$lib/db/indexeddb';
import { apiCall } from '$lib/services/actionRunner';
import { loadTranslateConfig } from '$lib/state/settings';

// Транслитерация кириллицы в латиницу (детерминированный офлайн-фолбэк для
// генерации технических имён). Используется при автоподстановке name из
// синонима, если внешний переводчик недоступен или не сконфигурирован.
const TRANSLIT_MAP: Record<string, string> = {
	а: 'a',
	б: 'b',
	в: 'v',
	г: 'g',
	д: 'd',
	е: 'e',
	ё: 'e',
	ж: 'zh',
	з: 'z',
	и: 'i',
	й: 'y',
	к: 'k',
	л: 'l',
	м: 'm',
	н: 'n',
	о: 'o',
	п: 'p',
	р: 'r',
	с: 's',
	т: 't',
	у: 'u',
	ф: 'f',
	х: 'h',
	ц: 'ts',
	ч: 'ch',
	ш: 'sh',
	щ: 'sch',
	ъ: '',
	ы: 'y',
	ь: '',
	э: 'e',
	ю: 'yu',
	я: 'ya'
};

export function translit(text: string): string {
	return text
		.toLowerCase()
		.split('')
		.map((ch) => TRANSLIT_MAP[ch] ?? ch)
		.join('')
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_|_$/g, '');
}

// Техническое имя в snake_case: транслитерация + нижний регистр + разделители.
export function toNameSlug(text: string): string {
	return translit(text);
}

// Языки по умолчанию: источник — язык браузера (или ru), цель — en.
function defaultSourceLang(): string {
	if (typeof navigator === 'undefined') return 'ru';
	return (navigator.language ?? 'ru').slice(0, 2) || 'ru';
}

// Извлечение переведённого текста из ответа переводчика. Пробуем известные
// формы (astro3d translate, MyMemory, Yandex, …), затем — первый правдоподобный
// латинский фрагмент в JSON (глубина до 5, мимо служебных ключей).
export function extractTranslatedText(raw: unknown): string {
	if (!raw) return '';
	if (typeof raw === 'string') return raw.trim();
	if (typeof raw !== 'object') return '';

	const obj = raw as Record<string, any>;
	const pick = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

	// astro3d /api/translate
	if (obj.translated_text) return pick(obj.translated_text);
	// MyMemory
	if (obj.responseData?.translatedText) return pick(obj.responseData.translatedText);
	// Yandex translate
	const ya = obj.data?.[0]?.translations?.[0]?.text;
	if (ya) return pick(ya);
	// прочие распространённые поля
	if (obj.translatedText) return pick(obj.translatedText);
	if (typeof obj.text === 'string') return pick(obj.text);
	if (Array.isArray(obj.text)) {
		const joined = obj.text.map(String).join(' ').trim();
		if (joined) return joined;
	}

	let found = '';
	const walk = (node: unknown, depth: number) => {
		if (found || depth > 5) return;
		if (typeof node === 'string') {
			const t = node.trim();
			if (t.length >= 2 && /[a-z]/i.test(t)) found = t;
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) {
				walk(item, depth + 1);
				if (found) return;
			}
			return;
		}
		if (node && typeof node === 'object') {
			for (const [k, v] of Object.entries(node)) {
				if (['error', 'message', 'status', 'lang', 'detected_language'].includes(k)) continue;
				walk(v, depth + 1);
				if (found) return;
			}
		}
	};
	walk(raw, 0);
	return found;
}

// Сервис-переводчик по умолчанию: если настройка пуста, ищем в каталоге
// «Сервисы API» сид-запись «astro3d — переводчик» или любую с base_url,
// содержащим api/translate (запись могла быть создана вручную под другим именем).
async function findDefaultTranslateService(): Promise<LocalRecord | null> {
	const table = await db.meta_tables.where('name').equals('api_services').first();
	if (!table) return null;
	const records = await db.data_records.where('table_id').equals(table.id).toArray();
	return (
		records.find((r) => r.data?.name === 'astro3d — переводчик') ??
		records.find(
			(r) => typeof r.data?.base_url === 'string' && r.data.base_url.includes('api/translate')
		) ??
		null
	);
}

// Гибрид: name из синонима. Если доступен сервис-переводчик (настройка или
// сид-по-умолчанию) и есть интернет — переводим ({ word, langs, langt } по
// конвенции astro3d /api/translate) и приводим к snake_case; иначе/при ошибке —
// транслитерация.
export async function translateToName(text: string): Promise<string> {
	const slug = toNameSlug(text);
	if (!text.trim() || !slug) return slug;
	// Уже латиница/технический текст — перевод не нужен, сразу slug
	if (!/[\u0400-\u04FF]/i.test(text)) return slug;

	const config = await loadTranslateConfig();
	const svc = config.serviceId
		? await db.data_records.get(config.serviceId)
		: await findDefaultTranslateService();
	if (!svc) return slug;
	if (typeof navigator === 'undefined' || !navigator.onLine) return slug;

	try {
		const res = await apiCall(svc, {
			word: text,
			langs: config.sourceLang || defaultSourceLang(),
			langt: config.targetLang || 'en'
		});
		const translated = extractTranslatedText(res.data ?? res.raw);
		return toNameSlug(translated) || slug;
	} catch {
		return slug;
	}
}
