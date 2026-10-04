import { BrowserWindow, session, type Session } from 'electron';
import { PLAYER_PARTITION } from './constants';

// ---- Google login (for YouTube Premium) -----------------------------------
// Google refuses sign-in from embedded browsers ("This browser or app may not
// be secure"). The usual giveaway is Chromium's Client Hints (Sec-CH-UA*),
// which name Electron/Chromium regardless of the UA string. So the login runs
// in a dedicated window on the players' session, presenting a Firefox UA (which
// never sends Client Hints) with all sec-ch-ua* headers stripped. The resulting
// cookies land in the shared partition, so both <webview>s become logged in.

export interface LoginState {
  loggedIn: boolean;
}

// Same flow as YouTube's own "Sign in" button: continuing through
// /signin?action_handle_signin=true is what makes YouTube issue LOGIN_INFO.
// A bare continue=https://www.youtube.com/ only yields the Google SID cookies.
const LOGIN_URL =
  'https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=' +
  encodeURIComponent(
    'https://www.youtube.com/signin?action_handle_signin=true&app=desktop&next=/',
  );
const DONE_PREFIX = 'https://www.youtube.com/';

// Keep this reasonably current: Google rejects browsers it considers outdated.
const FIREFOX_UA =
  process.platform === 'win32'
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0'
    : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';

const GOOGLE_URLS = ['https://accounts.google.com/*', 'https://*.google.com/*'];

const DEBUG_LOGIN = process.env.U2S_DEBUG_LOGIN === '1';

let loginWindow: BrowserWindow | null = null;

function playerSession(): Session {
  return session.fromPartition(PLAYER_PARTITION);
}

/**
 * Install the Client-Hints stripping filter on the player session. A session
 * holds only one listener per webRequest event (a later registration replaces
 * the earlier one), so call this exactly once at app startup.
 */
export function installLoginHeaderFilter(): void {
  const ses = playerSession();
  ses.webRequest.onBeforeSendHeaders({ urls: GOOGLE_URLS }, (details, cb) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase().startsWith('sec-ch-ua')) delete headers[name];
    }
    cb({ requestHeaders: headers });
  });

  // onSendHeaders reports the headers as actually sent (after our filter and
  // the network stack's own additions), which is what Google sees.
  if (DEBUG_LOGIN) {
    ses.webRequest.onSendHeaders(
      { urls: ['https://accounts.google.com/*'] },
      (details) => {
        console.log(
          `[login] ${details.method} ${details.url}\n`,
          details.requestHeaders,
        );
      },
    );
  }
}

/**
 * Open the login window. `onChange` fires with the fresh login state whenever
 * the window finishes (login completed or closed by the user).
 */
export function openGoogleLogin(
  parent: BrowserWindow | null,
  onChange: (state: LoginState) => void,
): void {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent: parent ?? undefined,
    title: 'Google Login',
    webPreferences: {
      partition: PLAYER_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loginWindow = win;
  win.webContents.setUserAgent(FIREFOX_UA);

  // did-navigate fires once the main frame commits, i.e. after the whole
  // redirect chain, so the session cookies set along the way are stored.
  win.webContents.on('did-navigate', (_e, url) => {
    if (DEBUG_LOGIN) console.log('[login] navigated:', url);
    if (url.startsWith(DONE_PREFIX)) win.close();
  });

  win.on('closed', () => {
    loginWindow = null;
    getLoginState().then(onChange, () => onChange({ loggedIn: false }));
  });

  win.loadURL(LOGIN_URL);
}

/**
 * Logged in = one of the SAPISID auth cookies on .youtube.com. These are what
 * YouTube authenticates requests with; LOGIN_INFO is not required (a login that
 * skips YouTube's /signin step has the SAPISIDs but no LOGIN_INFO).
 */
export async function getLoginState(): Promise<LoginState> {
  const cookies = await playerSession().cookies.get({ domain: '.youtube.com' });
  const names = new Set(cookies.map((c) => c.name));
  const loggedIn = names.has('SAPISID') || names.has('__Secure-3PAPISID');
  return { loggedIn };
}

/**
 * Drop YouTube + Google storage, cookies included. clearData (not
 * clearStorageData, which only takes a single `origin`) clears cookies for the
 * whole registrable domain, so .youtube.com / .google.com cookies go too.
 */
export async function logout(): Promise<LoginState> {
  await playerSession().clearData({
    origins: ['https://www.youtube.com', 'https://accounts.google.com'],
  });
  return getLoginState();
}
