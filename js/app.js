let CURRENT_USER = null;
let SETTINGS = {};
let PENDING_DEVICE_STU = null;
let FAC_DATA = { assigned_pairs: [], active_sessions: [], roster: [], dash_roster: [], live_session: null, perms: {} };
let ADM_DATA = { users: [], classes: [], subjects: [], slots: [], device_requests: [], logs: [] };
let ADMIN_OVERVIEW_SEQ = 0;
let QR_TIMER = null;
let CLOCK_TIMER = null;
let LIVE_POLL_TIMER = null;
let HTML5_SCANNER = null;

const ADMIN_PERM_KEYS = [
  'manage_users', 'manage_academics', 'manage_timetable',
  'assign_proxy', 'approve_devices', 'manage_geofence',
  'manage_settings', 'view_reports', 'manage_admins'
];

const FAC_PERM_KEYS = [
  'can_start_regular', 'can_start_extra', 'can_mark_od',
  'can_edit_attendance', 'can_toggle_gps', 'can_export_reports'
];

function initTheme() {
  const saved = localStorage.getItem('sqr_theme');
  const isDark = saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = isDark ? '☀️ Light' : '🌙 Dark';
}

function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('sqr_theme', isDark ? 'dark' : 'light');
  document.getElementById('btn-theme').textContent = isDark ? '☀️ Light' : '🌙 Dark';
}

function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `fixed bottom-5 right-5 z-50 max-w-sm px-4 py-3 rounded-xl shadow-xl text-sm font-semibold text-white ${isErr ? 'bg-rose-600' : 'bg-slate-900 dark:bg-indigo-600'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function api(action, body = {}) {
  try {
    const res = await fetch(`/api/gateway?action=${encodeURIComponent(action)}&_t=${Date.now()}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && data.ok === undefined) {
      return { ok: false, error: data.error || `Request failed (${res.status})` };
    }
    return data;
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}

function getDeviceFingerprint() {
  let fp = localStorage.getItem('sqr_device_fp');
  if (!fp) {
    fp = 'DEV-' + Math.random().toString(36).slice(2, 10).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
    localStorage.setItem('sqr_device_fp', fp);
  }
  return fp;
}

function togglePassVis(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.textContent = 'HIDE';
  } else {
    inp.type = 'password';
    btn.textContent = 'SHOW';
  }
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function openChangePassModal() {
  ['cp-old', 'cp-new1', 'cp-new2'].forEach(id => {
    const el = document.getElementById(id);
    el.value = '';
    el.type = 'password';
  });
  document.getElementById('modal-change-pass').classList.remove('hidden');
}

async function submitChangePassword() {
  const current_password = document.getElementById('cp-old').value;
  const p1 = document.getElementById('cp-new1').value;
  const p2 = document.getElementById('cp-new2').value;
  if (p1 !== p2) return toast('New passwords do not match. Re-enter both carefully.', true);
  const r = await api('change_password', { current_password, new_password: p1 });
  if (!r.ok) return toast(r.error, true);
  closeModal('modal-change-pass');
  toast('Password updated successfully!');
}

async function initApp() {
  initTheme();
  const sRes = await api('get_settings');
  if (sRes.ok) {
    SETTINGS = sRes.settings || {};
    document.getElementById('brand-title').textContent = SETTINGS.app_title || 'SmartQR Attendance';
    document.getElementById('brand-college').textContent = SETTINGS.college_name || 'University Portal v7.1';
    if (SETTINGS.logo_url) document.getElementById('brand-logo').src = SETTINGS.logo_url;
  }

  const me = await api('whoami');
  if (me.ok && me.user) {
    await routeUser(me.user);
  } else {
    showView('view-login');
  }
}

function showView(viewId) {
  ['view-login', 'view-student', 'view-faculty', 'view-admin'].forEach(v => {
    document.getElementById(v).classList.toggle('hidden', v !== viewId);
  });
  document.getElementById('nav-user-bar').classList.toggle('hidden', viewId === 'view-login');
}

async function routeUser(user) {
  CURRENT_USER = user;
  document.getElementById('nav-user-name').textContent = user.full_name;
  document.getElementById('nav-user-role').textContent = user.is_super_admin ? 'SUPER ADMIN' : user.role.toUpperCase();

  if (user.role === 'student') {
    showView('view-student');
    document.getElementById('stu-name').textContent = user.full_name;
    document.getElementById('stu-meta').textContent = `Enrollment: ${user.enrollment_no || '-'} • Roll: ${user.roll_no || '-'} • Class: ${user.classes?.name || '-'}`;
    await loadStudentDashboard();
  } else if (user.role === 'faculty') {
    showView('view-faculty');
    await initFacultyPortal();
  } else if (user.role === 'admin') {
    showView('view-admin');
    await initAdminPortal();
  }
}

async function handleLogin(e) {
  e.preventDefault();
  document.getElementById('device-req-box').classList.add('hidden');
  const identifier = document.getElementById('login-id').value;
  const password = document.getElementById('login-pass').value;
  const res = await api('login', { identifier, password, device_fp: getDeviceFingerprint() });

  if (!res.ok) {
    if (res.error === 'DEVICE_MISMATCH') {
      PENDING_DEVICE_STU = res;
      document.getElementById('device-req-msg').textContent = `${res.student_name} (${res.enrollment_no || res.roll_no}): ${res.message}`;
      document.getElementById('device-req-box').classList.remove('hidden');
      return;
    }
    return toast(res.error || 'Login failed', true);
  }
  await routeUser(res.user);
}

async function submitDeviceRequest() {
  if (!PENDING_DEVICE_STU) return;
  const reason = document.getElementById('device-req-reason').value;
  const r = await api('request_device_change', {
    student_id: PENDING_DEVICE_STU.student_id,
    new_device_fp: getDeviceFingerprint(),
    reason
  });
  if (!r.ok) return toast(r.error, true);
  toast(r.message);
  document.getElementById('device-req-box').classList.add('hidden');
}

async function logoutUser() {
  clearInterval(QR_TIMER);
  clearInterval(CLOCK_TIMER);
  clearInterval(LIVE_POLL_TIMER);
  stopStudentScanner();
  await api('logout');
  CURRENT_USER = null;
  showView('view-login');
}

async function loadStudentDashboard() {
  const res = await api('student_dashboard');
  if (!res.ok) return;
  const box = document.getElementById('stu-subject-list');
  if (!res.summary.length) {
    box.innerHTML = '<p class="text-slate-400">No lectures recorded yet.</p>';
    return;
  }
  box.innerHTML = res.summary.map(s => {
    const pct = s.total ? Math.round((s.attended / s.total) * 100) : 100;
    const ok = pct >= 75;
    return `
      <div class="p-3 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between">
        <div>
          <p class="font-bold">${s.subject_name} <span class="text-slate-400">(${s.subject_code})</span></p>
          <p class="text-[11px] text-slate-500">Attended ${s.attended} of ${s.total} lectures</p>
        </div>
        <span class="px-2.5 py-1 rounded-lg font-extrabold ${ok ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300' : 'bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300'}">${pct}%</span>
      </div>`;
  }).join('');
}

function stopStudentScanner() {
  if (HTML5_SCANNER) {
    HTML5_SCANNER.stop().then(() => HTML5_SCANNER.clear()).catch(() => {});
    HTML5_SCANNER = null;
  }
}

function startStudentScanner() {
  stopStudentScanner();
  const statusEl = document.getElementById('scan-status');
  statusEl.textContent = 'Starting camera...';

  HTML5_SCANNER = new Html5Qrcode('qr-reader');
  HTML5_SCANNER.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 220, height: 220 }, videoConstraints: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } } },
    async (decodedText) => {
      stopStudentScanner();
      statusEl.textContent = 'QR captured! Verifying attendance & location...';
      let payload;
      try { payload = JSON.parse(decodedText); } catch {
        statusEl.textContent = 'Invalid QR code format.';
        return toast('Invalid QR code', true);
      }

      const sendScan = async (lat = null, lng = null) => {
        const res = await api('submit_qr', {
          session_id: payload.s,
          nonce: payload.n,
          device_fp: getDeviceFingerprint(),
          lat,
          lng
        });
        if (!res.ok) {
          statusEl.textContent = res.message || res.error;
          return toast(res.message || res.error, true);
        }
        statusEl.textContent = 'Attendance Marked Present (P) ✓';
        toast('Attendance marked Present (P)!');
        loadStudentDashboard();
      };

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          pos => sendScan(pos.coords.latitude, pos.coords.longitude),
          () => sendScan(null, null),
          { enableHighAccuracy: true, timeout: 5000, maximumAge: 10000 }
        );
      } else {
        sendScan(null, null);
      }
    }
  ).catch(err => {
    statusEl.textContent = 'Camera error: ' + err;
  });
}

async function initFacultyPortal() {
  const res = await api('faculty_init');
  if (!res.ok) return toast(res.error, true);
  FAC_DATA.assigned_pairs = res.assigned_pairs || [];
  FAC_DATA.active_sessions = res.active_sessions || [];
  FAC_DATA.perms = res.faculty_permissions || {};

  document.getElementById('btn-reg-lecture').classList.toggle('hidden', FAC_DATA.perms.can_start_regular === false);
  document.getElementById('btn-extra-lecture').classList.toggle('hidden', !res.settings?.allow_extra_lectures || FAC_DATA.perms.can_start_extra === false);
  document.getElementById('fac-export-bar').classList.toggle('hidden', FAC_DATA.perms.can_export_reports === false);
  document.getElementById('fac-geo-wrap').classList.toggle('hidden', FAC_DATA.perms.can_toggle_gps === false);

  const sel = document.getElementById('fac-class-select');
  if (!FAC_DATA.assigned_pairs.length) {
    sel.innerHTML = '<option value="">No classes assigned yet (Ask Admin)</option>';
    return;
  }
  sel.innerHTML = FAC_DATA.assigned_pairs.map((p, idx) =>
    `<option value="${idx}">${p.class_name} (${p.class_code}) — ${p.subject_name}</option>`
  ).join('');

  onFacultyClassChange();

  if (FAC_DATA.active_sessions.length > 0) {
    openLiveFacultySession(FAC_DATA.active_sessions[0].id);
  }
}

async function onFacultyClassChange() {
  const idx = document.getElementById('fac-class-select').value;
  const pair = FAC_DATA.assigned_pairs[idx];
  if (!pair) return;

  document.getElementById('fac-dash-title').textContent = `${pair.class_name} — ${pair.subject_name} Dashboard`;
  const res = await api('faculty_class_dashboard', { class_id: pair.class_id, subject_id: pair.subject_id });
  if (!res.ok) return toast(res.error, true);

  FAC_DATA.dash_roster = res.roster || [];
  document.getElementById('fac-stat-lectures').textContent = res.total_lectures;
  document.getElementById('fac-stat-avg').textContent = `${res.average_pct}%`;

  const tbody = document.getElementById('fac-dash-tbody');
  tbody.innerHTML = FAC_DATA.dash_roster.map(r => {
    const low = r.percentage < 75;
    return `
      <tr class="${low ? 'bg-rose-50/50 dark:bg-rose-950/20' : ''}">
        <td class="p-3 font-bold">${r.roll_no || '-'} <span class="text-slate-400 font-normal">(${r.enrollment_no || '-'})</span></td>
        <td class="p-3 font-semibold">${r.full_name}</td>
        <td class="p-3 text-center text-emerald-600 font-bold">${r.p_count}</td>
        <td class="p-3 text-center text-amber-600 font-bold">${r.od_count}</td>
        <td class="p-3 text-center font-bold">${r.attended} / ${r.total_lectures}</td>
        <td class="p-3 text-right font-extrabold ${low ? 'text-rose-600' : 'text-emerald-600'}">${r.percentage}%</td>
      </tr>`;
  }).join('');
}

async function startFacultyLecture(sessionType) {
  const idx = document.getElementById('fac-class-select').value;
  const pair = FAC_DATA.assigned_pairs[idx];
  if (!pair) return toast('Select a class and subject first.', true);

  const res = await api('start_session', {
    class_id: pair.class_id,
    subject_id: pair.subject_id,
    session_type: sessionType
  });
  if (!res.ok) return toast(res.error, true);
  toast(`${sessionType} Lecture started!`);
  openLiveFacultySession(res.session.id);
}

async function openLiveFacultySession(sessionId) {
  clearInterval(QR_TIMER);
  clearInterval(CLOCK_TIMER);
  clearInterval(LIVE_POLL_TIMER);

  const res = await api('session_roster', { session_id: sessionId });
  if (!res.ok) return toast(res.error, true);

  const s = res.session;
  FAC_DATA.live_session = s;
  FAC_DATA.roster = res.roster || [];

  document.getElementById('fac-live-panel').classList.remove('hidden');
  document.getElementById('live-session-type').textContent = s.session_type || 'REGULAR';
  document.getElementById('live-class-subject').textContent = `${s.classes?.name || 'Class'} • ${s.subjects?.name || 'Subject'}`;
  document.getElementById('qr-watermark-top').textContent = `${s.classes?.code || ''} • ${s.subjects?.code || ''}`;
  document.getElementById('fac-geo-switch').checked = s.geofence_override !== false && (s.geofence_override === true || Boolean(SETTINGS.geofence_enabled));

  renderQrCode(s.id, s.current_nonce);
  renderLiveRoster();

  CLOCK_TIMER = setInterval(() => {
    document.getElementById('qr-watermark-time').textContent = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
  }, 1000);

  const intervalMs = (SETTINGS.qr_interval_seconds || 15) * 1000;
  QR_TIMER = setInterval(async () => {
    const r = await api('rotate_nonce', { session_id: s.id });
    if (r.ok) renderQrCode(s.id, r.nonce);
  }, intervalMs);

  LIVE_POLL_TIMER = setInterval(async () => {
    const poll = await api('session_roster', { session_id: s.id });
    if (poll.ok) {
      FAC_DATA.roster = poll.roster || [];
      renderLiveRoster();
    }
  }, 5000);
}

function renderQrCode(sessionId, nonce) {
  const box = document.getElementById('fac-qr-box');
  box.innerHTML = '';
  new QRCode(box, {
    text: JSON.stringify({ s: sessionId, n: nonce }),
    width: 200,
    height: 200
  });
}

function renderLiveRoster() {
  const q = (document.getElementById('roster-search').value || '').toLowerCase();
  const list = FAC_DATA.roster.filter(st =>
    (st.roll_no || '').toLowerCase().includes(q) ||
    (st.enrollment_no || '').toLowerCase().includes(q) ||
    (st.full_name || '').toLowerCase().includes(q)
  );

  let p = 0, od = 0, a = 0;
  FAC_DATA.roster.forEach(st => {
    if (st.status === 'P') p++;
    else if (st.status === 'OD') od++;
    else a++;
  });
  document.getElementById('cnt-p').textContent = p;
  document.getElementById('cnt-od').textContent = od;
  document.getElementById('cnt-a').textContent = a;

  const canEdit = FAC_DATA.perms.can_edit_attendance !== false;
  const canOD = canEdit && FAC_DATA.perms.can_mark_od !== false;

  const tbody = document.getElementById('live-roster-tbody');
  tbody.innerHTML = list.map(st => {
    const isP = st.status === 'P';
    const isOD = st.status === 'OD';
    const badge = isP
      ? '<span class="px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 font-bold">P</span>'
      : isOD
        ? '<span class="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 font-bold">OD</span>'
        : '<span class="px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 font-bold">A</span>';

    return `
      <tr>
        <td class="p-3 font-bold">${st.roll_no || '-'} <span class="text-slate-400 font-normal">(${st.enrollment_no || '-'})</span></td>
        <td class="p-3 font-semibold">${st.full_name}</td>
        <td class="p-3 text-center">
          <input type="checkbox" class="tick-p" ${isP ? 'checked' : ''} ${!canEdit ? 'disabled' : ''} onchange="onStudentTick('${st.id}', 'P', this.checked)">
        </td>
        <td class="p-3 text-center">
          <input type="checkbox" class="tick-od" ${isOD ? 'checked' : ''} ${!canOD ? 'disabled' : ''} onchange="onStudentTick('${st.id}', 'OD', this.checked)">
        </td>
        <td class="p-3 text-center">${badge}</td>
      </tr>`;
  }).join('');
}

async function onStudentTick(studentId, targetStatus, checked) {
  if (!FAC_DATA.live_session) return;
  const newStatus = checked ? targetStatus : 'A';
  const st = FAC_DATA.roster.find(x => x.id === studentId);
  if (st) st.status = newStatus;
  renderLiveRoster();

  const res = await api('set_student_tick', {
    session_id: FAC_DATA.live_session.id,
    student_id: studentId,
    status: newStatus
  });
  if (!res.ok) toast(res.error, true);
}

async function toggleFacultySessionGeo() {
  if (!FAC_DATA.live_session) return;
  const enabled = document.getElementById('fac-geo-switch').checked;
  const res = await api('toggle_session_geo', {
    session_id: FAC_DATA.live_session.id,
    geofence_override: enabled
  });
  if (!res.ok) return toast(res.error, true);
  toast(`GPS Geofencing turned ${enabled ? 'ON' : 'OFF'} for this lecture.`);
}

async function closeFacultySession() {
  if (!FAC_DATA.live_session) return;
  await api('close_session', { session_id: FAC_DATA.live_session.id });
  clearInterval(QR_TIMER);
  clearInterval(CLOCK_TIMER);
  clearInterval(LIVE_POLL_TIMER);
  FAC_DATA.live_session = null;
  document.getElementById('fac-live-panel').classList.add('hidden');
  toast('Lecture ended and attendance locked!');
  onFacultyClassChange();
}

function exportFacultyClassCsv() {
  if (!FAC_DATA.dash_roster.length) return toast('No data to export.', true);
  const rows = [['Enrollment No', 'Roll No', 'Student Name', 'Present (P)', 'On-Duty (OD)', 'Total Lectures', 'Percentage']];
  FAC_DATA.dash_roster.forEach(r => rows.push([r.enrollment_no, r.roll_no, r.full_name, r.p_count, r.od_count, r.total_lectures, r.percentage + '%']));
  downloadCsv('class_attendance_report.csv', rows);
}

async function emailFacultyClassReport() {
  if (!FAC_DATA.dash_roster.length) return toast('No data to email.', true);
  const title = document.getElementById('fac-dash-title').textContent;
  const lines = FAC_DATA.dash_roster.map(r => `${r.enrollment_no || r.roll_no} | ${r.full_name}: ${r.attended}/${r.total_lectures} (${r.percentage}%)`);
  const res = await api('email_attendance_self', {
    subject: `Attendance Summary: ${title}`,
    text: `${title}

${lines.join('
')}`
  });
  if (!res.ok) return toast(res.error, true);
  toast('Report emailed to your inbox!');
}

function switchAdminTab(tab) {
  document.querySelectorAll('#view-admin .nav-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  ['overview', 'users', 'academics', 'geofence', 'devices', 'logs', 'settings'].forEach(t => {
    document.getElementById(`admin-tab-${t}`).classList.toggle('hidden', t !== tab);
  });
}

async function initAdminPortal() {
  const seq = ++ADMIN_OVERVIEW_SEQ;
  const res = await api('admin_overview');
  if (seq !== ADMIN_OVERVIEW_SEQ) return;
  if (!res.ok) return toast(res.error || 'Failed to load admin data', true);

  ADM_DATA = {
    ...ADM_DATA,
    ...res,
    users: Array.isArray(res.users) ? res.users : [],
    classes: Array.isArray(res.classes) ? res.classes : [],
    subjects: Array.isArray(res.subjects) ? res.subjects : [],
    slots: Array.isArray(res.slots) ? res.slots : [],
    device_requests: Array.isArray(res.device_requests) ? res.device_requests : [],
    logs: Array.isArray(res.logs) ? res.logs : []
  };

  const students = ADM_DATA.users.filter(u => u.role === 'student');
  const faculty = ADM_DATA.users.filter(u => u.role === 'faculty');

  document.getElementById('adm-kpi-stu').textContent = students.length;
  document.getElementById('adm-kpi-fac').textContent = faculty.length;
  document.getElementById('adm-kpi-cls').textContent = ADM_DATA.classes.length;
  document.getElementById('adm-kpi-dev').textContent = ADM_DATA.device_requests.length;
  document.getElementById('badge-dev-req').textContent = ADM_DATA.device_requests.length;

  const clsOpts = `<option value="">-- No Class --</option>` + ADM_DATA.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  const subOpts = ADM_DATA.subjects.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
  const facOpts = faculty.map(f => `<option value="${f.id}">${f.full_name}</option>`).join('');

  ['proxy-class', 'new-u-class', 'tt-class', 'eu-class'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = clsOpts;
  });
  ['proxy-subject', 'tt-subject'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = subOpts;
  });
  ['proxy-faculty', 'tt-faculty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = facOpts;
  });

  document.getElementById('set-app-title').value = SETTINGS.app_title || '';
  document.getElementById('set-college-name').value = SETTINGS.college_name || '';
  document.getElementById('set-logo-url').value = SETTINGS.logo_url || 'assets/logo.png';
  document.getElementById('set-extra-lec').checked = Boolean(SETTINGS.allow_extra_lectures);
  document.getElementById('set-smtp-email').value = SETTINGS.smtp_email || '';
  document.getElementById('set-smtp-pass').value = '';

  const smtpBadge = document.getElementById('smtp-badge');
  smtpBadge.textContent = SETTINGS.smtp_configured ? 'Active' : 'Not Configured';
  smtpBadge.className = SETTINGS.smtp_configured
    ? 'px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
    : 'px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';

  document.getElementById('geo-def-enabled').checked = Boolean(SETTINGS.geofence_enabled);
  document.getElementById('geo-def-lat').value = SETTINGS.campus_lat || '';
  document.getElementById('geo-def-lng').value = SETTINGS.campus_lng || '';
  document.getElementById('geo-def-rad').value = SETTINGS.geofence_radius_meters || 150;

  renderAdminUsers();
  renderAcademics();
  renderClassGeoList();
  renderDeviceRequests();
  renderAuditLogs();
}

function renderAdminUsers() {
  const q = (document.getElementById('adm-user-search').value || '').trim().toLowerCase();
  const roleFilter = document.getElementById('adm-user-filter').value;
  const tbody = document.getElementById('admin-users-tbody');

  const filtered = (ADM_DATA.users || []).filter(u => {
    if (roleFilter !== 'ALL' && u.role !== roleFilter) return false;
    if (!q) return true;
    return (
      (u.full_name || '').toLowerCase().includes(q) ||
      (u.enrollment_no || '').toLowerCase().includes(q) ||
      (u.roll_no || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    );
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">No matching users found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(u => {
    const ids = [
      u.enrollment_no ? `Enroll: <b>${u.enrollment_no}</b>` : '',
      u.roll_no ? `Roll: <b>${u.roll_no}</b>` : '',
      u.email ? u.email : ''
    ].filter(Boolean).join(' • ');

    const info = u.role === 'student'
      ? `${u.classes?.name || '-'} • ${u.device_fp ? 'Device Bound' : 'Unbound'}`
      : u.role === 'admin'
        ? (u.is_super_admin ? 'SUPER ADMIN (All Rights)' : 'Sub-Admin (Custom Rights)')
        : 'Faculty Member';

    const rightsBtn = (u.role === 'admin' && !u.is_super_admin)
      ? `<button onclick="openSubAdminModalById('${u.id}')" class="px-2.5 py-1 bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 font-bold rounded mr-1">Admin Rights</button>`
      : '';

    const editBtn = `<button onclick="openEditUserModalById('${u.id}')" class="px-2.5 py-1 bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-bold rounded mr-1">Edit / Pass</button>`;

    return `
      <tr>
        <td class="p-3 font-extrabold uppercase">${u.role} ${!u.is_active ? '<span class="text-rose-500">(OFF)</span>' : ''}</td>
        <td class="p-3 font-bold">${u.full_name}</td>
        <td class="p-3">${ids || '-'}</td>
        <td class="p-3 text-slate-500 dark:text-slate-400">${info}</td>
        <td class="p-3 text-right whitespace-nowrap">
          ${editBtn}
          ${rightsBtn}
          ${!u.is_super_admin ? `<button onclick="deleteEntity('users', '${u.id}')" class="px-2.5 py-1 bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 font-bold rounded">Delete</button>` : ''}
        </td>
      </tr>`;
  }).join('');
}

function openEditUserModalById(userId) {
  const u = (ADM_DATA.users || []).find(item => item.id === userId);
  if (u) openEditUserModal(u);
}

function openSubAdminModalById(userId) {
  const u = (ADM_DATA.users || []).find(item => item.id === userId);
  if (u) openSubAdminModal(u);
}

function openEditUserModal(u) {
  document.getElementById('eu-id').value = u.id;
  document.getElementById('eu-role').value = u.role;
  document.getElementById('eu-name').value = u.full_name || '';
  document.getElementById('eu-email').value = u.email || '';
  document.getElementById('eu-enroll').value = u.enrollment_no || '';
  document.getElementById('eu-roll').value = u.roll_no || '';
  document.getElementById('eu-class').value = u.class_id || '';
  document.getElementById('eu-pass').value = '';
  document.getElementById('eu-active').checked = u.is_active !== false;
  document.getElementById('eu-reset-dev').checked = false;

  const isStu = u.role === 'student';
  const isFac = u.role === 'faculty';
  document.getElementById('eu-stu-fields-1').classList.toggle('hidden', !isStu);
  document.getElementById('eu-stu-fields-2').classList.toggle('hidden', !isStu);
  document.getElementById('eu-class-wrap').classList.toggle('hidden', !isStu);
  document.getElementById('eu-reset-dev-wrap').classList.toggle('hidden', !isStu);
  document.getElementById('eu-fac-perms-box').classList.toggle('hidden', !isFac);

  if (isFac) {
    const fp = u.faculty_permissions || {};
    FAC_PERM_KEYS.forEach(k => {
      document.getElementById(`fperm-${k}`).checked = fp[k] !== false;
    });
  }

  document.getElementById('modal-edit-user').classList.remove('hidden');
}

async function saveEditedUser() {
  const role = document.getElementById('eu-role').value;
  let faculty_permissions = null;
  if (role === 'faculty') {
    faculty_permissions = {};
    FAC_PERM_KEYS.forEach(k => { faculty_permissions[k] = document.getElementById(`fperm-${k}`).checked; });
  }

  const res = await api('admin_update_user', {
    user_id: document.getElementById('eu-id').value,
    full_name: document.getElementById('eu-name').value,
    email: document.getElementById('eu-email').value,
    enrollment_no: document.getElementById('eu-enroll').value,
    roll_no: document.getElementById('eu-roll').value,
    class_id: role === 'student' ? (document.getElementById('eu-class').value || null) : null,
    new_password: document.getElementById('eu-pass').value,
    is_active: document.getElementById('eu-active').checked,
    reset_device: document.getElementById('eu-reset-dev').checked,
    faculty_permissions
  });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-edit-user');
  toast('User updated successfully!');
  await initAdminPortal();
}

async function createStandardUser() {
  const full_name = document.getElementById('new-u-name').value.trim();
  if (!full_name) return toast('Enter a full name first.', true);

  const res = await api('admin_create_user', {
    role: document.getElementById('new-u-role').value,
    full_name,
    enrollment_no: document.getElementById('new-u-enroll').value.trim() || null,
    roll_no: document.getElementById('new-u-roll').value.trim() || null,
    email: document.getElementById('new-u-email').value.trim() || null,
    class_id: document.getElementById('new-u-class').value || null
  });
  if (!res.ok) return toast(res.error, true);

  ['new-u-name', 'new-u-enroll', 'new-u-roll', 'new-u-email'].forEach(id => {
    document.getElementById(id).value = '';
  });
  toast('User added (Default password: Pass@123)');
  await initAdminPortal();
}

function openBulkUserModal() { document.getElementById('modal-bulk-users').classList.remove('hidden'); }
function openBulkTimetableModal() { document.getElementById('modal-bulk-tt').classList.remove('hidden'); }

function loadCsvFileToTextarea(e, targetId) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById(targetId).value = ev.target.result; };
  reader.readAsText(file);
}

function parseCsvLines(text) {
  return text.split(/?
/).map(l => l.trim()).filter(l => l && !l.toLowerCase().startsWith('role,') && !l.toLowerCase().startsWith('class_code,'));
}

async function submitBulkUsers() {
  const lines = parseCsvLines(document.getElementById('bulk-users-csv').value);
  const rows = lines.map(line => {
    const [role, enrollment_no, roll_no, full_name, email, class_code, password] = line.split(',').map(s => (s || '').trim());
    return { role, enrollment_no, roll_no, full_name, email, class_code, password };
  });
  const res = await api('admin_bulk_import_users', { rows });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-bulk-users');
  toast(`Imported ${res.imported} users!` + (res.errors?.length ? ` (${res.errors.length} skipped)` : ''));
  await initAdminPortal();
}

async function submitBulkTimetable() {
  const lines = parseCsvLines(document.getElementById('bulk-tt-csv').value);
  const rows = lines.map(line => {
    const [class_code, subject_code, faculty_email, day_of_week, start_time, end_time] = line.split(',').map(s => (s || '').trim());
    return { class_code, subject_code, faculty_email, day_of_week, start_time, end_time };
  });
  const res = await api('admin_bulk_import_timetable', { rows });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-bulk-tt');
  toast(`Imported ${res.imported} timetable slots!`);
  await initAdminPortal();
}

function downloadSampleUsersCsv() {
  downloadCsv('sample_users_import.csv', [
    ['role', 'enrollment_no', 'roll_no', 'full_name', 'email', 'class_code', 'password'],
    ['student', '240303105001', '62', 'Pranav Patel', 'pranav@college.edu', 'MBA3A', 'Pass@123'],
    ['faculty', '', '', 'Dr. Sharma', 'sharma@college.edu', '', 'Pass@123']
  ]);
}

function downloadSampleTtCsv() {
  downloadCsv('sample_timetable_import.csv', [
    ['class_code', 'subject_code', 'faculty_email', 'day_of_week', 'start_time', 'end_time'],
    ['MBA3A', 'BA301', 'sharma@college.edu', '1', '09:30', '10:30']
  ]);
}

function openSubAdminModal(userObj = null) {
  document.getElementById('sa-id').value = userObj?.id || '';
  document.getElementById('sa-name').value = userObj?.full_name || '';
  document.getElementById('sa-email').value = userObj?.email || '';
  document.getElementById('sa-pass').value = '';
  const perms = userObj?.admin_permissions || {};
  ADMIN_PERM_KEYS.forEach(k => {
    document.getElementById(`perm-${k}`).checked = userObj ? Boolean(perms[k]) : (k !== 'manage_admins' && k !== 'manage_settings');
  });
  document.getElementById('modal-subadmin').classList.remove('hidden');
}

async function saveSubAdmin() {
  const admin_permissions = {};
  ADMIN_PERM_KEYS.forEach(k => { admin_permissions[k] = document.getElementById(`perm-${k}`).checked; });
  const res = await api('admin_save_subadmin_perms', {
    target_user_id: document.getElementById('sa-id').value || null,
    full_name: document.getElementById('sa-name').value,
    email: document.getElementById('sa-email').value,
    password: document.getElementById('sa-pass').value,
    admin_permissions
  });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-subadmin');
  toast('Sub-Admin rights saved!');
  await initAdminPortal();
}

function fillCurrentLocation(targetId) {
  if (!navigator.geolocation) return toast('Geolocation not supported.', true);
  toast('Fetching current GPS coordinates...');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      if (targetId === 'default') {
        document.getElementById('geo-def-lat').value = lat;
        document.getElementById('geo-def-lng').value = lng;
        document.getElementById('geo-def-enabled').checked = true;
      } else {
        document.getElementById(`cgeo-lat-${targetId}`).value = lat;
        document.getElementById(`cgeo-lng-${targetId}`).value = lng;
        document.getElementById(`cgeo-en-${targetId}`).checked = true;
      }
      toast(`Location captured (±${Math.round(pos.coords.accuracy)}m accuracy)! Click Save.`);
    },
    err => toast('Location error: ' + err.message, true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function renderClassGeoList() {
  const box = document.getElementById('class-geo-list');
  box.innerHTML = ADM_DATA.classes.map(c => `
    <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-6 gap-2.5 items-center">
      <div>
        <p class="font-bold text-xs">${c.name}</p>
        <label class="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 dark:text-indigo-400 mt-1">
          <input id="cgeo-en-${c.id}" type="checkbox" ${c.custom_geo_enabled ? 'checked' : ''}>
          Custom Priority Geo
        </label>
      </div>
      <input id="cgeo-lat-${c.id}" type="number" step="any" value="${c.custom_lat || ''}" placeholder="Latitude" class="px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-mono">
      <input id="cgeo-lng-${c.id}" type="number" step="any" value="${c.custom_lng || ''}" placeholder="Longitude" class="px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-mono">
      <input id="cgeo-rad-${c.id}" type="number" value="${c.custom_radius_meters || 150}" placeholder="Radius (m)" class="px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-mono">
      <button type="button" onclick="fillCurrentLocation('${c.id}')" class="px-2.5 py-1.5 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 font-bold rounded-lg text-xs">📍 Current Loc</button>
      <button type="button" onclick="saveClassGeo('${c.id}')" class="px-3 py-1.5 bg-indigo-600 text-white font-bold rounded-lg text-xs">Save Class Geo</button>
    </div>
  `).join('');
}

async function saveClassGeo(classId) {
  const res = await api('admin_update_class_geo', {
    class_id: classId,
    custom_geo_enabled: document.getElementById(`cgeo-en-${classId}`).checked,
    custom_lat: document.getElementById(`cgeo-lat-${classId}`).value,
    custom_lng: document.getElementById(`cgeo-lng-${classId}`).value,
    custom_radius_meters: document.getElementById(`cgeo-rad-${classId}`).value
  });
  if (!res.ok) return toast(res.error, true);
  toast('Individual class geofence saved!');
}

function renderDeviceRequests() {
  const box = document.getElementById('device-req-list');
  if (!ADM_DATA.device_requests.length) {
    box.innerHTML = '<p class="text-slate-400">No pending device change requests.</p>';
    return;
  }
  box.innerHTML = ADM_DATA.device_requests.map(r => `
    <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p class="font-bold">${r.student_name} (${r.roll_no}) • ${r.classes?.name || ''}</p>
        <p class="text-slate-500 mt-0.5">Reason: "${r.reason}" • New ID: <span class="font-mono">${r.new_device_fp}</span></p>
      </div>
      <div class="flex gap-2">
        <button onclick="reviewDeviceReq('${r.id}', 'APPROVED')" class="px-3 py-1.5 bg-emerald-600 text-white font-bold rounded-lg">Approve</button>
        <button onclick="reviewDeviceReq('${r.id}', 'REJECTED')" class="px-3 py-1.5 bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300 font-bold rounded-lg">Reject</button>
      </div>
    </div>
  `).join('');
}

async function reviewDeviceReq(requestId, decision) {
  const res = await api('admin_review_device_req', { request_id: requestId, decision });
  if (!res.ok) return toast(res.error, true);
  toast(`Device request ${decision.toLowerCase()}.`);
  await initAdminPortal();
}

function renderAuditLogs() {
  const box = document.getElementById('admin-logs-list');
  if (!ADM_DATA.logs.length) {
    box.innerHTML = '<p class="text-slate-400">No security events logged yet.</p>';
    return;
  }
  box.innerHTML = ADM_DATA.logs.map(l => `
    <div class="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 flex justify-between gap-3">
      <span><b class="text-indigo-600 dark:text-indigo-400">[${l.event_type}]</b> ${l.details || ''}</span>
      <span class="text-slate-400 whitespace-nowrap">${new Date(l.created_at).toLocaleString('en-IN')}</span>
    </div>
  `).join('');
}

function renderAcademics() {
  document.getElementById('admin-classes-list').innerHTML = ADM_DATA.classes.map(c =>
    `<div class="p-2.5 border border-slate-200 dark:border-slate-800 rounded-lg flex justify-between"><span><b>${c.name}</b> (${c.code})</span><button onclick="deleteEntity('classes','${c.id}')" class="text-rose-600 font-bold">Delete</button></div>`
  ).join('');

  document.getElementById('admin-subjects-list').innerHTML = ADM_DATA.subjects.map(s =>
    `<div class="p-2.5 border border-slate-200 dark:border-slate-800 rounded-lg flex justify-between"><span><b>${s.name}</b> (${s.code})</span><button onclick="deleteEntity('subjects','${s.id}')" class="text-rose-600 font-bold">Delete</button></div>`
  ).join('');

  document.getElementById('admin-timetable-list').innerHTML = ADM_DATA.slots.map(sl =>
    `<div class="p-2.5 border border-slate-200 dark:border-slate-800 rounded-lg flex justify-between"><span><b>${sl.classes?.name}</b> • ${sl.subjects?.name} → <b>${sl.users?.full_name}</b></span><button onclick="deleteEntity('timetable_slots','${sl.id}')" class="text-rose-600 font-bold">Remove</button></div>`
  ).join('');
}

async function createClass() {
  const res = await api('admin_create_entity', {
    table: 'classes',
    data: { name: document.getElementById('new-cls-name').value, code: document.getElementById('new-cls-code').value }
  });
  if (!res.ok) return toast(res.error, true);
  await initAdminPortal();
}

async function createSubject() {
  const res = await api('admin_create_entity', {
    table: 'subjects',
    data: { name: document.getElementById('new-sub-name').value, code: document.getElementById('new-sub-code').value }
  });
  if (!res.ok) return toast(res.error, true);
  await initAdminPortal();
}

async function createTimetableSlot() {
  const res = await api('admin_create_entity', {
    table: 'timetable_slots',
    data: {
      class_id: document.getElementById('tt-class').value,
      subject_id: document.getElementById('tt-subject').value,
      faculty_id: document.getElementById('tt-faculty').value
    }
  });
  if (!res.ok) return toast(res.error, true);
  toast('Faculty assigned to class & subject!');
  await initAdminPortal();
}

async function deleteEntity(table, id) {
  const res = await api('admin_delete_entity', { table, id });
  if (!res.ok) return toast(res.error, true);
  await initAdminPortal();
}

async function assignProxyLecture() {
  const res = await api('admin_assign_proxy', {
    class_id: document.getElementById('proxy-class').value,
    subject_id: document.getElementById('proxy-subject').value,
    substitute_faculty_id: document.getElementById('proxy-faculty').value
  });
  if (!res.ok) return toast(res.error, true);
  toast('Proxy lecture assigned & live on substitute faculty portal!');
}

async function saveAdminSettings(clearSmtp = false) {
  const patch = {
    app_title: document.getElementById('set-app-title').value,
    college_name: document.getElementById('set-college-name').value,
    logo_url: document.getElementById('set-logo-url').value,
    allow_extra_lectures: document.getElementById('set-extra-lec').checked,
    geofence_enabled: document.getElementById('geo-def-enabled').checked,
    campus_lat: document.getElementById('geo-def-lat').value || null,
    campus_lng: document.getElementById('geo-def-lng').value || null,
    geofence_radius_meters: document.getElementById('geo-def-rad').value || 150,
    smtp_email: document.getElementById('set-smtp-email').value,
    smtp_app_password: document.getElementById('set-smtp-pass').value,
    clear_smtp: clearSmtp
  };
  const res = await api('admin_save_settings', { patch });
  if (!res.ok) return toast(res.error, true);
  toast('System settings saved!');
  await initApp();
}

async function testAdminSmtp() {
  const res = await api('admin_test_smtp');
  if (!res.ok) return toast(res.error, true);
  toast('Test email sent to your Admin inbox!');
}

function clearAdminSmtp() {
  document.getElementById('set-smtp-email').value = '';
  document.getElementById('set-smtp-pass').value = '';
  saveAdminSettings(true);
}

async function exportAdminFullBackup() {
  const res = await api('admin_export_backup');
  if (!res.ok) return toast(res.error, true);
  const clsMap = Object.fromEntries(res.classes.map(c => [c.id, c.name]));
  const subMap = Object.fromEntries(res.subjects.map(s => [s.id, s.name]));
  const stuMap = Object.fromEntries(res.students.map(st => [st.id, st]));
  const sesMap = Object.fromEntries(res.sessions.map(se => [se.id, se]));

  const rows = [['Date', 'Class', 'Subject', 'Type', 'Enrollment No', 'Roll No', 'Student Name', 'Status', 'Marked Via']];
  res.records.forEach(r => {
    const se = sesMap[r.session_id] || {};
    const st = stuMap[r.student_id] || {};
    rows.push([
      se.session_date || '',
      clsMap[se.class_id] || '',
      subMap[se.subject_id] || '',
      se.session_type || 'REGULAR',
      st.enrollment_no || '',
      st.roll_no || '',
      st.full_name || '',
      r.status,
      r.marked_via || 'QR'
    ]);
  });
  downloadCsv('smartqr_full_semester_backup.csv', rows);
}

function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('
');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

window.addEventListener('DOMContentLoaded', initApp);
