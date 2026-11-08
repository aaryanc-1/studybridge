// Google Drive and OneDrive (step 6, 7 Nov 2026). Everything happens in the teacher's own browser with their own
// Google or Microsoft sign-in: StudyBridge's server never talks to Google or Microsoft, and the sign-in (a short-lived
// access token) stays in this page's memory only. StudyBridge keeps just the links and file ids.
// Google: Google Identity Services + the Google Picker, Drive API with the drive.file scope (only files the teacher
// picks, and the copies StudyBridge makes). Microsoft: a PKCE sign-in in a small window (public/drive-auth.html sends
// the answer back) and Microsoft Graph (Files.ReadWrite, User.Read).
import { desktop } from './config.js';
import { WEB_APP } from './api.js';

export const PROVIDERS = { google: 'Google Drive', microsoft: 'OneDrive' };
export const driveOn = (settings, p) => !!settings?.drive?.[p];
// Google refuses sign-in inside apps, so the desktop app sends teachers to StudyBridge in their browser for this
export const pickHere = () => !desktop;
export const openWebApp = (hash) => window.open(WEB_APP + (hash ? '#' + hash.replace(/^#/, '') : ''), '_blank');

const loaded = {};
function loadScript(src) {
  if (!loaded[src])
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        delete loaded[src];
        reject(new Error('Couldn’t reach Google. Check the connection and try again.'));
      };
      document.head.appendChild(s);
    });
  return loaded[src];
}
// Get the scripts ready before the click, so the sign-in window isn't blocked
export function preload(settings) {
  if (driveOn(settings, 'google') && pickHere()) {
    loadScript('https://accounts.google.com/gsi/client').catch(() => {});
    loadScript('https://apis.google.com/js/api.js').catch(() => {});
  }
}

// ---------------- Google ----------------
let gToken = null;
let gPrompt = ''; // 'select_account' after "use your school account", so they can pick another one
async function googleToken(cfg) {
  if (gToken && gToken.exp > Date.now() + 60000) return gToken.token;
  await loadScript('https://accounts.google.com/gsi/client');
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: cfg.client_id,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (r) => {
        if (r?.error || !r?.access_token) return reject(new Error('Google didn’t let StudyBridge in. Try again.'));
        gToken = { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'Google sign-in was closed.' : e?.type === 'popup_failed_to_open' ? 'Allow pop-ups for StudyBridge, then try again.' : 'Couldn’t sign in to Google.')),
    });
    client.requestAccessToken({ prompt: gPrompt });
    gPrompt = '';
  });
}
async function gfetch(token, path, opts = {}) {
  const r = await fetch('https://www.googleapis.com/drive/v3/' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.error?.message || 'Google Drive said no.');
    e.status = r.status;
    e.reason = j?.error?.errors?.[0]?.reason || '';
    throw e;
  }
  return j;
}
async function googlePick(cfg) {
  const token = await googleToken(cfg);
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise((resolve) => window.gapi.load('picker', resolve));
  return new Promise((resolve) => {
    const P = window.google.picker;
    const view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
    new P.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(cfg.api_key)
      .setAppId(cfg.app_id)
      .enableFeature(P.Feature.MULTISELECT_ENABLED)
      .setTitle('Choose from Google Drive')
      .setCallback((data) => {
        if (data[P.Response.ACTION] === P.Action.PICKED)
          resolve((data[P.Response.DOCUMENTS] || []).map((d) => ({ provider: 'google', id: d[P.Document.ID], title: d[P.Document.NAME], url: d[P.Document.URL], mime: d[P.Document.MIME_TYPE] })));
        else if (data[P.Response.ACTION] === P.Action.CANCEL) resolve([]);
      })
      .build()
      .setVisible(true);
  });
}

// ---------------- Microsoft ----------------
let mToken = null;
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const MS_SCOPE = 'Files.ReadWrite User.Read';
export const msRedirect = () => new URL('drive-auth.html', location.href.split('#')[0]).href;
async function microsoftToken(cfg) {
  if (mToken && mToken.exp > Date.now() + 60000) return mToken.token;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirect = msRedirect();
  const q = new URLSearchParams({ client_id: cfg.client_id, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope: MS_SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account' });
  const popup = window.open('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + q, 'sb-onedrive', 'width=520,height=700');
  if (!popup) throw new Error('Allow pop-ups for StudyBridge, then try again.');
  const code = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (popup.closed) {
        done();
        reject(new Error('Microsoft sign-in was closed.'));
      }
    }, 700);
    const onMsg = (e) => {
      if (e.origin !== location.origin || e.data?.type !== 'sb-drive-auth') return;
      done();
      const r = new URLSearchParams(e.data.search || '');
      if (r.get('state') !== state) return reject(new Error('That sign-in didn’t match. Try again.'));
      if (r.get('error')) return reject(new Error(r.get('error') === 'access_denied' ? 'Microsoft sign-in was cancelled.' : r.get('error_description') || 'Couldn’t sign in to Microsoft.'));
      resolve(r.get('code'));
    };
    function done() {
      clearInterval(timer);
      window.removeEventListener('message', onMsg);
    }
    window.addEventListener('message', onMsg);
  });
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.client_id, grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, scope: MS_SCOPE }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description?.split('\n')[0] || 'Couldn’t sign in to Microsoft.');
  mToken = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return mToken.token;
}
async function mfetch(token, path, opts = {}) {
  const r = await fetch(path.startsWith('https://') ? path : 'https://graph.microsoft.com/v1.0' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  if (r.status === 202 || r.status === 204) return { status: r.status };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.error?.message || 'OneDrive said no.');
    e.status = r.status;
    e.reason = j?.error?.code || '';
    throw e;
  }
  return j;
}
const MS_FIELDS = '$select=id,name,file,folder,webUrl,size,parentReference&$top=200';
export async function msList(settings, folderId = null) {
  const t = await microsoftToken(settings.drive.microsoft);
  return (await mfetch(t, folderId ? `/me/drive/items/${folderId}/children?${MS_FIELDS}` : `/me/drive/root/children?${MS_FIELDS}`)).value || [];
}
export async function msSearch(settings, text) {
  const t = await microsoftToken(settings.drive.microsoft);
  return (await mfetch(t, `/me/drive/root/search(q='${encodeURIComponent(String(text).replace(/'/g, "''"))}')?${MS_FIELDS}`)).value || [];
}
export const msLink = (item) => ({ provider: 'microsoft', id: item.id, title: item.name, url: item.webUrl, mime: item.file?.mimeType || '' });

// ---------------- the same for both ----------------
// Forget this sign-in, so the next one asks which account to use
export function forgetSignIn(p) {
  if (p === 'google') {
    gToken = null;
    gPrompt = 'select_account';
  } else mToken = null;
}
// Sign in (a click must start this) and say which account it is, for the school-account check
export async function signIn(settings, p) {
  if (p === 'google') {
    const t = await googleToken(settings.drive.google);
    return (await gfetch(t, 'about?fields=user(emailAddress)')).user?.emailAddress || '';
  }
  const t = await microsoftToken(settings.drive.microsoft);
  const me = await mfetch(t, '/me?$select=mail,userPrincipalName');
  return me.mail || me.userPrincipalName || '';
}
// Google's own chooser (Microsoft uses StudyBridge's small file browser, MsPicker)
export const pickGoogle = (settings) => googlePick(settings.drive.google);

// "Anyone with the link can view": nobody's email goes anywhere, and classmates never see each other in the file
export async function shareByLink(settings, link) {
  if (link.provider === 'google') {
    const t = await googleToken(settings.drive.google);
    try {
      await gfetch(t, `files/${link.id}/permissions?supportsAllDrives=true`, { method: 'POST', body: JSON.stringify({ type: 'anyone', role: 'reader' }) });
    } catch (e) {
      if (e.status === 403) throw new Error('Your Google account doesn’t allow sharing by link (schools often turn it off). Choose “A copy for each learner” instead.');
      throw e;
    }
    return (await gfetch(t, `files/${link.id}?fields=webViewLink&supportsAllDrives=true`)).webViewLink || link.url;
  }
  const t = await microsoftToken(settings.drive.microsoft);
  for (const scope of ['anonymous', 'organization']) {
    try {
      const r = await mfetch(t, `/me/drive/items/${link.id}/createLink`, { method: 'POST', body: JSON.stringify({ type: 'view', scope }) });
      if (r.link?.webUrl) return r.link.webUrl;
    } catch (e) {
      if (scope === 'organization') throw new Error(e.status === 403 ? 'Your Microsoft account doesn’t allow sharing by link. Choose “A copy for each learner” instead.' : e.message);
    }
  }
  return link.url;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A copy of the file for one learner, in the teacher's Drive, that only this learner (and the teacher) can open and change
export async function copyFor(settings, link, name, email) {
  if (link.provider === 'google') {
    const t = await googleToken(settings.drive.google);
    const c = await gfetch(t, `files/${link.id}/copy?supportsAllDrives=true&fields=id,name,webViewLink`, { method: 'POST', body: JSON.stringify({ name }) });
    let perm;
    try {
      perm = await gfetch(t, `files/${c.id}/permissions?sendNotificationEmail=false&supportsAllDrives=true&fields=id`, { method: 'POST', body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }) });
    } catch (e) {
      // an email that isn't a Google account needs Google's own invitation email
      if (e.status !== 400) throw shareProblem(e);
      try {
        perm = await gfetch(t, `files/${c.id}/permissions?sendNotificationEmail=true&supportsAllDrives=true&fields=id`, { method: 'POST', body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }) });
      } catch (e2) {
        throw shareProblem(e2);
      }
    }
    return { file_id: c.id, url: c.webViewLink, name: c.name, permission_id: perm.id };
  }
  const t = await microsoftToken(settings.drive.microsoft);
  const item = await mfetch(t, `/me/drive/items/${link.id}?$select=id,name,parentReference`);
  const parent = item.parentReference;
  const ext = /\.[a-z0-9]{1,6}$/i.exec(item.name)?.[0] || '';
  const base = name.endsWith(ext) ? name.slice(0, name.length - ext.length) : name;
  const at = (n) => `/drives/${parent.driveId}/items/${parent.id}:/${encodeURIComponent(n)}?$select=id,name,webUrl`;
  // a name nobody has used in that folder yet, so the copy found afterwards is surely the new one
  let full = base + ext;
  for (let i = 2; i < 30 && (await mfetch(t, at(full)).catch(() => null)); i++) full = `${base} (${i})${ext}`;
  await mfetch(t, `/me/drive/items/${link.id}/copy?@microsoft.graph.conflictBehavior=fail`, { method: 'POST', body: JSON.stringify({ name: full, parentReference: { driveId: parent.driveId, id: parent.id } }) });
  let copy = null;
  for (let i = 0; i < 40 && !copy; i++) {
    await sleep(i < 5 ? 600 : 1500);
    copy = await mfetch(t, at(full)).catch(() => null);
  }
  if (!copy) throw new Error('OneDrive is still making the copy. Try again in a minute.');
  let r;
  try {
    r = await mfetch(t, `/me/drive/items/${copy.id}/invite`, { method: 'POST', body: JSON.stringify({ recipients: [{ email }], roles: ['write'], requireSignIn: true, sendInvitation: false }) });
  } catch (e) {
    throw shareProblem(e);
  }
  return { file_id: copy.id, url: copy.webUrl, name: copy.name, permission_id: r.value?.[0]?.id || null };
}
function shareProblem(e) {
  if (e.status === 403) return new Error('Their school or account doesn’t accept files shared from outside it.');
  if (e.status === 400) return new Error('That email can’t be shared with.');
  return e;
}

// Handed in: they can comment (Google) or read (OneDrive) but not change it; or back to editing
export async function lockCopy(settings, copy, locked) {
  if (!copy.permission_id) throw new Error('This copy was shared another way. Change it in Google Drive or OneDrive.');
  if (copy.provider === 'google') {
    const t = await googleToken(settings.drive.google);
    await gfetch(t, `files/${copy.file_id}/permissions/${copy.permission_id}?supportsAllDrives=true`, { method: 'PATCH', body: JSON.stringify({ role: locked ? 'commenter' : 'writer' }) });
  } else {
    const t = await microsoftToken(settings.drive.microsoft);
    await mfetch(t, `/me/drive/items/${copy.file_id}/permissions/${copy.permission_id}`, { method: 'PATCH', body: JSON.stringify({ roles: [locked ? 'read' : 'write'] }) });
  }
}
// Someone left: take their access to their copy away (the copy stays in the teacher's Drive)
export async function removeAccess(settings, copy) {
  if (!copy.permission_id) return;
  try {
    if (copy.provider === 'google') {
      const t = await googleToken(settings.drive.google);
      await gfetch(t, `files/${copy.file_id}/permissions/${copy.permission_id}?supportsAllDrives=true`, { method: 'DELETE' });
    } else {
      const t = await microsoftToken(settings.drive.microsoft);
      await mfetch(t, `/me/drive/items/${copy.file_id}/permissions/${copy.permission_id}`, { method: 'DELETE' });
    }
  } catch (e) {
    if (e.status !== 404) throw e; // already gone
  }
}
