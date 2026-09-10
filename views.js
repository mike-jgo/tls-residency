'use strict';

/*
 * Server-rendered admin pages. Plain HTML strings — no template engine,
 * no build step. Everything user-supplied goes through esc() first.
 */

const ORG = process.env.ORG_NAME || 'TLS';
const TZ = process.env.TZ || 'Asia/Manila';
const hoursLimit = require('./lib/hours').MAX_SESSION_HOURS;

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

function layout(title, body, active) {
  const nav = [
    ['/admin', 'Dashboard'],
    ['/admin/users', 'People'],
    ['/admin/hours', 'Hours'],
  ].map(([href, label]) => {
    const cls = active === href ? ' class="on"' : '';
    return `<a href="${href}"${cls}>${label}</a>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(ORG)} attendance</title>
<style>
  :root{
    --ink:#12181f; --panel:#ffffff; --line:#e3e8ee; --muted:#647082;
    --brand:#1f6feb; --in:#137a4b; --in-bg:#e4f6ec; --out:#8a5a00; --out-bg:#fbf1dc;
    --danger:#b42318; --radius:10px;
  }
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
       color:var(--ink);background:#f5f7fa}
  header{background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0}
  .bar{max-width:960px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:22px}
  .brand{font-weight:700;letter-spacing:.02em}
  .brand small{color:var(--muted);font-weight:500;letter-spacing:0}
  nav{display:flex;gap:18px;margin-left:auto;flex-wrap:wrap}
  nav a{color:var(--muted);text-decoration:none;font-weight:500}
  nav a.on,nav a:hover{color:var(--brand)}
  main{max-width:960px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--muted);margin:0 0 24px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
         padding:20px;margin-bottom:22px}
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
  .empty{color:var(--muted);padding:8px 0}
  form.row{display:flex;flex-wrap:wrap;gap:12px;align-items:end}
  label{display:block;font-size:13px;color:var(--muted);margin-bottom:5px}
  input[type=text],input[type=date]{padding:9px 11px;border:1px solid var(--line);
         border-radius:8px;font:inherit;background:#fff;min-width:160px}
  input:focus{outline:2px solid var(--brand);outline-offset:1px;border-color:var(--brand)}
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
  .scanbox{font-size:15px}
  .caphint{color:var(--out);font-size:12px;margin:12px 0 0}
</style>
</head>
<body>
<header><div class="bar">
  <div class="brand">${esc(ORG)} <small>attendance</small></div>
  <nav>${nav}</nav>
</div></header>
<main>${body}</main>
</body>
</html>`;
}

// ---- Pages ---------------------------------------------------------------

function dashboardPage({ currentlyIn }) {
  const rows = currentlyIn.length
    ? currentlyIn.map((u) => `
        <tr>
          <td>${esc(u.name)}</td>
          <td class="mono">${esc(u.student_id || '')}</td>
          <td>since ${fmtTime(u.since)}</td>
          <td><span class="pill in">in</span></td>
        </tr>`).join('')
    : `<tr><td colspan="4" class="empty">Nobody is checked in right now.</td></tr>`;

  const body = `
    <h1>Dashboard</h1>
    <p class="sub">Who's in the office right now.</p>
    <div class="panel">
      <h2>Currently in (${currentlyIn.length})</h2>
      <table>
        <thead><tr><th>Name</th><th>Student ID</th><th>Checked in</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  return layout('Dashboard', body, '/admin');
}

function usersPage({ users, flash, unknownScans = [] }) {
  const flashHtml = flash
    ? `<div class="flash ${flash.type}">${esc(flash.text)}</div>` : '';

  // The reader is at the office machine, not at whatever browser the admin is
  // using, so a new card can't be tapped straight into the form above. These
  // are the cards the reader saw and didn't recognize — click one to fill it in.
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
                        data-rfid="${esc(u.rfid)}">Use this card</button></td>
          </tr>`).join('')}</tbody>
      </table>
      <p class="caphint">
        Cleared when the server restarts — these are a registration shortcut, not a record.
      </p>
    </div>`
    : '';

  const rows = users.length
    ? users.map((u) => `
        <tr>
          <td>${esc(u.name)}</td>
          <td class="mono">${esc(u.student_id || '')}</td>
          <td>${esc(u.role || '')}</td>
          <td class="mono">${esc(u.rfid)}</td>
          <td>
            <form method="post" action="/admin/users/${u.id}/delete"
                  class="remove-person" data-name="${esc(u.name)}">
              <button class="btn danger" type="submit">Remove</button>
            </form>
          </td>
        </tr>`).join('')
    : `<tr><td colspan="5" class="empty">No one registered yet. Add your first person above.</td></tr>`;

  const body = `
    <h1>People</h1>
    <p class="sub">Register staffers and manage the roster.</p>
    ${flashHtml}
    <div class="panel">
      <h2>Register someone</h2>
      <form method="post" action="/admin/users" class="row scanbox">
        <div><label>Name</label>
          <input type="text" name="name" required autocomplete="off"></div>
        <div><label>Student ID</label>
          <input type="text" name="student_id" autocomplete="off"></div>
        <div><label>Role (optional)</label>
          <input type="text" name="role" autocomplete="off"></div>
        <div><label>RFID number — tap their card now</label>
          <input type="text" name="rfid" id="rfid" required autocomplete="off"
                 placeholder="tap card, or type the number"></div>
        <button class="btn" type="submit">Add person</button>
      </form>
      <p class="caphint">
        If the reader is plugged into this computer, click the RFID box and have them tap once.
        Otherwise have them tap at the reader, then pick the card from the list below.
      </p>
    </div>
    ${unknownHtml}
    <div class="panel">
      <h2>Roster (${users.length})</h2>
      <table>
        <thead><tr><th>Name</th><th>Student ID</th><th>Role</th><th>RFID</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <script>
      // Put the cursor in the RFID box so a tap during registration lands there.
      var rfid = document.getElementById('rfid');
      if (rfid) rfid.focus();

      // Copy an unrecognized card number into the form instead of retyping it.
      Array.prototype.forEach.call(document.querySelectorAll('.use-rfid'), function (btn) {
        btn.addEventListener('click', function () {
          if (!rfid) return;
          rfid.value = btn.getAttribute('data-rfid');
          document.getElementsByName('name')[0].focus();
        });
      });

      // Confirm removals. The name travels in a data attribute rather than an
      // inline onsubmit: esc() renders an apostrophe as &#39;, the HTML parser
      // hands that back to JS as a real quote, and a name like O'Brien would
      // then break the handler — silently deleting with no confirmation.
      Array.prototype.forEach.call(document.querySelectorAll('.remove-person'), function (form) {
        form.addEventListener('submit', function (e) {
          var name = form.getAttribute('data-name');
          if (!confirm('Remove ' + name + '? Their scan history goes too.')) e.preventDefault();
        });
      });
    </script>`;
  return layout('People', body, '/admin/users');
}

function hoursPage({ report, start, end, invalid, error }) {
  const rows = report.length
    ? report.map((r) => `
        <tr>
          <td>${esc(r.name)}</td>
          <td class="mono">${esc(r.student_id || '')}</td>
          <td class="mono">${r.hours.toFixed(2)}</td>
          <td>${r.sessions}</td>
          <td>
            ${r.open ? '<span class="pill in">still in</span>' : ''}
            ${r.invalid ? '<span class="pill out">a session wasn&#39;t counted</span>' : ''}
          </td>
        </tr>`).join('')
    : `<tr><td colspan="5" class="empty">No hours in this range yet.</td></tr>`;

  // A bad date range is the admin's typo, not a fact about attendance — say so
  // above the table, and be explicit that the numbers below ignore it.
  const errorHtml = error
    ? `<div class="flash err">${esc(error)} Showing every date instead.</div>` : '';

  const invalidNote = invalid
    ? `<div class="note">Some sessions weren't counted. A session only counts if
       it is closed by a tap out within ${hoursLimit} hours — someone who taps in
       and never taps out loses that session. The names are flagged below.</div>` : '';

  const q = `start=${encodeURIComponent(start || '')}&end=${encodeURIComponent(end || '')}`;
  const body = `
    <h1>Residency hours</h1>
    <p class="sub">Total time each person has logged.</p>
    ${errorHtml}
    ${invalidNote}
    <div class="panel">
      <form method="get" action="/admin/hours" class="row">
        <div><label>From</label><input type="date" name="start" value="${esc(start || '')}"></div>
        <div><label>To</label><input type="date" name="end" value="${esc(end || '')}"></div>
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
  return layout('Hours', body, '/admin/hours');
}

module.exports = { dashboardPage, usersPage, hoursPage };
