<script lang="ts">
	import { auth } from '$lib/state/auth.svelte';

	let mode = $state<'login' | 'register'>('login');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let info = $state('');
	let busy = $state(false);

	async function submit() {
		if (!email.trim() || !password) {
			error = 'Введите e-mail и пароль';
			return;
		}
		error = '';
		info = '';
		busy = true;
		try {
			if (mode === 'login') {
				const res = await auth.signInWithEmail(email.trim(), password);
				if (!res.ok) error = res.error ?? 'Не удалось войти';
			} else {
				const res = await auth.signUp(email.trim(), password);
				if (!res.ok) {
					error = res.error ?? 'Не удалось зарегистрироваться';
				} else if (res.needsConfirmation) {
					info = `Регистрация почти готова. На ${email.trim()} отправлено письмо — перейдите по ссылке из него для подтверждения.`;
					password = '';
				}
			}
		} finally {
			busy = false;
		}
	}

	function provider(p: 'vk' | 'telegram') {
		error = '';
		auth.signInWithProvider(p);
	}
</script>

<div class="login-wrap">
	<div class="login-card">
		<div class="login-logo">🛠️ Low-Code ERP</div>
		<h1 class="login-title">Вход в систему</h1>

		<div class="provider-row">
			<button class="provider-btn provider-vk" onclick={() => provider('vk')}>ВКонтакте</button>
			<button class="provider-btn provider-tg" onclick={() => provider('telegram')}>Telegram</button
			>
		</div>

		<div class="divider"><span>или по e-mail</span></div>

		<div class="tabs">
			<button class="tab" class:active={mode === 'login'} onclick={() => (mode = 'login')}>
				Войти
			</button>
			<button class="tab" class:active={mode === 'register'} onclick={() => (mode = 'register')}>
				Зарегистрироваться
			</button>
		</div>

		<form
			onsubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<label class="field">
				<span class="field-label">E-mail</span>
				<input type="email" bind:value={email} autocomplete="email" />
			</label>
			<label class="field">
				<span class="field-label">Пароль</span>
				<input
					type="password"
					bind:value={password}
					autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
				/>
			</label>

			{#if error}<div class="error">{error}</div>{/if}
			{#if info}<div class="info">{info}</div>{/if}

			<button type="submit" class="submit" disabled={busy}>
				{busy ? 'Пожалуйста, подождите…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
			</button>
		</form>

		<button class="guest-btn" onclick={() => auth.enterAsGuest()}>
			Продолжить гостем (только публичные данные)
		</button>
	</div>
</div>

<style>
	.login-wrap {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100vh;
		width: 100vw;
		background: linear-gradient(135deg, #eef2f7 0%, #e2e8f0 100%);
	}
	.login-card {
		width: 360px;
		background: #ffffff;
		border-radius: 12px;
		box-shadow: 0 8px 30px rgba(15, 23, 42, 0.12);
		padding: 2rem;
	}
	.login-logo {
		text-align: center;
		font-size: 1.1rem;
		font-weight: 700;
		color: #4f46e5;
		margin-bottom: 0.4rem;
	}
	.login-title {
		text-align: center;
		font-size: 1.25rem;
		color: #1f2937;
		margin: 0 0 1.25rem;
	}
	.provider-row {
		display: flex;
		gap: 8px;
		margin-bottom: 1rem;
	}
	.provider-btn {
		flex: 1;
		padding: 10px 8px;
		border: none;
		border-radius: 8px;
		color: #fff;
		font-size: 0.9rem;
		cursor: pointer;
		font-weight: 600;
	}
	.provider-vk {
		background: #0077ff;
	}
	.provider-vk:hover {
		background: #0065d6;
	}
	.provider-tg {
		background: #229ed9;
	}
	.provider-tg:hover {
		background: #1b86b8;
	}
	.divider {
		display: flex;
		align-items: center;
		gap: 10px;
		color: #94a3b8;
		font-size: 0.8rem;
		margin-bottom: 1rem;
	}
	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: #e2e8f0;
	}
	.tabs {
		display: flex;
		background: #eef2f7;
		border-radius: 8px;
		padding: 3px;
		margin-bottom: 1rem;
	}
	.tab {
		flex: 1;
		border: none;
		background: none;
		padding: 8px;
		border-radius: 6px;
		cursor: pointer;
		color: #64748b;
		font-size: 0.85rem;
	}
	.tab.active {
		background: #ffffff;
		color: #1f2937;
		font-weight: 600;
		box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
	}
	.field {
		display: block;
		margin-bottom: 0.8rem;
	}
	.field-label {
		display: block;
		font-size: 0.8rem;
		color: #475569;
		margin-bottom: 4px;
	}
	input {
		width: 100%;
		box-sizing: border-box;
		padding: 10px;
		border: 1px solid #cbd5e1;
		border-radius: 8px;
		font-size: 0.9rem;
		outline: none;
	}
	input:focus {
		border-color: #4f46e5;
	}
	.error {
		color: #dc2626;
		font-size: 0.8rem;
		margin: 0.5rem 0;
	}
	.info {
		color: #16a34a;
		font-size: 0.8rem;
		line-height: 1.4;
		margin: 0.5rem 0;
	}
	.submit {
		width: 100%;
		margin-top: 0.5rem;
		padding: 10px;
		border: none;
		border-radius: 8px;
		background: #4f46e5;
		color: #fff;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
	}
	.submit:hover:not(:disabled) {
		background: #4338ca;
	}
	.submit:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.guest-btn {
		width: 100%;
		margin-top: 0.75rem;
		padding: 8px;
		border: 1px solid #cbd5e1;
		background: #ffffff;
		border-radius: 8px;
		color: #64748b;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.guest-btn:hover {
		background: #f1f5f9;
	}
</style>
