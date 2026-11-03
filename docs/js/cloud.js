// התחברות ושמירה בענן עם Supabase (חינמי). אם לא הוגדר - האפליקציה עובדת רק עם שמירה במכשיר.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './cloud-config.js';

let client = null;
let loading = null;
export let user = null;

export const isConfigured = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('err.authLib'));
    document.head.appendChild(s);
  });
}

/** אתחול. onAuth נקרא בכל שינוי התחברות. */
export async function init(onAuth) {
  if (!isConfigured()) return null;
  if (!loading) {
    loading = (async () => {
      if (!window.supabase) await loadScript(new URL('../lib/supabase.js', import.meta.url).href);
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
      const { data } = await client.auth.getSession();
      user = data.session?.user || null;
      client.auth.onAuthStateChange((_e, session) => {
        user = session?.user || null;
        onAuth?.(user);
      });
      return client;
    })();
  }
  await loading;
  onAuth?.(user);
  return user;
}

function heError(e) {
  // מחזיר מפתח תרגום (err.*) או את ההודעה המקורית
  const m = (e && e.message) || String(e);
  if (/Invalid login credentials/i.test(m)) return 'err.badLogin';
  if (/already registered/i.test(m)) return 'err.registered';
  if (/Password should be/i.test(m)) return 'err.shortPass';
  if (/Email not confirmed/i.test(m)) return 'err.notConfirmed';
  if (/valid email|invalid format/i.test(m)) return 'err.badEmail';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'err.offline';
  return m;
}

export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(heError(error));
  return data.user;
}

export async function signUp(email, password) {
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(heError(error));
  return { user: data.user, needsConfirm: !data.session };
}

export async function signOut() {
  await client.auth.signOut();
}

// ---------- שירים ----------
export async function listSongs() {
  const { data, error } = await client.from('songs').select('id,title,updated_at,created_at').order('updated_at', { ascending: false });
  if (error) throw new Error(heError(error));
  return data.map((r) => ({ id: r.id, title: r.title, updatedAt: Date.parse(r.updated_at), createdAt: Date.parse(r.created_at) }));
}

export async function getSong(id) {
  const { data, error } = await client.from('songs').select('*').eq('id', id).single();
  if (error) throw new Error(heError(error));
  let audio = null;
  if (data.audio_path) {
    const r = await client.storage.from('audio').download(data.audio_path);
    if (!r.error) audio = r.data;
  }
  return { ...data.data, id: data.id, title: data.title, audio };
}

export async function saveSong(song, audioBlob) {
  let audio_path;
  if (audioBlob) {
    audio_path = `${user.id}/${song.id}`;
    const r = await client.storage.from('audio').upload(audio_path, audioBlob, {
      upsert: true, contentType: audioBlob.type || 'application/octet-stream',
    });
    if (r.error) audio_path = undefined; // השיר נשמר גם בלי השמע
  }
  const { analysis, settings, lyrics, createdAt } = song;
  const row = {
    id: song.id,
    user_id: user.id,
    title: song.title || '',
    data: { analysis, settings, lyrics, createdAt },
    updated_at: new Date().toISOString(),
  };
  if (audio_path) row.audio_path = audio_path;
  const { error } = await client.from('songs').upsert(row);
  if (error) throw new Error(heError(error));
}

export async function deleteSong(id) {
  await client.storage.from('audio').remove([`${user.id}/${id}`]).catch(() => {});
  const { error } = await client.from('songs').delete().eq('id', id);
  if (error) throw new Error(heError(error));
}
