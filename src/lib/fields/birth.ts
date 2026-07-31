import type { FieldTypeModule } from './field';
import BirthField from './BirthField.svelte';

// Момент рождения: фиксированное локальное время в месте рождения + смещение на
// момент события (с учётом DST) + координаты для расчёта Асц и домов.
export interface BirthData {
	local: string; // 'YYYY-MM-DDTHH:mm' — как записано, локальное время места рождения
	tz: string; // '±HH:MM' — смещение относительно UTC в момент рождения
	lat: number | null; // широта (десятичные градусы)
	lon: number | null; // долгота
	place: string; // название места (для отображения)
}

const TZ_CITY: Record<string, string> = {
	'+00:00': 'Лондон',
	'+01:00': 'Берлин',
	'+02:00': 'Киев',
	'+03:00': 'Москва',
	'+04:00': 'Дубай',
	'+05:00': 'Екатеринбург',
	'+07:00': 'Новосибирск',
	'+09:00': 'Владивосток',
	'-05:00': 'Нью-Йорк',
	'-08:00': 'Лос-Анджелес'
};

function buildTzOptions(): string[] {
	const res: string[] = [];
	for (let h = -12; h <= 14; h++) {
		const mins = [0, 30];
		if (h === 5 || h === 8 || h === 12) mins.push(45);
		for (const m of mins) {
			const sign = h < 0 ? '-' : '+';
			res.push(`${sign}${String(Math.abs(h)).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
		}
	}
	return res;
}

export const TZ_OPTIONS: string[] = buildTzOptions();

export function tzLabel(tz: string): string {
	const city = TZ_CITY[tz];
	return city ? `UTC${tz} (${city})` : `UTC${tz}`;
}

export function defaultBirth(): BirthData {
	return { local: '', tz: '+03:00', lat: null, lon: null, place: '' };
}

// Проверка локальной даты-времени без переворачивания календаря
export function isValidBirthLocal(local: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local ?? '');
	if (!m) return false;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
	return (
		d.getFullYear() === Number(m[1]) &&
		d.getMonth() === Number(m[2]) - 1 &&
		d.getDate() === Number(m[3])
	);
}

// local + tz -> UTC (ISO 8601 со «Z»). null, если данные неполные/некорректные.
export function birthToUtc(b: BirthData): string | null {
	if (!isValidBirthLocal(b.local)) return null;
	const tzM = /^([+-])(\d{2}):(\d{2})$/.exec(b.tz ?? '');
	if (!tzM) return null;
	const sign = tzM[1] === '-' ? -1 : 1;
	const tzMin = sign * (Number(tzM[2]) * 60 + Number(tzM[3]));
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(b.local)!;
	const utcMs =
		Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) -
		tzMin * 60000;
	return new Date(utcMs).toISOString();
}

export function formatBirth(b: BirthData): string {
	const parts: string[] = [];
	if (b.local) parts.push(b.local.replace('T', ' '));
	if (b.tz) parts.push(`UTC${b.tz}`);
	if (b.place) parts.push(b.place);
	if (b.lat != null && b.lon != null) parts.push(`${b.lat}, ${b.lon}`);
	return parts.join(' · ');
}

const birthField: FieldTypeModule = {
	type: 'birth',
	label: 'Момент рождения',
	defaults: {},
	FormField: BirthField
};

export default birthField;
