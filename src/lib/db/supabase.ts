import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public'; 

export const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true, // Сохраняем сессию (токен) в LocalStorage браузера
        autoRefreshToken: true // Автоматически обновляем токен, когда у него истекает время жизни
    }
});

