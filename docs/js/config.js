// כתובת שרת העיבוד ב-Hugging Face Spaces.
// הפורמט: https://<שם-משתמש>-<שם-הספייס>.hf.space  (אותיות קטנות, נקודות/קווים תחתונים הופכים למקפים)
export const DEFAULT_SERVER_URL = 'https://davidibgui-music-notes-server.hf.space';

// אפשר לעקוף לבדיקות: ?server=http://localhost:7860 (נשמר בדפדפן)
export function serverUrl() {
  try {
    const q = new URLSearchParams(location.search).get('server');
    if (q) localStorage.setItem('tavim:server', q);
    return (localStorage.getItem('tavim:server') || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

export const MAX_RECORD_SECONDS = 360;
