'use strict';

/*
 * Server-rendered admin pages. Plain HTML strings — no template engine,
 * no build step. Everything user-supplied goes through esc() first.
 */

const fs = require('fs');
const path = require('path');

const ORG = process.env.ORG_NAME || 'TLS';
const SYSTEM = 'Staffer Attendance Monitoring System';
const TZ = process.env.TZ || 'Asia/Manila';
const hoursLimit = require('./lib/hours').MAX_SESSION_HOURS;
const { SECTIONS, STATUSES } = require('./lib/people');

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: TZ, dateStyle: 'medium', timeStyle: 'short',
  });
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit',
  });
}

// ---- Icons and the sync badge --------------------------------------------
// Line icons, drawn inline so the pages need nothing from the network (the Pi
// may have none). Each is the inside of a 24x24 stroke-only <svg>.
const CLOUD = '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>';
const ICONS = {
  synced: CLOUD + '<path d="m9 14 2 2 4-4"/>',
  pending: '<path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/>',
  offline: '<path d="m2 2 20 20"/><path d="M5.78 5.78A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.31-.19"/>' +
    '<path d="M21.53 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7 7 0 0 0 10 5.07"/>',
  error: CLOUD + '<path d="M12 10v3"/><path d="M12 16h.01"/>',
  off: CLOUD,
  click: '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/>' +
    '<path d="M9.04 9.69a.5.5 0 0 1 .65-.65l11 4.5a.5.5 0 0 1-.07.95l-4.35 1.04a1 1 0 0 0-.74.74l-1.04 4.35a.5.5 0 0 1-.95.07z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// The LaSallian's logo for the top left of every page: the star, then the
// name. Read once and drawn inline, like the icons.
const asset = (name) => fs.readFileSync(path.join(__dirname, 'assets', name), 'utf8').trim();
const LOGO = `<span class="logo" role="img" aria-label="The LaSallian">${
  asset('TLS_star_green.svg')}${asset('TLS_name_green.svg')}</span>`;

// Shared by the admin pages and the tap screen.
const BADGE_CSS = `
  svg.ic{width:1.15em;height:1.15em;fill:none;stroke:currentColor;stroke-width:2;
         stroke-linecap:round;stroke-linejoin:round;flex:none;vertical-align:-.2em}
  .sync{display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border-radius:999px;
        font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;
        background:#eef2f7;color:var(--muted)}
  button.sync{border:0;font-family:inherit;cursor:pointer}
  button.sync:hover{filter:brightness(.97)}
  .sync.synced{background:var(--in-bg);color:var(--in)}
  .sync.pending{background:#e8f0fe;color:var(--brand)}
  .sync.offline{background:var(--out-bg);color:var(--out)}
  .sync.error{background:#fce8e6;color:var(--danger)}`;

// ---- The navbar ------------------------------------------------------------
// The bar across the top of every page — the admin pages, Register, the sign-in
// page and the tap screen — so they can't drift apart:
//
//   links    [[href, label]]; `active` is the href of the page being shown
//   middle   HTML between the logo and the links (the tap screen's clock);
//            give it class="mid"
//   actions  the buttons on the right, as HTML: a button with class="act"
//            (add "danger" for one that needs care), or the sync badge
//   wide     the bar runs the width of the window, as the tap screen does,
//            instead of lining up with a page's 960px column
function navbar({ links = [], active = '', middle = '', actions = [], wide = false }) {
  const nav = links.map(([href, label]) => `<a href="${href}"${active === href ? ' class="on"' : ''}>${label}</a>`).join('');
  return `<header class="navbar${wide ? ' wide' : ''}"><div class="bar">
  <div class="brand">${LOGO}<small>${SYSTEM}</small></div>
  ${middle}
  ${nav ? `<nav>${nav}</nav>` : ''}
  ${actions.length ? `<div class="acts">${actions.join('\n  ')}</div>` : ''}
</div></header>`;
}

const NAVBAR_CSS = `
  .navbar{background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0}
  .bar{max-width:960px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:18px}
  /* The tap screen doesn't scroll, and its overlays must cover the bar. */
  .navbar.wide{position:static}
  .navbar.wide .bar{max-width:none;padding:14px 28px}
  /* Only the system's name gives way when the bar is tight: it takes two
     lines, and the links and buttons each stay on one. */
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;min-width:0}
  .brand small{color:var(--muted);font-weight:500;letter-spacing:0;line-height:1.3}
  .logo{display:inline-flex;align-items:center;gap:8px;flex:none}
  .logo svg{height:1.7em;width:auto;flex:none}
  .logo svg+svg{height:1.1em}
  .navbar nav{display:flex;gap:18px;margin-left:auto;flex:none;white-space:nowrap}
  .navbar nav a{color:var(--muted);text-decoration:none;font-weight:500}
  .navbar nav a.on,.navbar nav a:hover{color:var(--brand)}
  .navbar .mid{margin-left:auto;white-space:nowrap}
  .navbar .mid+nav{margin-left:0}
  .acts{display:flex;align-items:center;gap:12px;flex:none}
  .acts form{margin:0}
  .navbar .act{font:inherit;font-weight:600;padding:9px 16px;border:0;border-radius:8px;
               background:#eef2f7;color:var(--ink);cursor:pointer;white-space:nowrap}
  .navbar .act:hover{filter:brightness(.97)}
  .navbar .act.danger{color:var(--danger)}
  @media (max-width:900px){
    .brand small{display:none}
    .navbar.wide .bar{flex-wrap:wrap;gap:8px 16px}
    .navbar.wide .mid{order:4;width:100%;margin-left:0}
    .navbar.wide nav{margin-left:auto}
  }
  /* A phone: the bar stacks. */
  @media (max-width:640px){
    .bar,.navbar.wide .bar{flex-wrap:wrap;gap:8px 16px;padding:10px 14px}
    .acts{margin-left:auto}
    .navbar nav,.navbar.wide nav{order:3;width:100%;margin-left:0;flex-wrap:wrap}
    .navbar .mid{order:4;width:100%;margin-left:0}
  }`;

// The few words beside the cloud. `status` is lib/sync.js's status().
function syncBadge(status) {
  const n = status.pending;
  const label = {
    synced: 'Synced',
    pending: n ? `Syncing · ${n}` : 'Syncing',
    offline: n ? `Offline · ${n} saved` : 'Offline',
    error: 'Sync error',
  }[status.state];
  return { state: status.state, label };
}

// `local` is true when the page is being viewed on the office computer itself,
// which is the only place the tap screen can be opened — so only link it there.
//
// There, the admin pages also hand the screen back to the tap screen once
// nobody has touched them for a while. Cards are only read on the tap screen,
// so an admin page left open on the monitor would silently swallow every tap.
const IDLE_RETURN_MS = 2 * 60 * 1000;

function layout(title, body, active, local, sync) {
  const badge = sync ? syncBadge(sync) : null;
  // The register page is not an admin page: it links there, no more.
  const links = active === '/admin/login' ? [] : active === '/register'
    ? [['/register', 'Register'], ['/admin', 'Admin']]
    : [
      ['/admin', 'Dashboard'],
      ['/admin/users', 'People'],
      ['/admin/hours', 'Hours'],
    ];
  if (local) links.push(['/station', 'Tap screen']);
  const actions = [];
  if (active.startsWith('/admin') && active !== '/admin/login') {
    actions.push('<form method="post" action="/admin/logout"><button class="act" type="submit">Sign out</button></form>');
  }
  // data-sync-badge: the dashboard keeps it up to date (dashboardPage).
  if (badge) {
    actions.push(`<form method="post" action="/admin/sync">
    <input type="hidden" name="back" value="${active}">
    <button class="sync ${badge.state}" type="submit" title="Sync now" data-sync-badge>${icon(badge.state)}${esc(badge.label)}</button>
  </form>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/icon.png">
<title>${esc(title)} · ${esc(ORG)} ${SYSTEM}</title>
<style>
  :root{
    --ink:#12181f; --panel:#ffffff; --line:#e3e8ee; --muted:#647082;
    --brand:#1f6feb; --in:#137a4b; --in-bg:#e4f6ec; --out:#8a5a00; --out-bg:#fbf1dc;
    --danger:#b42318; --radius:10px;
  }
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
       color:var(--ink);background:#f5f7fa}
  main{max-width:960px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--muted);margin:0 0 24px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
         padding:20px;margin-bottom:22px;overflow-x:auto}
  .panel h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
            margin:0 0 14px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  tr:last-child td{border-bottom:0}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .pill.in{background:var(--in-bg);color:var(--in)}
  .pill.out{background:var(--out-bg);color:var(--out)}
  .pill.off{background:#eef2f7;color:var(--muted)}
  .empty{color:var(--muted);padding:8px 0}
  form.row{display:flex;flex-wrap:wrap;gap:12px;align-items:end}
  label{display:block;font-size:13px;color:var(--muted);margin-bottom:5px}
  input[type=text],input[type=password],input[type=date],select{padding:9px 11px;border:1px solid var(--line);
         border-radius:8px;font:inherit;background:#fff;min-width:160px}
  /* Safari draws its own dropdown, shorter than the boxes beside it, unless
     told not to — so the arrow is drawn here instead. */
  select{appearance:none;-webkit-appearance:none;padding-right:32px;color:var(--ink);
         background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23647082' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 11px center}
  input:disabled{background:#f5f7fa;color:var(--muted)}
  input:focus,select:focus{outline:2px solid var(--brand);outline-offset:1px;border-color:var(--brand)}
  .btn{padding:9px 16px;border:0;border-radius:8px;background:var(--brand);color:#fff;
       font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
  .btn:hover{filter:brightness(1.05)}
  .btn.ghost{background:#eef2f7;color:var(--ink)}
  .btn.danger{background:transparent;color:var(--danger);padding:6px 10px}
  .note{background:#fff8e6;border:1px solid #f0dfa8;border-radius:8px;padding:12px 14px;
        color:#6b5300;font-size:14px;margin-bottom:20px}
  .flash{border-radius:8px;padding:11px 14px;margin-bottom:20px;font-weight:500}
  .flash.ok{background:var(--in-bg);color:var(--in)}
  .flash.err{background:#fce8e6;color:var(--danger)}
  /* A save that worked is also announced where it can't be missed. */
  .toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:10;max-width:min(560px,calc(100vw - 28px));
         display:flex;align-items:flex-start;gap:12px;padding:13px 16px;border-radius:10px;font-weight:600;
         background:var(--in);color:#fff;box-shadow:0 8px 28px rgba(18,24,31,.22);transition:opacity .3s,transform .3s}
  .toast.gone{opacity:0;transform:translate(-50%,-12px)}
  .toast button{border:0;background:none;color:inherit;font:inherit;font-size:18px;line-height:1.2;cursor:pointer;padding:0 2px}
  .btn[disabled]{opacity:.65;cursor:progress}
  .scanbox{font-size:15px}
  .acts{display:flex;gap:6px;align-items:center;justify-content:flex-end}
  .wide{overflow-x:auto}
  .wide th,.wide td{white-space:nowrap}
  .tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px}
  .tabs a{padding:7px 14px;border-radius:8px;background:#eef2f7;color:var(--ink);
          text-decoration:none;font-weight:600;font-size:14px}
  .tabs a.on{background:var(--brand);color:#fff}
  .lost{color:var(--out);font-size:13px}
  .facts{display:flex;flex-wrap:wrap;gap:8px 28px;margin:14px 0 0;color:var(--muted)}
  .facts b{color:var(--ink);font-variant-numeric:tabular-nums}
  .why{margin:14px 0 0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
  .why.error{color:var(--danger)}
  .why.offline{margin:0 0 14px;color:var(--out)}${BADGE_CSS}${NAVBAR_CSS}
  .caphint{color:var(--out);font-size:12px;margin:12px 0 0}
  /* A phone: forms go one box to a line, and a table too wide for its panel
     scrolls inside it. (The navbar stacks by its own rules.) */
  @media (max-width:640px){
    main{padding:20px 14px 48px}
    .panel{padding:14px}
    th,td{padding:8px 10px}
    form.row>div{flex:1 1 100%}
    input[type=text],input[type=password],input[type=date],select{width:100%;min-width:0}
    form.row .btn{flex:1;text-align:center}
  }
</style>
</head>
<body>
${navbar({ links, active, actions })}
<main>${body}</main>
<script>
  // Returning through browser history must recheck the admin session.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && location.pathname.indexOf('/admin') === 0) location.reload();
  });
  var draftForm = document.querySelector('form.scanbox');
  var draftKey = draftForm ? 'residency-draft:' + draftForm.getAttribute('action') : null;
  var draftDirty = false;
  function saveDraft() {
    if (!draftForm || !draftDirty) return true;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(Object.fromEntries(new FormData(draftForm))));
      return true;
    } catch (e) { return false; }
  }
  try {
    if (new URLSearchParams(location.search).has('ok')) {
      var prefix = 'residency-draft:' + location.pathname;
      Object.keys(sessionStorage).forEach(function (key) {
        if (key === prefix || key.indexOf(prefix + '/') === 0) sessionStorage.removeItem(key);
      });
    }
    if (draftForm) {
      var savedDraft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (savedDraft) {
        // A form the server sent back after an error already holds the draft.
        var restored = false;
        Object.keys(savedDraft).forEach(function (name) {
          var field = draftForm.elements.namedItem(name);
          if (!field || field.disabled || field.value === savedDraft[name]) return;
          field.value = savedDraft[name];
          restored = true;
        });
        draftDirty = true;
        if (restored) {
          var note = document.createElement('p');
          note.className = 'note'; note.setAttribute('role', 'status');
          note.textContent = 'Your unsaved details were restored. Review them before saving. ';
          // On the shared computer they may be the last person's, not yours.
          var discard = document.createElement('button');
          discard.type = 'button'; discard.className = 'btn ghost'; discard.textContent = 'Discard them';
          discard.onclick = function () {
            sessionStorage.removeItem(draftKey);
            draftDirty = false;
            draftForm.reset();
            note.remove();
          };
          note.appendChild(discard);
          draftForm.before(note);
        }
      }
    }
  } catch (e) { /* The form remains usable if browser storage is unavailable. */ }
  // A save that worked: the page already says so, but a line of green at the
  // top is easy to miss after a second's wait — so it is also shown as a
  // notice that goes away by itself. The form is emptied, and the message
  // taken out of the address so that reloading doesn't say it again.
  var saved = document.querySelector('.flash.ok');
  if (saved) {
    if (draftForm) draftForm.reset();
    var toast = document.createElement('div');
    toast.className = 'toast gone'; toast.setAttribute('role', 'status');
    var said = document.createElement('span');
    said.textContent = '\u2713 ' + saved.textContent;
    var close = document.createElement('button');
    close.type = 'button'; close.setAttribute('aria-label', 'Dismiss'); close.textContent = '\u00d7';
    var dismiss = function () {
      toast.classList.add('gone');
      setTimeout(function () { toast.remove(); }, 300);
    };
    close.onclick = dismiss;
    toast.appendChild(said); toast.appendChild(close);
    document.body.appendChild(toast);
    setTimeout(function () { toast.classList.remove('gone'); }, 30);
    setTimeout(dismiss, 8000);
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* the message just stays in the address */ }
  }
  // Saving waits on Google for a second or two. Say so, and don't take a
  // second press for a second person.
  Array.prototype.forEach.call(document.querySelectorAll('form.scanbox'), function (form) {
    var button = form.querySelector('button[type=submit]');
    if (!button) return;
    var label = button.textContent;
    form.addEventListener('submit', function () {
      // After this event, or the browser would not send the form at all.
      setTimeout(function () { button.disabled = true; button.textContent = 'Saving\u2026'; }, 0);
    });
    // Coming back through browser history shows the page as it was left.
    window.addEventListener('pageshow', function () { button.disabled = false; button.textContent = label; });
  });
  if (draftForm) {
    ['input', 'change', 'submit'].forEach(function (type) {
      draftForm.addEventListener(type, function () { draftDirty = true; saveDraft(); });
    });
    // Cancel means it: the next Edit starts from what is saved, not from this.
    Array.prototype.forEach.call(draftForm.querySelectorAll('[data-discard-draft]'), function (link) {
      link.addEventListener('click', function () {
        draftDirty = false;
        try { sessionStorage.removeItem(draftKey); } catch (e) { /* nothing was kept */ }
      });
    });
  }
</script>
${local ? `<script>
  (function () {
    var timer;
    function reset() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (saveDraft()) location.href = '/station';
      }, ${IDLE_RETURN_MS});
    }
    ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (type) {
      window.addEventListener(type, reset, { passive: true });
    });
    reset();
  })();
</script>` : ''}
</body>
</html>`;
}

// ---- Pages ---------------------------------------------------------------

function loginPage({ local, error = '' }) {
  return layout('Admin sign in', `
    <h1>Admin sign in</h1>
    <p class="sub">Manage staffers and review residency hours. Sign out when you are finished.</p>
    ${error ? `<p class="flash err" role="alert">${esc(error)}</p>` : ''}
    <div class="panel"><form method="post" action="/admin/login" class="row">
      <div><label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" required autofocus></div>
      <div><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn" type="submit">Sign in</button>
    </form></div>
    <p class="caphint">${local ? 'Returning to the tap screen locks admin access again. ' : ''}Admin sessions expire after 30 minutes without use.</p>`,
  '/admin/login', local, null);
}

// The sheet sync, spelled out: the one place that says what is uploaded, what
// is waiting, and why.
function syncPanel(sync) {
  if (!sync) {
    return `<div class="panel"><h2>Google Sheet</h2>
      <span class="sync">${icon('off')}Not set up</span></div>`;
  }
  const badge = syncBadge(sync);
  const hint = {
    synced: '',
    pending: '',
    offline: 'No internet. Taps upload when it is back.',
    error: sync.error ? sync.error.message : '',
  }[sync.state];
  return `<div class="panel"><h2>Google Sheet</h2>
      <span class="sync ${badge.state}">${icon(badge.state)}${esc(badge.label)}</span>
      <div class="facts">
        <span><b>${sync.uploaded}</b> uploaded</span>
        <span><b>${sync.pending}</b> waiting</span>
        <span>last synced <b>${fmtDateTime(sync.lastSyncedAt)}</b></span>
      </div>
      ${hint ? `<p class="why ${sync.state}">${esc(hint)}</p>` : ''}
    </div>`;
}

// The parts of the dashboard that change while it is open: who is in, the
// sheet panel, and the cloud in the navbar. The page is built from them, and
// the server sends them again over /admin/events whenever something changes
// (a tap, a sync), so an open dashboard keeps itself up to date.
function dashboardLive({ currentlyIn, sync }) {
  const badge = sync ? syncBadge(sync) : null;
  return {
    count: currentlyIn.length,
    rows: currentlyIn.length
      ? currentlyIn.map((u) => `
        <tr>
          <td>${esc(u.name)}</td>
          <td class="mono">${esc(u.student_id || '')}</td>
          <td>since ${fmtTime(u.since)}</td>
          <td><span class="pill in">in</span></td>
        </tr>`).join('')
      : `<tr><td colspan="4" class="empty">Nobody is checked in right now.</td></tr>`,
    panel: syncPanel(sync),
    badge: badge ? { state: badge.state, html: icon(badge.state) + esc(badge.label) } : null,
  };
}

function dashboardPage({ currentlyIn, sync, local }) {
  const live = dashboardLive({ currentlyIn, sync });
  const body = `
    <h1>Dashboard</h1>
    <p class="sub">Who is in the office right now. This page updates by itself.</p>
    <p class="flash err" id="live-lost" role="status" hidden></p>
    <div class="panel">
      <h2>Currently in (<span id="in-count">${live.count}</span>)</h2>
      <table>
        <thead><tr><th>Name</th><th>Student ID</th><th>Checked in</th><th>Status</th></tr></thead>
        <tbody id="in-rows">${live.rows}</tbody>
      </table>
    </div>
    <div id="sync-panel">${live.panel}</div>
    <script>
      (function () {
        var lost = document.getElementById('live-lost');
        if (!window.EventSource) {
          lost.textContent = 'This browser can\u2019t update the page by itself. Reload it to see new taps.';
          lost.hidden = false;
          return;
        }
        var stream = new EventSource('/admin/events');
        stream.addEventListener('dashboard', function (e) {
          var now = JSON.parse(e.data);
          document.getElementById('in-count').textContent = now.count;
          document.getElementById('in-rows').innerHTML = now.rows;
          document.getElementById('sync-panel').innerHTML = now.panel;
          var badge = document.querySelector('[data-sync-badge]');
          if (badge && now.badge) {
            badge.className = 'sync ' + now.badge.state;
            badge.innerHTML = now.badge.html;
          }
          lost.hidden = true;
        });
        // The browser reconnects by itself after a dropped connection. It gives
        // up only when the answer isn't the stream at all: the session ended.
        stream.onerror = function () {
          lost.textContent = stream.readyState === 2
            ? 'This page stopped updating \u2014 your session may have ended. Reload it.'
            : 'Not updating \u2014 reconnecting\u2026';
          lost.hidden = false;
        };
      })();
    </script>`;
  return layout('Dashboard', body, '/admin', local, sync);
}

// A dropdown that starts on nothing, so a choice has to be made.
function choice(name, values, chosen) {
  return `<select name="${name}" id="${name}" required>
            <option value="">Choose ${esc(name)}</option>${values.map((v) => `
            <option${v === chosen ? ' selected' : ''}>${esc(v)}</option>`).join('')}
          </select>`;
}

// The boxes for a person's details, shared by the register page and the edit
// form on the People page.
function personFields(p) {
  return `<div><label for="person-name">Name</label>
          <input type="text" name="name" id="person-name" required autocomplete="off" value="${esc(p.name)}"></div>
        <div><label for="student_id">ID number</label>
          <input type="text" name="student_id" id="student_id" required autocomplete="off" value="${esc(p.student_id)}"></div>
        <div><label for="section">Section</label>
          ${choice('section', SECTIONS, p.section)}</div>
        <div><label for="status">Status</label>
          ${choice('status', STATUSES, p.status)}</div>
        <div><label for="telegram">Telegram (optional)</label>
          <input type="text" name="telegram" id="telegram" autocomplete="off"
                 placeholder="@handle" value="${esc(p.telegram)}"></div>`;
}

// Goes with personFields, inside a page's <script>.
const TELEGRAM_JS = `
      // The @ goes on by itself.
      var telegram = document.getElementById('telegram');
      if (telegram) telegram.addEventListener('input', function () {
        var handle = telegram.value.replace(/^[@\\s]+/, '');
        telegram.value = handle ? '@' + handle : '';
      });`;

// Registering someone: its own page, opened from the tap screen. Only on the
// office computer, where the reader is — so no admin password, and a tap goes
// straight into the Card number box.
//
// `draft`: this is a form that was just refused. It stays on the page with
// what was typed even when the reason is that the sheet can't be reached —
// they can press Add person again once it can.
function registerPage({ flash, unknownScans = [], prefill = null, online = true, draft = false }) {
  const flashHtml = flash
    ? `<div class="flash ${flash.type}"${flash.type === 'err' ? ' role="alert"' : ''}>${esc(flash.text)}</div>` : '';
  const p = prefill || {};

  // Cards tapped on the tap screen before anyone opened this page — click one
  // to fill it in.
  const unknownHtml = unknownScans.length
    ? `<div class="panel">
      <h2>Unrecognized taps (${unknownScans.length})</h2>
      <table>
        <thead><tr><th>Card number</th><th>Seen at</th><th></th></tr></thead>
        <tbody>${unknownScans.map((u) => `
          <tr>
            <td class="mono">${esc(u.rfid)}</td>
            <td>${fmtDateTime(u.ts)}</td>
            <td><button type="button" class="btn ghost use-rfid"
                        data-rfid="${esc(u.rfid)}">Use this ID</button></td>
          </tr>`).join('')}</tbody>
      </table>
      <p class="caphint">
        Cleared when the server restarts.
      </p>
    </div>`
    : '';

  const body = `
    <h1>Register</h1>
    <p class="sub">Register once, then return to the tap screen to check in. All fields are required.</p>
    ${flashHtml}
    ${flash && flash.type === 'ok' ? '<p><a class="btn" href="/station">Back to the tap screen</a></p>' : ''}
    ${online || draft ? `<div class="panel">
      <h2>Register someone</h2>
      ${online ? '' : `<p class="why offline">${icon('offline')} Offline — nothing is saved until the internet is back. Then press Add person again.</p>`}
      <form method="post" action="/register" class="row scanbox">
        ${personFields(p)}
        <div><label for="rfid">Card number — tap their ID now</label>
          <input type="text" name="rfid" id="rfid" required autocomplete="off"
                 placeholder="tap ID, or type the number" value="${esc(p.rfid)}"></div>
        <button class="btn" type="submit">Add person</button>
      </form>
      <p class="caphint">
        The ID number identifies the staffer. The card number comes from the reader: click its box, then tap the card.
        Unsaved details are kept in this tab if the tap screen resumes after two minutes.
      </p>
    </div>
    ${unknownHtml}` : `<div class="panel">
      <h2>Register someone</h2>
      <span class="sync offline">${icon('offline')}Offline</span>
      <p class="why">People are added in the Google Sheet, so that waits for the internet. Taps still work.</p>
    </div>`}
    <script>
      // Put the cursor in the RFID box so a tap during registration lands there.
      var rfid = document.getElementById('rfid');
      if (rfid) rfid.focus();
${TELEGRAM_JS}

      // Copy an unrecognized card number into the form instead of retyping it.
      Array.prototype.forEach.call(document.querySelectorAll('.use-rfid'), function (btn) {
        btn.addEventListener('click', function () {
          rfid.value = btn.getAttribute('data-rfid');
          document.getElementsByName('name')[0].focus();
        });
      });
    </script>`;
  return layout('Register', body, '/register', true, null);
}

function usersPage({
  users, flash, editing = null,
  roster = { warnings: [], unlinked: [] }, online = true, draft = false, sync, local,
}) {
  const flashHtml = flash
    ? `<div class="flash ${flash.type}"${flash.type === 'err' ? ' role="alert"' : ''}>${esc(flash.text)}</div>` : '';

  // Deactivated people keep their history and their card number; they are
  // listed apart so the roster is the people whose cards currently work.
  const personRow = (u, action, label, cls) => `
        <tr>
          <td>${esc(u.name)}</td>
          <td class="mono">${esc(u.student_id || '')}</td>
          <td>${esc(u.section || '')}</td>
          <td>${esc(u.status || '')}</td>
          <td>${esc(u.telegram || '')}</td>
          <td class="mono">${esc(u.rfid)}</td>
          <td>${online ? `<div class="acts">
            <a class="btn ghost" href="/admin/users?edit=${u.id}">Edit</a>
            <form method="post" action="/admin/users/${u.id}/${action}"
                  class="${action}-person" data-name="${esc(u.name)}">
              <button class="btn ${cls}" type="submit">${label}</button>
            </form>
          </div>` : ''}</td>
        </tr>`;
  const columns = `<tr><th>Name</th><th>ID number</th><th>Section</th><th>Status</th><th>Telegram</th>
          <th>Card number</th><th></th></tr>`;
  const current = users.filter((u) => u.active);
  const inactive = users.filter((u) => !u.active);

  const rows = current.length
    ? current.map((u) => personRow(u, 'deactivate', 'Deactivate', 'danger')).join('')
    : `<tr><td colspan="7" class="empty">No one registered yet. Register people on the office computer.</td></tr>`;

  const inactiveHtml = inactive.length
    ? `<div class="panel wide">
      <h2>Deactivated (${inactive.length})</h2>
      <table>
        <thead>${columns}</thead>
        <tbody>${inactive.map((u) => personRow(u, 'reactivate', 'Reactivate', 'ghost')).join('')}</tbody>
      </table>
      <p class="caphint">
        Their IDs don&#39;t record taps. Their hours stay in the report.
      </p>
    </div>`
    : '';

  // Registering happens at the reader, so only link the register page there.
  const canRegister = local && online;

  // What the last look at the Staffers tab couldn't use, and the rows in it
  // still waiting for a card — see lib/roster.js.
  const rosterHtml = (roster.warnings.length ? `<div class="panel">
      <h2>${icon('alert')} Staffers sheet (${roster.warnings.length})</h2>
      ${roster.warnings.map((w) => `<div class="lost">${esc(w)}</div>`).join('')}
    </div>` : '') + (roster.unlinked.length ? `<div class="panel wide">
      <h2>In the sheet, no card number yet (${roster.unlinked.length})</h2>
      <table>
        <thead><tr><th>Row</th><th>Name</th><th>ID number</th><th>Section</th><th>Status</th><th></th></tr></thead>
        <tbody>${roster.unlinked.map((r) => `
          <tr>
            <td>${r.n}</td>
            <td>${esc(r.row[0])}</td>
            <td class="mono">${esc(r.row[1])}</td>
            <td>${esc(r.row[2])}</td>
            <td>${esc(r.row[3])}</td>
            <td>${canRegister
    ? `<a class="btn ghost" href="/register?from=${encodeURIComponent(r.row[1])}">Register</a>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : '');

  const body = `
    <h1>People</h1>
    <p class="sub">Manage the roster.</p>
    ${flashHtml}
    ${online ? '' : `<div class="panel">
      <h2>Changes</h2>
      <span class="sync offline">${icon('offline')}Offline</span>
      <p class="why">People are changed in the Google Sheet, so that waits for the internet. Taps still work.</p>
    </div>`}
    ${editing && (online || draft) ? `<div class="panel">
      <h2>Edit ${esc(editing.name)}</h2>
      ${online ? '' : '<p class="why offline">Nothing is saved until the internet is back. Then press Save again.</p>'}
      <form method="post" action="/admin/users/${editing.id}" class="row scanbox">
        ${personFields(editing)}
        <div><label for="card">Card number</label>
          <input type="text" class="mono" id="card" value="${esc(editing.rfid)}" disabled></div>
        <button class="btn" type="submit">Save</button>
        <a class="btn ghost" href="/admin/users" data-discard-draft>Cancel</a>
      </form>
    </div>` : ''}
    ${canRegister ? '<p><a class="btn" href="/register">Register someone</a></p>' : ''}
    ${rosterHtml}
    <div class="panel wide">
      <h2>Roster (${current.length})</h2>
      <table>
        <thead>${columns}</thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${inactiveHtml}
    <script>${TELEGRAM_JS}

      // Confirm deactivations. The name travels in a data attribute rather than an
      // inline onsubmit: esc() renders an apostrophe as &#39;, the HTML parser
      // hands that back to JS as a real quote, and a name like O'Brien would
      // then break the handler — silently deactivating with no confirmation.
      Array.prototype.forEach.call(document.querySelectorAll('.deactivate-person'), function (form) {
        form.addEventListener('submit', function (e) {
          var name = form.getAttribute('data-name');
          if (!confirm('Deactivate ' + name + '? Their ID stops working. Their hours history is kept.')) e.preventDefault();
        });
      });
    </script>`;
  return layout('People', body, '/admin/users', local, sync);
}

function hoursPage({ report, tabs = [], start, end, error, sync, local }) {
  const rows = report.length
    ? report.map((r) => `
        <tr>
          <td>${esc(r.name)}${r.uncounted.map((s) => `
            <div class="lost" title="Counts as zero hours">${icon('ban')} ${s.outAt
    ? `${fmtDateTime(s.inAt)} · over ${hoursLimit} h`
    : `${fmtDateTime(s.inAt)} · no tap out`}</div>`).join('')}</td>
          <td class="mono">${esc(r.student_id || '')}</td>
          <td class="mono">${r.hours.toFixed(2)}</td>
          <td>${r.sessions}</td>
          <td>
            ${r.open ? '<span class="pill in">still in</span>' : ''}
            ${r.uncounted.length ? `<span class="pill out">${r.uncounted.length} not counted</span>` : ''}
            ${r.active ? '' : '<span class="pill off">deactivated</span>'}
          </td>
        </tr>`).join('')
    : `<tr><td colspan="5" class="empty">No hours in this range yet.</td></tr>`;

  // A bad date range is the admin's typo, not a fact about residency — say so
  // above the table, and be explicit that the numbers below ignore it.
  const errorHtml = error
    ? `<div class="flash err" role="alert">${esc(error)} Showing every date instead.</div>` : '';

  const q = `start=${encodeURIComponent(start || '')}&end=${encodeURIComponent(end || '')}`;
  const body = `
    <h1>Residency hours</h1>
    <p class="sub">Total time each person has logged.</p>
    <div class="tabs">${tabs.map((t) => `<a href="/admin/hours?start=${t.start}&amp;end=${t.end}"${
    t.start === (start || '') && t.end === (end || '') ? ' class="on"' : ''}>${esc(t.label)}</a>`).join('')}</div>
    ${errorHtml}
    <div class="panel">
      <form method="get" action="/admin/hours" class="row">
        <div><label for="start">From</label><input type="date" name="start" id="start" value="${esc(start || '')}"></div>
        <div><label for="end">To</label><input type="date" name="end" id="end" value="${esc(end || '')}"></div>
        <button class="btn" type="submit">Apply</button>
        <a class="btn ghost" href="/admin/hours.csv?${q}">Download CSV</a>
      </form>
    </div>
    <div class="panel">
      <h2>Totals</h2>
      <table>
        <thead><tr><th>Name</th><th>Student ID</th><th>Hours</th><th>Sessions</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  return layout('Hours', body, '/admin/hours', local, sync);
}

// ---- Tap screen ----------------------------------------------------------
/*
 * Full-screen page for the monitor at the reader — and the reader's input.
 *
 * The reader is a USB keyboard: a tap "types" the card number and presses
 * Enter into whatever has focus, which in kiosk mode is this page. We catch
 * those keystrokes before anything else on the page sees them, post the
 * number to /station/tap and show the answer. Who's in the office is pushed
 * to us over /station/events.
 *
 * Catching them first matters: Enter on a focused button clicks it, and a
 * tap while the Shut down dialog is open must not press "Shut down anyway".
 *
 * `readerOnly`: a keyboard is attached to the Pi, and anyone could type a
 * colleague's card number on it. A reader types a whole number in a few tens
 * of milliseconds; a person can't. So on the Pi we only accept digits that
 * arrive at reader speed. Off the Pi (developing without a reader), typing is
 * allowed.
 *
 * Also where the day ends. Shut down lists who is still checked in first,
 * because anyone still in when the machine goes off loses that session.
 */
function stationPage({ readerOnly = true } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/icon.png">
<title>Tap screen · ${esc(ORG)} ${SYSTEM}</title>
<style>
  :root{
    --ink:#12181f; --panel:#ffffff; --line:#e3e8ee; --muted:#647082; --bg:#f5f7fa;
    --brand:#1f6feb; --in:#137a4b; --in-bg:#e4f6ec; --out:#8a5a00; --out-bg:#fbf1dc;
    --danger:#b42318; --danger-bg:#fce8e6; --radius:14px;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;font:18px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
       color:var(--ink);background:var(--bg);display:flex;flex-direction:column;cursor:default}
  #now{font-variant-numeric:tabular-nums;color:var(--muted)}
  .wrap{flex:1;display:grid;grid-template-columns:1fr 340px;gap:24px;padding:24px 28px;min-height:0}
  .main{display:flex;align-items:center;justify-content:center;border-radius:var(--radius);
        background:var(--panel);border:1px solid var(--line);text-align:center;padding:40px}
  .main.in{background:var(--in-bg);border-color:#bfe5cf;color:var(--in)}
  .main.out{background:var(--out-bg);border-color:#efdcae;color:var(--out)}
  .main.bad{background:var(--danger-bg);border-color:#f3c5bf;color:var(--danger)}
  .big{font-size:88px;font-weight:800;letter-spacing:.02em;line-height:1}
  .name{font-size:44px;font-weight:700;margin-top:18px;color:var(--ink)}
  .detail{font-size:22px;margin-top:14px;color:var(--ink);opacity:.8}
  .extra{font-size:18px;margin-top:18px;color:var(--out)}
  .idle .big{font-size:56px;color:var(--ink)}
  .main.bad .big{font-size:64px}
  .side{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
        padding:20px;overflow:auto}
  .side h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px}
  ul.people{list-style:none;margin:0;padding:0}
  ul.people li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;
               border-bottom:1px solid var(--line)}
  ul.people li:last-child{border-bottom:0}
  ul.people .since{color:var(--muted);font-variant-numeric:tabular-nums}
  .empty{color:var(--muted)}
  /* Taps can't be read: nothing else on the screen matters until it's clicked. */
  #unfocused{position:fixed;inset:0;z-index:5;display:none;flex-direction:column;align-items:center;
             justify-content:center;gap:20px;background:rgba(18,24,31,.9);color:#fff;
             font-weight:700;font-size:36px;cursor:pointer}
  #unfocused svg{width:110px;height:110px;stroke-width:1.5}
  /* Lost the server: a toast, top centre. */
  #offline{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:4;display:none;
           align-items:center;gap:10px;background:var(--danger);color:#fff;padding:10px 20px;
           border-radius:999px;font-weight:600;box-shadow:0 8px 24px rgba(18,24,31,.22)}
  .spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;
        border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  #sync{display:none;font-size:15px;padding:7px 14px;border:0}
  .glyph svg{width:120px;height:120px;stroke-width:1.5;color:var(--muted)}${BADGE_CSS}${NAVBAR_CSS}
  #shut{position:fixed;inset:0;background:rgba(18,24,31,.55);display:none;align-items:center;justify-content:center}
  #shut.open{display:flex}
  .dialog{background:#fff;border-radius:var(--radius);padding:30px;width:min(560px,92vw);max-height:90vh;overflow:auto}
  .dialog h2{margin:0 0 10px;font-size:26px}
  .dialog p{margin:0 0 16px;color:var(--muted)}
  .dialog ul.people{margin-bottom:18px}
  .actions{display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap}
  .actions button{font:inherit;font-weight:600;border-radius:10px;padding:12px 20px;border:0;cursor:pointer}
  .cancel{background:#eef2f7;color:var(--ink)}
  .confirm{background:var(--danger);color:#fff}
  .warn{color:var(--danger)!important;font-weight:600}
  @media (max-width:1100px){ .brand small{display:none} }
  @media (max-width:900px){
    .wrap{grid-template-columns:1fr;padding:16px}
    #now{font-size:16px}
    .big{font-size:56px} .name{font-size:32px} .main.bad .big{font-size:44px}
  }
  @media (max-width:560px){
    .main{padding:28px 16px}
  }
</style>
</head>
<body>
<div id="unfocused">${icon('click')}Click to resume</div>
<div id="offline" role="status"><span class="spin"></span>Reconnecting…</div>
${navbar({
    wide: true,
    middle: '<div id="now" class="mid"></div>',
    links: [['/register', 'Register'], ['/admin', 'Admin']],
    actions: [
      '<button type="button" id="sync" class="sync" title="Sync now"></button>',
      '<button type="button" id="shut-open" class="act danger">Shut down</button>',
    ],
  })}
<div class="wrap">
  <div class="main idle" id="main" role="status" aria-live="polite" aria-atomic="true"></div>
  <div class="side">
    <h2 id="in-title">In the office</h2>
    <ul class="people" id="in-list"></ul>
  </div>
</div>
<div id="shut" role="dialog" aria-modal="true" aria-labelledby="shut-title">
  <div class="dialog" id="shut-body"></div>
</div>
<script>
(function () {
  var TZ = ${JSON.stringify(TZ)};
  var ICONS = ${JSON.stringify(ICONS)};
  var READER_ONLY = ${readerOnly ? 'true' : 'false'};
  // Longest gap between two keystrokes of one tap. Readers manage well under
  // this; nobody types that fast by hand.
  var MAX_KEY_GAP_MS = 100;
  var SHOW_MS = 6000; // longer than the repeat-tap window, so a nervous second tap
                      // (which the server ignores) still sees its answer on screen
  var status = { clockReady: false, currentlyIn: [] };
  var connected = false;
  var shown = null, hideTimer = null, shuttingDown = false;
  var pending = {}, sending = {};
  try { pending = JSON.parse(sessionStorage.getItem('residency-pending-taps') || '{}'); } catch (e) {}
  function savePending() {
    try { sessionStorage.setItem('residency-pending-taps', JSON.stringify(pending)); } catch (e) {}
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function time(iso) {
    return new Date(iso).toLocaleTimeString('en-PH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  }

  function tick() {
    document.getElementById('now').textContent = new Date().toLocaleString('en-PH', {
      timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  function renderMain() {
    var main = document.getElementById('main');
    main.textContent = '';
    var box = el('div');
    if (shown) {
      var t = shown;
      if (t.replayed) {
        main.className = 'main ' + t.direction;
        box.appendChild(el('div', 'big', 'Tap confirmed'));
        box.appendChild(el('div', 'name', t.name));
        box.appendChild(el('div', 'detail', 'Your earlier ' + t.direction.toUpperCase() + ' was recorded at ' +
          new Date(t.time).toLocaleString('en-PH', { timeZone: TZ }) + '. No second tap was recorded.'));
        box.appendChild(el('div', 'extra', 'Tap again only for a new arrival or departure.'));
      } else if (t.status === 'ok' && t.direction === 'in') {
        main.className = 'main in';
        box.appendChild(el('div', 'big', 'IN'));
        box.appendChild(el('div', 'name', t.name));
        box.appendChild(el('div', 'detail', 'Checked in at ' + time(t.time) + '. Welcome!'));
        if (t.stale) box.appendChild(el('div', 'extra',
          'Your last check-in was never tapped out, so that session didn’t count.'));
      } else if (t.status === 'ok') {
        main.className = 'main out';
        box.appendChild(el('div', 'big', 'OUT'));
        box.appendChild(el('div', 'name', t.name));
        box.appendChild(el('div', 'detail', 'Checked out at ' + time(t.time) + '. See you!'));
      } else if (t.status === 'unknown') {
        main.className = 'main bad';
        box.appendChild(el('div', 'big', 'Not registered'));
        box.appendChild(el('div', 'detail', 'Card number ' + t.rfid + ' isn’t registered. Click Register to add it.'));
      } else if (t.status === 'inactive') {
        main.className = 'main bad';
        box.appendChild(el('div', 'big', 'ID deactivated'));
        box.appendChild(el('div', 'detail', 'Nothing was recorded. Ask an admin to reactivate it.'));
      } else if (t.status === 'clock') {
        main.className = 'main bad';
        box.appendChild(el('div', 'big', 'Not recorded'));
        box.appendChild(el('div', 'detail', 'The clock isn’t set yet. Wait a moment, then tap again.'));
      } else if (t.status === 'ignored') {
        main.className = 'main idle';
        box.appendChild(el('div', 'big', 'Repeat ignored'));
        box.appendChild(el('div', 'detail', 'This ID was just read. No new tap was recorded. Wait five seconds if you need to tap again.'));
      } else {
        main.className = 'main bad';
        box.appendChild(el('div', 'big', 'Not confirmed yet'));
        box.appendChild(el('div', 'detail', 'Your tap may already be saved. Tap the same ID again to safely confirm it.'));
      }
    } else if (!connected) {
      main.className = 'main idle';
      box.appendChild(el('div', 'big', 'Connecting…'));
      box.appendChild(el('div', 'detail', 'Wait for “Tap your ID” before tapping.'));
    } else if (!status.clockReady) {
      main.className = 'main idle';
      var glyph = el('div', 'glyph');
      glyph.innerHTML = svg('clock');
      box.appendChild(glyph);
      box.appendChild(el('div', 'big', 'Setting the clock…'));
      box.appendChild(el('div', 'detail', 'Needs wifi. Taps start in a moment.'));
    } else {
      main.className = 'main idle';
      box.appendChild(el('div', 'big', 'Tap your ID'));
      box.appendChild(el('div', 'detail', 'Once when you arrive, once when you leave.'));
      if (Object.keys(pending).length) box.appendChild(el('div', 'extra', 'An earlier tap still needs confirmation. Tap that same ID again.'));
    }
    main.appendChild(box);
  }

  function peopleList(ul) {
    ul = ul || el('ul', 'people');
    ul.textContent = '';
    status.currentlyIn.forEach(function (p) {
      var li = el('li');
      li.appendChild(el('span', null, p.name));
      li.appendChild(el('span', 'since', 'since ' + time(p.since)));
      ul.appendChild(li);
    });
    return ul;
  }

  function renderSide() {
    var n = status.currentlyIn.length;
    document.getElementById('in-title').textContent = connected ? 'In the office (' + n + ')' : 'Attendance unavailable';
    var list = peopleList(document.getElementById('in-list'));
    if (!connected) { list.textContent = ''; list.appendChild(el('li', 'empty', 'Waiting for the office computer.')); }
    else if (!n) list.appendChild(el('li', 'empty', 'Nobody is checked in.'));
  }

  function svg(name) {
    return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  // The sheet sync, as a small cloud in the header. Offline, taps still work:
  // they are saved here and go up when the connection is back, so this
  // informs rather than alarms.
  function renderSync() {
    var badge = document.getElementById('sync');
    var s = status.sync;
    badge.style.display = s ? 'inline-flex' : 'none';
    if (!s) return;
    showSync(s.state, s.label);
  }
  function showSync(state, label) {
    var badge = document.getElementById('sync');
    badge.className = 'sync ' + state;
    badge.innerHTML = svg(state);
    badge.appendChild(document.createTextNode(label));
  }
  // Clicking the cloud syncs now. The result arrives like any other change,
  // over /station/events.
  document.getElementById('sync').onclick = function () {
    showSync('pending', 'Syncing');
    fetch('/station/sync', { method: 'POST', headers: { 'X-Station': '1' } }).catch(function () {});
  };

  // ---- Shut down: show who's still in, then confirm ----
  var shut = document.getElementById('shut');
  var shutBody = document.getElementById('shut-body');

  function renderShut(message) {
    if (!shut.classList.contains('open')) return;
    shutBody.textContent = '';
    if (shuttingDown) {
      shutBody.appendChild(el('h2', null, 'Shutting down…'));
      shutBody.appendChild(el('p', null,
        'Wait until the screen goes blank and the green light on the Pi stops flashing, then unplug it.'));
      return;
    }
    if (!connected) {
      var waiting = el('h2', null, 'Checking attendance…');
      waiting.id = 'shut-title';
      shutBody.appendChild(waiting);
      shutBody.appendChild(el('p', null, 'Wait for the connection before shutting down. Attendance may have changed.'));
      var back = el('button', 'cancel', 'Cancel');
      back.type = 'button'; back.onclick = closeShut;
      shutBody.appendChild(back); back.focus();
      return;
    }
    var n = status.currentlyIn.length;
    var title = el('h2', null, n ? n + (n === 1 ? ' person is' : ' people are') +
      ' still checked in' : 'Everyone has tapped out');
    title.id = 'shut-title';
    shutBody.appendChild(title);
    if (n) {
      shutBody.appendChild(el('p', 'warn',
        'If you shut down now, their time since checking in won’t count. Ask them to tap out first.'));
      shutBody.appendChild(peopleList());
    } else {
      shutBody.appendChild(el('p', null, 'Shut down the office computer for the day?'));
    }
    if (message) shutBody.appendChild(el('p', 'warn', message));
    var actions = el('div', 'actions');
    var cancel = el('button', 'cancel', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = closeShut;
    var confirm = el('button', 'confirm', n ? 'Shut down anyway' : 'Shut down');
    confirm.type = 'button';
    confirm.onclick = doShutdown;
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    shutBody.appendChild(actions);
    cancel.focus(); // never leave the destructive button focused
  }

  function openShut() { shut.classList.add('open'); renderShut(); }
  function closeShut() {
    if (!shuttingDown) { shut.classList.remove('open'); document.getElementById('shut-open').focus(); }
  }

  function doShutdown() {
    shuttingDown = true;
    renderShut();
    fetch('/station/shutdown', { method: 'POST', headers: { 'X-Station': '1' } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; }); })
      .then(function (x) {
        if (!x.r.ok) throw new Error(x.b.error || 'the server refused');
      })
      .catch(function (err) {
        shuttingDown = false;
        renderShut('Couldn’t shut down: ' + err.message);
      });
  }

  document.getElementById('shut-open').onclick = openShut;

  // ---- The reader ----
  function show(tap) {
    // An ignored repeat changes nothing, and the screen is still showing the
    // answer to the tap it repeats.
    if (tap.status === 'ignored' && shown) return;
    shown = tap;
    clearTimeout(hideTimer);
    if (tap.status !== 'error') hideTimer = setTimeout(function () { shown = null; renderMain(); }, SHOW_MS);
    renderMain();
  }

  function sendTap(rfid) {
    if (shuttingDown || sending[rfid]) return;
    if (!pending[rfid]) pending[rfid] = crypto.randomUUID();
    savePending();
    sending[rfid] = true;
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 10000);
    fetch('/station/tap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Station': '1' },
      body: JSON.stringify({ rfid: rfid, requestId: pending[rfid] }),
      signal: controller.signal,
    })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (tap) { delete pending[rfid]; savePending(); show(tap); })
      .catch(function () { show({ status: 'error' }); })
      .finally(function () { clearTimeout(timeout); delete sending[rfid]; });
  }

  var digits = '', lastKey = 0, scanStarted = false, overflow = false;
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    var now = performance.now();
    var gap = now - lastKey;
    lastKey = now;

    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (READER_ONLY && gap > MAX_KEY_GAP_MS) { digits = ''; overflow = false; }
      scanStarted = true;
      if (overflow) return;
      digits += e.key;
      if (digits.length > 64) { digits = ''; overflow = true; }
    } else if (e.key === 'Enter') {
      // With no digits before it this is not the reader: it is somebody
      // pressing Enter on a link or button, and theirs to press.
      if (!scanStarted) return;
      e.preventDefault(); e.stopPropagation();
      var card = digits;
      digits = ''; scanStarted = false; overflow = false;
      if (card && (!READER_ONLY || gap <= MAX_KEY_GAP_MS)) sendTap(card);
    } else if (e.key === 'Escape') {
      digits = ''; scanStarted = false; overflow = false;
      closeShut();
    } else {
      digits = ''; scanStarted = false; overflow = false;
      if (e.key === 'Tab' && shut.classList.contains('open')) {
        var buttons = shut.querySelectorAll('button');
        if (!buttons.length) { e.preventDefault(); return; }
        if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons[buttons.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === buttons[buttons.length - 1]) { e.preventDefault(); buttons[0].focus(); }
      }
    }
  }, true); // capture: before any focused button or link can act on a tap's Enter

  // Keystrokes only reach this page while it has focus. If something takes
  // it — a stray click outside the browser, a system dialog — say so loudly.
  var unfocused = document.getElementById('unfocused');
  function checkFocus() { unfocused.style.display = document.hasFocus() ? 'none' : 'flex'; }
  window.addEventListener('focus', checkFocus);
  window.addEventListener('blur', checkFocus);
  setInterval(checkFocus, 2000);

  // ---- Live updates from the server ----
  var es = new EventSource('/station/events');
  es.onerror = function () {
    connected = false;
    if (!shuttingDown) document.getElementById('offline').style.display = 'flex';
    renderMain(); renderSide(); renderShut();
  };
  es.addEventListener('status', function (e) {
    status = JSON.parse(e.data);
    connected = true;
    document.getElementById('offline').style.display = 'none';
    renderMain(); renderSide(); renderShut(); renderSync();
  });

  tick(); setInterval(tick, 1000);
  renderMain(); renderSide(); checkFocus();
})();
</script>
</body>
</html>`;
}

module.exports = { loginPage, dashboardPage, dashboardLive, registerPage, usersPage, hoursPage, stationPage, syncBadge };
