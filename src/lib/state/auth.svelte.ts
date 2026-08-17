import { supabase } from '$lib/db/supabase';
import { db } from '$lib/db/indexeddb';
import type { Session, User } from '@supabase/supabase-js';
import {
	accessRules,
	ensureTeamMemberRecord,
	loadAccessMode,
	tableIsPublic,
	teamMembers,
	type AccessAction,
	type AccessRule
} from '$lib/state/access';
import { replaceState } from '$app/navigation';
import { PUBLIC_AUTH_GATEWAY_URL } from '$env/static/public';

// Состояние авторизации приложения. Сессия живёт в Supabase Auth (localStorage,
// persistSession + autoRefreshToken уже настроены в supabase.ts). Дополнительно:
//   статус  — loading / guest / authenticated (гостевой режим = просмотр публичного);
//   роль    — из «Команды» (team_members), имена ролей: owner/admin/editor/reader + свои;
//   access  — эффективные права по таблицам { view, edit, execute } (для UI; реальную
//             защиту обеспечивает RLS на сервере).
type AuthStatus = 'loading' | 'guest' | 'authenticated';

export interface TableAccess {
	view: boolean;
	edit: boolean;
	execute: boolean;
}

// Ключ в localStorage: чья данные лежат в локальном кэше (user id или 'guest').
const CACHE_USER_KEY = 'erp_cache_user';
// Сигнатура эффективных прав: при изменении кэш данных очищается и перекачивается
// заново (RLS отдаст только то, что доступно текущему пользователю).
const ACCESS_SIG_KEY = 'erp_access_sig';

function gatewayUrl(): string {
	const base = (PUBLIC_AUTH_GATEWAY_URL ?? '').trim();
	return base || 'https://astro3d.ru';
}

class AuthManager {
	status = $state<AuthStatus>('loading');
	session = $state<Session | null>(null);
	user = $derived(this.session?.user ?? null);
	isAuthenticated = $derived(this.status === 'authenticated');
	isGuest = $derived(this.status === 'guest');

	role = $state('');
	displayName = $state('');
	accessMode = $state<'open' | 'locked'>('open');
	// Эффективные права по таблицам (для UI-скрытия и readOnly).
	access = $state<Record<string, TableAccess>>({});
	// Гость может в любой момент открыть экран входа (кнопка «Войти»).
	showLogin = $state(false);

	isAdmin = $derived(this.role === 'owner' || this.role === 'admin');

	// --- Жизненный цикл -------------------------------------------------------

	// Вызывается один раз при старте приложения: восстанавливает сессию,
	// обрабатывает возврат от шлюза (?auth_session=...) и подписывается на смены.
	async init(): Promise<void> {
		this.handleReturningSession();

		const { data } = await supabase.auth.getSession();
		this.applySession(data.session);

		supabase.auth.onAuthStateChange((_event, session) => {
			this.applySession(session);
		});
	}

	// Возврат от Go-шлюза (VK/TG): шлюз проверяет OAuth и отдаёт сессию Supabase.
	private handleReturningSession(): void {
		if (typeof location === 'undefined') return;
		const params = new URLSearchParams(location.search);
		const raw = params.get('auth_session');
		if (!raw) return;
		try {
			const payload = JSON.parse(decodeURIComponent(raw));
			if (payload?.access_token) {
				void supabase.auth.setSession(payload);
			}
		} catch {
			// некорректный параметр — игнорируем
		}
		// Убираем параметр из адресной строки, чтобы не светить токен в истории.
		// Во время бут-эффекта роутер SvelteKit ещё не инициализирован, и
		// replaceState из $app/navigation упадёт — откладываем до конца init.
		const url = new URL(location.href);
		url.searchParams.delete('auth_session');
		setTimeout(() => void replaceState(url, {}), 0);
	}

	private applySession(session: Session | null): void {
		this.session = session;
		this.status = session ? 'authenticated' : 'guest';
		if (session) this.showLogin = false;
		if (!session) {
			this.role = '';
			this.displayName = '';
		}
		void this.onSessionContextChanged();
	}

	// --- Вход/выход -----------------------------------------------------------

	async signInWithEmail(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
		const { error } = await supabase.auth.signInWithPassword({ email, password });
		return error ? { ok: false, error: error.message } : { ok: true };
	}

	async signUp(
		email: string,
		password: string
	): Promise<{ ok: boolean; needsConfirmation?: boolean; error?: string }> {
		const { data, error } = await supabase.auth.signUp({ email, password });
		if (error) return { ok: false, error: error.message };
		// Если сессия не создана — учётка требует подтверждения по e-mail
		// (в Supabase включено подтверждение почты), анонсируем письмо.
		const needsConfirmation = !data.session;
		return { ok: true, needsConfirmation };
	}

	// Вход через VK/Telegram: уходим на шлюз, он проверяет OAuth и возвращает
	// на приложение с ?auth_session=... (см. handleReturningSession). VK — через
	// код, отправляемый нашему VK-боту (без OAuth-приложения); Telegram — виджет.
	signInWithProvider(provider: 'vk' | 'telegram'): void {
		const redirect = `${location.origin}${location.pathname}`;
		const path = provider === 'vk' ? 'vk/bot/login' : `${provider}/login`;
		location.assign(`${gatewayUrl()}/api/auth/${path}?redirect=${encodeURIComponent(redirect)}`);
	}

	enterAsGuest(): void {
		this.status = 'guest';
		this.session = null;
		this.role = '';
		this.displayName = '';
		this.showLogin = false;
		void this.onSessionContextChanged();
	}

	async signOut(): Promise<void> {
		await supabase.auth.signOut();
		// Уже обработано onAuthStateChange (applySession(null)).
	}

	// --- Права ----------------------------------------------------------------

	// Пересчитать права по локальному кэшу. Вызывается после синхронизации.
	async recomputeAccess(): Promise<void> {
		this.accessMode = await loadAccessMode();

		if (this.status === 'loading') return;

		const uid = this.user?.id ?? null;
		const isGuest = this.status === 'guest';

		// Профиль из «Команды» (своя строка), если ещё не знаем.
		if (uid && !this.role) {
			const members = await teamMembers();
			const mine = members.find((m) => m.user_id === uid);
			if (mine) {
				this.role = mine.role;
				this.displayName = mine.display_name || this.displayName;
			}
		}

		const rules = await accessRules();
		const isAdmin = this.role === 'owner' || this.role === 'admin';
		const tables = await db.meta_tables.toArray();
		// «Открытый» режим — переходный период: всё видно всем (гостям — только просмотр,
		// редактирование — вошедшим), правила не применяются.
		const open = this.accessMode === 'open';

		const next: Record<string, TableAccess> = {};
		for (const t of tables) {
			if (t.parent_table_id) continue; // табличные части следуют за родителем
			const tblRules = rules.filter((r) => r.object_type === 'table' && r.object_id === t.id);
			const matches = (action: AccessAction) =>
				tblRules.some((r) => r.action === action && this.principalMatches(r, uid, isGuest));

			const view = open || isAdmin || tableIsPublic(t) || matches('view');
			const edit = (open && !isGuest) || isAdmin || matches('edit');
			const execute = (open && !isGuest) || isAdmin || matches('execute') || edit;
			next[t.id] = { view, edit, execute };
		}
		this.access = next;
	}

	private principalMatches(rule: AccessRule, uid: string | null, isGuest: boolean): boolean {
		if (rule.principal_type === 'anon') return isGuest;
		if (rule.principal_type === 'user') return uid !== null && rule.principal_id === uid;
		if (rule.principal_type === 'role') return this.role !== '' && rule.principal_id === this.role;
		return false;
	}

	// Синхронные геттеры для компонентов.
	canViewTable(tableId: string): boolean {
		if (this.status !== 'guest' && this.status !== 'authenticated') return false;
		return this.access[tableId]?.view ?? false;
	}

	canEditTable(tableId: string): boolean {
		if (this.status === 'guest') return false;
		if (this.status !== 'authenticated') return false;
		return this.access[tableId]?.edit ?? false;
	}

	canExecuteTable(tableId: string): boolean {
		if (this.status === 'guest') return false;
		if (this.status !== 'authenticated') return false;
		return this.access[tableId]?.execute ?? false;
	}

	canExecuteRecord(recordId: string): Promise<boolean> {
		return db.data_records
			.get(recordId)
			.then((r) => (r ? (this.access[r.table_id]?.execute ?? false) : false));
	}

	// --- Смена пользователя/прав: кэш данных --------------------------------

	// Сигнатура прав: меняется при входе/выходе или смене правил доступа.
	private accessSignature(): string {
		const parts: string[] = [`${this.status}`, `${this.role}`, this.accessMode];
		const tables = Object.keys(this.access).sort();
		for (const id of tables) {
			const a = this.access[id];
			parts.push(`${id}:${a.view ? 1 : 0}${a.edit ? 1 : 0}${a.execute ? 1 : 0}`);
		}
		return parts.join('|');
	}

	// Проверить, сменился ли пользователь/набор прав. Если да — очистить локальный
	// кэш данных и сбросить якорь синка, чтобы следующий цикл перекачал записи
	// под новыми правами (RLS отфильтрует недоступное). Вызывается из sync после
	// pushLocalChanges и перед pullDataChanges, а также после входа/выхода.
	async ensureDataCacheScope(): Promise<void> {
		if (this.status === 'loading') return;

		const cacheUser = localStorage.getItem(CACHE_USER_KEY);
		const currentUser = this.user?.id ?? (this.isGuest ? 'guest' : 'none');
		const sig = this.accessSignature();

		// Сменился пользователь или набор прав (вход/выход, смена правил админом).
		if (cacheUser === currentUser && localStorage.getItem(ACCESS_SIG_KEY) === sig) return;

		// Не трогаем локально изменённые записи? После push их нет (is_dirty=0).
		// Но чтобы не потерять чужие незаписанные правки, чистим только если их нет.
		const dirty = await db.data_records.where('is_dirty').equals(1).count();
		if (dirty > 0) {
			// Грубая смена прав при наличии локальных изменений: не чистим кэш,
			// иначе правки потеряются. Доступы подтянутся инкрементально.
			localStorage.setItem(CACHE_USER_KEY, currentUser);
			localStorage.setItem(ACCESS_SIG_KEY, sig);
			return;
		}

		await db.transaction('rw', [db.data_records, db.data_lines, db.data_files], async () => {
			await db.data_records.clear();
			await db.data_lines.clear();
			await db.data_files.clear();
		});
		localStorage.removeItem('erp_last_pull_anchor');
		localStorage.setItem(CACHE_USER_KEY, currentUser);
		localStorage.setItem(ACCESS_SIG_KEY, sig);
	}

	private async onSessionContextChanged(): Promise<void> {
		if (this.user?.id) {
			await ensureTeamMemberRecord(
				this.user.id,
				this.user.email ?? this.user.user_metadata?.full_name ?? 'Участник',
				'email'
			);
		}
		void this.recomputeAccess();
	}
}

export const auth = new AuthManager();
