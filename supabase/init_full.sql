-- ============================================================================
-- Полная схема базы данных my-erp-app (my-erp-app).
-- Самодостаточный идемпотентный эквивалент миграций 0001–0010.
--
-- НАЗНАЧЕНИЕ: развёртывание СХЕМЫ на НОВОМ проекте Supabase с нуля
-- (для фичи «Резервная копия»: выгрузка/загрузка проекта JSON-файлом).
-- Не заменяет миграции для существующих инсталляций — история миграций
-- supabase_migrations.schema_migrations остаётся нетронутой.
--
-- БЕЗОПАСНОСТЬ: все операции идемпотентны (IF NOT EXISTS / OR REPLACE /
-- DO-блоки). Скрипт можно применять повторно без ошибок и без потери данных.
--
-- ПРИМЕНЕНИЕ (любой из способов):
--   1. Supabase Dashboard → SQL Editor → вставить содержимое → Run
--   2. psql:  psql "$DATABASE_URL" -f supabase/init_full.sql
--   3. Supabase CLI на новом проекте (если каталог migrations/ пуст):
--      cp supabase/init_full.sql supabase/migrations/0001_cloud_init.sql
--      supabase db push
--
-- ВАЖНО: скрипт создаёт ТОЛЬКО схему (типы, таблицы, функции, индексы).
-- Данные (в т.ч. записи сидов системных таблиц) приложение создаёт само
-- при первом запуске (metadata.ensureSystemTables → ensureModule/seed).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Типы ENUM
-- ----------------------------------------------------------------------------

-- column_type: базовые значения (без IF NOT EXISTS для самого типа — через DO)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'column_type') THEN
        CREATE TYPE public.column_type AS ENUM (
            'string',
            'number',
            'boolean',
            'date',
            'jsonb',
            'link',
            'parent_link'
        );
    END IF;
END
$$;

-- record_status
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'record_status') THEN
        CREATE TYPE public.record_status AS ENUM (
            'draft',
            'posted',
            'marked_for_deletion'
        );
    END IF;
END
$$;

-- Расширение column_type из миграций 0002–0008 (идемпотентно)
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'file';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'zip';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'datetime';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'birth';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'universal';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'linelink';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'select';
ALTER TYPE public.column_type ADD VALUE IF NOT EXISTS 'paramslist';

-- ----------------------------------------------------------------------------
-- Функции
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_first_user_admin() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Если это первый пользователь в системе auth.users, даем ему роль admin
    IF (SELECT COUNT(*) FROM auth.users) = 1 THEN
        INSERT INTO public.user_roles (user_id, role_id)
        VALUES (NEW.id, (SELECT id FROM public.roles WHERE name = 'admin'));
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = auth.uid() AND r.name = 'admin'
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- Таблицы
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.data_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_id uuid,
    table_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.data_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid,
    status public.record_status DEFAULT 'draft'::public.record_status NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_folder boolean DEFAULT false,
    parent_id uuid
);

CREATE TABLE IF NOT EXISTS public.meta_columns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid,
    name text NOT NULL,
    title text NOT NULL,
    type public.column_type DEFAULT 'string'::public.column_type NOT NULL,
    related_table_id uuid,
    sort_order integer DEFAULT 0 NOT NULL,
    is_visible boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.meta_table_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    label text NOT NULL,
    definition jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.meta_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    title text NOT NULL,
    type text DEFAULT 'NULL'::text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    parent_table_id uuid,
    config jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.print_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid,
    name text NOT NULL,
    is_default boolean DEFAULT false,
    template_html text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    role_id uuid
);

CREATE TABLE IF NOT EXISTS public.data_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id uuid REFERENCES public.data_records (id) ON DELETE CASCADE,
    column_id text NOT NULL DEFAULT '',
    name text NOT NULL DEFAULT '',
    size bigint NOT NULL DEFAULT 0,
    type text NOT NULL DEFAULT '',
    content text,
    updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ----------------------------------------------------------------------------
-- Первичные ключи (миграция 0005, идемпотентно)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY[
		'meta_tables',
		'meta_columns',
		'meta_table_types',
		'data_records',
		'data_lines',
		'print_forms',
		'roles',
		'user_roles'
	] LOOP
		IF NOT EXISTS (
			SELECT 1
			FROM pg_constraint c
			JOIN pg_class cl ON cl.oid = c.conrelid
			JOIN pg_namespace n ON n.oid = cl.relnamespace
			WHERE c.contype = 'p' AND cl.relname = t AND n.nspname = 'public'
		) THEN
			EXECUTE format('ALTER TABLE public.%I ADD PRIMARY KEY (id)', t);
		END IF;
	END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Индексы производительности (миграции 0009, 0010, идемпотентно)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS data_records_updated_at_idx
    ON public.data_records (updated_at);

CREATE INDEX IF NOT EXISTS data_records_table_id_idx
    ON public.data_records (table_id);

CREATE INDEX IF NOT EXISTS data_records_tablestatus_idx
    ON public.data_records (table_id, status);

CREATE INDEX IF NOT EXISTS data_lines_record_id_idx
    ON public.data_lines (record_id);

CREATE INDEX IF NOT EXISTS data_lines_table_id_idx
    ON public.data_lines (table_id);

CREATE INDEX IF NOT EXISTS data_files_record_id_idx ON public.data_files (record_id);

-- ----------------------------------------------------------------------------
-- Авторизация: команда, роли, правила доступа, RLS (миграция 0011)
-- ----------------------------------------------------------------------------

-- Роль пользователя из «Команды» (по имени роли, без связывания id).
CREATE OR REPLACE FUNCTION public.auth_user_role(p_uid uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE v_role text;
BEGIN
	SELECT (r.data->>'role')::text INTO v_role
	FROM public.data_records r
	JOIN public.meta_tables t ON t.id = r.table_id
	WHERE t.name = 'team_members'
		AND (r.data->>'user_id')::uuid = p_uid
	LIMIT 1;
	RETURN COALESCE(v_role, '');
END;
$$;

-- Владелец или администратор (полный доступ).
CREATE OR REPLACE FUNCTION public.auth_is_admin(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
	SELECT p_uid IS NOT NULL AND public.auth_user_role(p_uid) IN ('owner', 'admin');
$$;

-- Режим доступа: 'open' (по умолчанию) или 'locked'.
CREATE OR REPLACE FUNCTION public.auth_access_mode()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE v_mode text;
BEGIN
	SELECT (r.data->>'mode')::text INTO v_mode
	FROM public.data_records r
	JOIN public.meta_tables t ON t.id = r.table_id
	WHERE t.name = 'app_settings' AND r.data->>'key' = 'access_lockdown'
	LIMIT 1;
	RETURN COALESCE(v_mode, 'open');
END;
$$;

-- Имя таблицы по id (системные таблицы движок читает по имени).
CREATE OR REPLACE FUNCTION public.auth_table_name(p_table_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE v_name text;
BEGIN
	SELECT t.name INTO v_name FROM public.meta_tables t WHERE t.id = p_table_id;
	RETURN v_name;
END;
$$;

-- Таблица публична (config.public = true) — просмотр без входа.
CREATE OR REPLACE FUNCTION public.auth_table_is_public(p_table_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE v_pub boolean;
BEGIN
	SELECT (t.config->>'public')::boolean INTO v_pub
	FROM public.meta_tables t WHERE t.id = p_table_id;
	RETURN COALESCE(v_pub, false);
END;
$$;

-- Есть ли правило доступа: principal (anon|user|role) x object (table|record) x action.
CREATE OR REPLACE FUNCTION public.auth_has_rule(
	p_uid uuid,
	p_table_id uuid,
	p_record_id uuid,
	p_action text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE v_role text;
DECLARE v_hit boolean;
BEGIN
	v_role := public.auth_user_role(p_uid);
	SELECT EXISTS (
		SELECT 1
		FROM public.data_records r
		JOIN public.meta_tables t ON t.id = r.table_id
		WHERE t.name = 'access_rules'
			AND r.data->>'action' = p_action
			AND (
				(r.data->>'object_type' = 'table' AND (r.data->>'object_id')::uuid = p_table_id)
				OR (r.data->>'object_type' = 'record'
					AND p_record_id IS NOT NULL
					AND (r.data->>'object_id')::uuid = p_record_id)
			)
			AND (
				r.data->>'principal_type' = 'anon'
				OR (r.data->>'principal_type' = 'user'
					AND p_uid IS NOT NULL
					AND (r.data->>'principal_id')::uuid = p_uid)
				OR (r.data->>'principal_type' = 'role'
					AND v_role <> ''
					AND r.data->>'principal_id' = v_role)
			)
	) INTO v_hit;
	RETURN COALESCE(v_hit, false);
END;
$$;

-- Просмотр записи/таблицы.
CREATE OR REPLACE FUNCTION public.auth_can_view(p_uid uuid, p_table_id uuid, p_record_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE v_name text;
BEGIN
	IF public.auth_access_mode() = 'open' THEN
		RETURN true;
	END IF;
	IF p_uid IS NOT NULL AND public.auth_is_admin(p_uid) THEN
		RETURN true;
	END IF;
	IF p_table_id IS NULL THEN
		RETURN false;
	END IF;
	v_name := public.auth_table_name(p_table_id);
	-- Системные таблицы: «Команда»/«Правила» — только админам; «Роли» — всем
	-- вошедшим; «История» — только админам; «Настройки» — всем вошедшим.
	IF v_name IN ('team_members', 'access_rules', 'history') THEN
		RETURN public.auth_is_admin(p_uid);
	END IF;
	IF v_name IN ('access_roles', 'app_settings') THEN
		RETURN p_uid IS NOT NULL;
	END IF;
	-- Публичные таблицы + правила (аноним/роль/юзер).
	RETURN public.auth_table_is_public(p_table_id)
		OR public.auth_has_rule(p_uid, p_table_id, p_record_id, 'view');
END;
$$;

-- Изменение записи/таблицы. p_self_user_id — для саморегистрации в «Команде».
CREATE OR REPLACE FUNCTION public.auth_can_edit(
	p_uid uuid,
	p_table_id uuid,
	p_record_id uuid,
	p_self_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE v_name text;
BEGIN
	IF public.auth_access_mode() = 'open' THEN
		RETURN true;
	END IF;
	IF p_uid IS NULL THEN
		RETURN false;
	END IF;
	IF public.auth_is_admin(p_uid) THEN
		RETURN true;
	END IF;
	IF p_table_id IS NULL THEN
		RETURN false;
	END IF;
	v_name := public.auth_table_name(p_table_id);
	-- Саморегистрация в «Команде»: участник создаёт только свою строку.
	IF v_name = 'team_members' THEN
		RETURN p_self_user_id IS NOT NULL AND p_self_user_id = p_uid;
	END IF;
	-- Правила/роли/настройки — только админы; в «Историю» каждый может писать
	-- (аудиторный журнал), читать её может только админ.
	IF v_name IN ('access_rules', 'access_roles', 'app_settings') THEN
		RETURN false;
	END IF;
	IF v_name = 'history' THEN
		RETURN true;
	END IF;
	RETURN public.auth_has_rule(p_uid, p_table_id, p_record_id, 'edit');
END;
$$;

-- RLS: data_records
ALTER TABLE public.data_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dr_select ON public.data_records;
CREATE POLICY dr_select ON public.data_records
	FOR SELECT USING (public.auth_can_view(auth.uid(), table_id, id));

DROP POLICY IF EXISTS dr_insert ON public.data_records;
CREATE POLICY dr_insert ON public.data_records
	FOR INSERT WITH CHECK (
		public.auth_can_edit(auth.uid(), table_id, id, NULLIF(data->>'user_id', '')::uuid)
	);

DROP POLICY IF EXISTS dr_update ON public.data_records;
CREATE POLICY dr_update ON public.data_records
	FOR UPDATE
	USING (public.auth_can_edit(auth.uid(), table_id, id))
	WITH CHECK (public.auth_can_edit(auth.uid(), table_id, id));

DROP POLICY IF EXISTS dr_delete ON public.data_records;
CREATE POLICY dr_delete ON public.data_records
	FOR DELETE USING (public.auth_can_edit(auth.uid(), table_id, id));

-- RLS: data_lines, data_files — по правам на родительскую запись
ALTER TABLE public.data_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dl_select ON public.data_lines;
CREATE POLICY dl_select ON public.data_lines FOR SELECT USING (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_view(auth.uid(), r.table_id, r.id)
	)
);

DROP POLICY IF EXISTS dl_insert ON public.data_lines;
CREATE POLICY dl_insert ON public.data_lines FOR INSERT WITH CHECK (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_edit(auth.uid(), r.table_id, r.id)
	)
);

DROP POLICY IF EXISTS dl_update ON public.data_lines;
CREATE POLICY dl_update ON public.data_lines FOR UPDATE USING (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_edit(auth.uid(), r.table_id, r.id)
	)
) WITH CHECK (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_edit(auth.uid(), r.table_id, r.id)
	)
);

DROP POLICY IF EXISTS dl_delete ON public.data_lines;
CREATE POLICY dl_delete ON public.data_lines FOR DELETE USING (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_edit(auth.uid(), r.table_id, r.id)
	)
);

ALTER TABLE public.data_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS df_select ON public.data_files;
CREATE POLICY df_select ON public.data_files FOR SELECT USING (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_view(auth.uid(), r.table_id, r.id)
	)
);

DROP POLICY IF EXISTS df_insert ON public.data_files;
CREATE POLICY df_insert ON public.data_files FOR INSERT WITH CHECK (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_edit(auth.uid(), r.table_id, r.id)
	)
);

DROP POLICY IF EXISTS df_update ON public.data_files;
CREATE POLICY df_update ON public.data_files FOR UPDATE USING (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_edit(auth.uid(), r.table_id, r.id)
	)
) WITH CHECK (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_edit(auth.uid(), r.table_id, r.id)
	)
);

DROP POLICY IF EXISTS df_delete ON public.data_files;
CREATE POLICY df_delete ON public.data_files FOR DELETE USING (
	EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.id = record_id AND public.auth_can_edit(auth.uid(), r.table_id, r.id)
	)
);

-- RLS: метаданные (схему видно всем, меняют админы)
ALTER TABLE public.meta_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_columns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mt_select ON public.meta_tables;
CREATE POLICY mt_select ON public.meta_tables FOR SELECT USING (true);

DROP POLICY IF EXISTS mt_insert ON public.meta_tables;
CREATE POLICY mt_insert ON public.meta_tables
	FOR INSERT WITH CHECK (public.auth_can_edit(auth.uid(), id, NULL));

DROP POLICY IF EXISTS mt_update ON public.meta_tables;
CREATE POLICY mt_update ON public.meta_tables
	FOR UPDATE
	USING (public.auth_can_edit(auth.uid(), id, NULL))
	WITH CHECK (public.auth_can_edit(auth.uid(), id, NULL));

DROP POLICY IF EXISTS mt_delete ON public.meta_tables;
CREATE POLICY mt_delete ON public.meta_tables
	FOR DELETE USING (public.auth_can_edit(auth.uid(), id, NULL));

DROP POLICY IF EXISTS mc_select ON public.meta_columns;
CREATE POLICY mc_select ON public.meta_columns FOR SELECT USING (true);

DROP POLICY IF EXISTS mc_insert ON public.meta_columns;
CREATE POLICY mc_insert ON public.meta_columns
	FOR INSERT WITH CHECK (public.auth_can_edit(auth.uid(), table_id, NULL));

DROP POLICY IF EXISTS mc_update ON public.meta_columns;
CREATE POLICY mc_update ON public.meta_columns
	FOR UPDATE
	USING (public.auth_can_edit(auth.uid(), table_id, NULL))
	WITH CHECK (public.auth_can_edit(auth.uid(), table_id, NULL));

DROP POLICY IF EXISTS mc_delete ON public.meta_columns;
CREATE POLICY mc_delete ON public.meta_columns
	FOR DELETE USING (public.auth_can_edit(auth.uid(), table_id, NULL));

ALTER TABLE public.meta_table_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mtt_select ON public.meta_table_types;
CREATE POLICY mtt_select ON public.meta_table_types FOR SELECT USING (true);

DROP POLICY IF EXISTS mtt_insert ON public.meta_table_types;
CREATE POLICY mtt_insert ON public.meta_table_types
	FOR INSERT WITH CHECK (public.auth_can_edit(auth.uid(), NULL, NULL));

DROP POLICY IF EXISTS mtt_update ON public.meta_table_types;
CREATE POLICY mtt_update ON public.meta_table_types
	FOR UPDATE USING (public.auth_can_edit(auth.uid(), NULL, NULL))
	WITH CHECK (public.auth_can_edit(auth.uid(), NULL, NULL));

DROP POLICY IF EXISTS mtt_delete ON public.meta_table_types;
CREATE POLICY mtt_delete ON public.meta_table_types
	FOR DELETE USING (public.auth_can_edit(auth.uid(), NULL, NULL));

-- Первый пользователь — Владелец: при регистрации создаём строку «Команды».
CREATE OR REPLACE FUNCTION public.auth_team_member_upsert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_team_table uuid;
DECLARE v_role text;
DECLARE v_members integer;
BEGIN
	SELECT t.id INTO v_team_table
	FROM public.meta_tables t
	WHERE t.name = 'team_members'
	ORDER BY t.id
	LIMIT 1;
	IF v_team_table IS NULL THEN
		RETURN NEW; -- таблица ещё не создана сидом
	END IF;

	IF EXISTS (
		SELECT 1 FROM public.data_records r
		WHERE r.table_id = v_team_table AND (r.data->>'user_id')::uuid = NEW.id
	) THEN
		RETURN NEW; -- уже есть строка
	END IF;

	SELECT COUNT(*) INTO v_members FROM public.data_records r WHERE r.table_id = v_team_table;
	IF v_members = 0 THEN
		v_role := 'owner';
	ELSE
		v_role := '';
	END IF;

	INSERT INTO public.data_records (id, table_id, status, data, is_folder, parent_id, updated_at)
	VALUES (
		gen_random_uuid(),
		v_team_table,
		'draft',
		jsonb_build_object(
			'user_id', NEW.id::text,
			'display_name', COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email, ''),
			'provider', COALESCE(NEW.raw_user_meta_data->>'provider', 'email'),
			'external_id', COALESCE(NEW.raw_user_meta_data->>'external_id', ''),
			'role', v_role,
			'status', CASE WHEN v_role = 'owner' THEN 'active' ELSE 'invited' END
		),
		false,
		NULL,
		timezone('utc', now())
	);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auth_team_member_upsert_trigger ON auth.users;
CREATE TRIGGER auth_team_member_upsert_trigger
	AFTER INSERT ON auth.users
	FOR EACH ROW
	EXECUTE FUNCTION public.auth_team_member_upsert();
