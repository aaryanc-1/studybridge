// Links on work, lesson notes, posts and answers: Google Drive, OneDrive or any web page.
// They open in the browser (the desktop app sends web links to the computer's browser).

// https only (the server takes nothing else)
export function safeUrl(s) {
  try {
    const u = new URL(String(s || '').trim());
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function providerOf(url) {
  let h = '';
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (h === 'docs.google.com' || h === 'drive.google.com') return 'google';
  if (h === 'onedrive.live.com' || h === '1drv.ms' || h.endsWith('.sharepoint.com') || h === 'onedrive.com') return 'microsoft';
  return null;
}

// "Google Doc", "OneDrive file" or the site's name
export function linkTitle(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'Link';
  }
  const p = u.pathname;
  if (u.hostname === 'docs.google.com') {
    if (p.startsWith('/document')) return 'Google Doc';
    if (p.startsWith('/spreadsheets')) return 'Google Sheet';
    if (p.startsWith('/presentation')) return 'Google Slides';
    if (p.startsWith('/forms')) return 'Google Form';
    return 'Google Drive file';
  }
  if (u.hostname === 'drive.google.com') return 'Google Drive file';
  if (providerOf(url) === 'microsoft') return 'OneDrive file';
  return u.hostname.replace(/^www\./, '');
}

export const linkIcon = (l) => (l?.provider || providerOf(l?.url) ? 'file' : 'link');
export const providerName = (p) => (p === 'google' ? 'Google Drive' : p === 'microsoft' ? 'OneDrive' : 'the web');
