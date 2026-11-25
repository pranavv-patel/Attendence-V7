let CURRENT_USER = null;
let SETTINGS = {};
let PENDING_MISMATCH = null;
let CURRENT_ADMIN_TAB = 'dashboard';
let QR_PAUSED = false;
let STARTING_SESSION = false;
let LAST_RENDERED_NONCE = '';
let LAST_FAC_ROSTER_SIG = '';
let LAST_CR_ROSTER_SIG = '';
let LAST_EXPORT_ROWS = [];

const LOADED_TABS = {
  crToday: false, facLiveSetup: false, facClasses: false, facMatrix: false,
  admDashboard: false, admUsers: false, admAcademics: false, admSessions: false, admDevices: false, admExport: false
};

const ADM_STATE = { breakdown: [], users: [], classes: [], subjects: [], slots: [], faculty: [], sessions: [], students: [], records: [], deviceReqs: [], logs: [] };
const FAC_STATE = { slots: [], classes: [], subjects: [], sessions: [], liveSession: null, roster: [], qrCount: 0 };
const CR_STATE = { lectures: [], liveSession: null, roster: [], qrCount: 0 };

let QR_ROTATE_TIMER = null;
let CLOCK_TIMER = null;
let ROSTER_POLL_TIMER = null;
let STU_STREAM = null;
let STU_RAF = null;
let STU_CAM_OPEN = false;

function getDeviceFp() {
  let fp = localStorage.getItem('sqr_v8_dev_fp');
  if (!fp) {
    fp = 'DEV8-' + Math.random().toString(36).slice(2, 10).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
    localStorage.setItem('sqr_v8_dev_fp', fp);
  }
  return fp;
}

function applyTheme(theme) {
  const isLight = theme === 'light';
  document.documentElement.classList.toggle('light', isLight);
  localStorage.setItem('sqr_theme', isLight ? 'light' : 'dark');
  const label = isLight ? '🌙 Dark' : '☀️ Light';
  const lb = document.getElementById('login-theme-btn');
  if (lb) lb.textContent = label;
  document.querySelectorAll('[data-theme-btn]').forEach(b => { b.textContent = label; });
}

function initTheme() { applyTheme(localStorage.getItem('sqr_theme') || SETTINGS.default_theme || 'dark'); }
function toggleTheme() { applyTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light'); }

function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', isErr);
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

async function api(action, body = {}) {
  try {
    const res = await fetch(`/api/gateway?action=${encodeURIComponent(action)}&_t=${Date.now()}`, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && data.ok === undefined) return { ok: false, error: data.error || `Request failed (${res.status})` };
    return data;
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}

function togglePass(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  const isPw = el.type === 'password';
  el.type = isPw ? 'text' : 'password';
  btn.textContent = isPw ? 'HIDE' : 'SHOW';
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function openChangePassModal() {
  ['cp-old', 'cp-new1', 'cp-new2'].forEach(id => { document.getElementById(id).value = ''; });
  openModal('modal-change-pass');
}

async function submitModalPasswordChange() {
  const current_password = document.getElementById('cp-old').value;
  const p1 = document.getElementById('cp-new1').value;
  const p2 = document.getElementById('cp-new2').value;
  if (!p1 || p1.length < 4) return toast('New password must be at least 4 characters.', true);
  if (p1 !== p2) return toast('New passwords do not match.', true);
  const r = await api('change_password', { current_password, new_password: p1 });
  if (!r.ok) return toast(r.error, true);
  closeModal('modal-change-pass');
  toast('Password updated!');
}

function clearSessionLoops() {
  if (QR_ROTATE_TIMER) { clearInterval(QR_ROTATE_TIMER); QR_ROTATE_TIMER = null; }
  if (CLOCK_TIMER) { clearInterval(CLOCK_TIMER); CLOCK_TIMER = null; }
  if (ROSTER_POLL_TIMER) { clearInterval(ROSTER_POLL_TIMER); ROSTER_POLL_TIMER = null; }
}

function resetLazyFlags() { Object.keys(LOADED_TABS).forEach(k => { LOADED_TABS[k] = false; }); }

async function initApp() {
  document.getElementById('login-fp-code').textContent = getDeviceFp();
  const res = await api('init');
  if (res.ok && res.settings) {
    SETTINGS = res.settings;
    if (SETTINGS.app_title) document.getElementById('brand-title-login').innerHTML = `${SETTINGS.app_title}`;
    if (SETTINGS.college_name) document.getElementById('brand-college-login').textContent = SETTINGS.college_name;
  }
  initTheme();
  if (res.ok && res.user) routeToRole(res.user);
  else showScreen('login');
}

function showScreen(name) {
  ['login', 'student', 'cr', 'faculty', 'admin'].forEach(s => {
    document.getElementById('screen-' + s).classList.toggle('active', s === name);
  });
  if (name !== 'student') stopStudentCamera();
}

function routeToRole(user) {
  CURRENT_USER = user;
  resetLazyFlags();
  clearSessionLoops();

  if (user.role === 'student') {
    showScreen('student');
    document.getElementById('stu-name').textContent = user.full_name;
    document.getElementById('stu-meta').textContent = `Enroll: ${user.enrollment_no || '-'} · Roll: ${user.roll_no || '-'} · ${user.classes?.name || '-'}`;
    document.getElementById('stu-tab-fp').textContent = getDeviceFp();
    switchStudentTab('scan');
  } else if (user.role === 'cr') {
    showScreen('cr');
    document.getElementById('cr-heading').textContent = `${user.full_name} (CR)`;
    document.getElementById('cr-sub').textContent = `Class: ${user.classes?.name || '-'} · Today's Lectures Only`;
    loadCRTodayLectures(false);
  } else if (user.role === 'faculty') {
    showScreen('faculty');
    document.getElementById('fac-sidebar-meta').textContent = `${user.faculty_code || 'FAC'} · ${user.full_name}`;
    switchFacultyTab('live');
  } else if (user.role === 'admin') {
    showScreen('admin');
    document.getElementById('adm-chip-name').textContent = user.full_name;
    switchAdminTab('dashboard');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  document.getElementById('device-mismatch-box').classList.add('hidden');
  const identifier = document.getElementById('login-id').value.trim();
  const password = document.getElementById('login-pass').value;
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in...';
  const res = await api('login', { identifier, password, device_fp: getDeviceFp() });
  btn.disabled = false; btn.textContent = 'Sign In Securely';
  if (!res.ok) {
    if (res.error === 'DEVICE_MISMATCH') {
      PENDING_MISMATCH = res;
      document.getElementById('device-mismatch-msg').textContent = res.message || 'Unrecognized device.';
      document.getElementById('device-mismatch-box').classList.remove('hidden');
      return;
    }
    return toast(res.error || 'Login failed', true);
  }
  routeToRole(res.user);
}

async function submitDeviceRequestFromLogin() {
  if (!PENDING_MISMATCH) return;
  const r = await api('request_device_change', {
    student_id: PENDING_MISMATCH.student_id, new_device_fp: getDeviceFp(),
    reason: document.getElementById('login-dev-reason').value.trim()
  });
  if (!r.ok) return toast(r.error, true);
  toast(r.message || 'Device request submitted!');
  document.getElementById('device-mismatch-box').classList.add('hidden');
}

async function logoutUser() {
  clearSessionLoops();
  stopStudentCamera();
  await api('logout');
  CURRENT_USER = null;
  showScreen('login');
}

// ================= STUDENT (3 OPTIONS) =================
function switchStudentTab(tab) {
  if (tab !== 'scan') stopStudentCamera();
  ['scan', 'password', 'device'].forEach(t => document.getElementById(`stu-tab-${t}`).classList.toggle('hidden', t !== tab));
  document.querySelectorAll('[data-stu-tab]').forEach(b => b.classList.toggle('active', b.dataset.stuTab === tab));
  if (tab === 'device') document.getElementById('stu-tab-fp').textContent = getDeviceFp();
}

function stopStudentCamera() {
  STU_CAM_OPEN = false;
  if (STU_RAF) { cancelAnimationFrame(STU_RAF); STU_RAF = null; }
  const video = document.getElementById('stu-video');
  if (STU_STREAM) { STU_STREAM.getTracks().forEach(t => { try { t.stop(); } catch {} }); STU_STREAM = null; }
  if (video) { try { video.pause(); } catch {} video.srcObject = null; video.classList.add('hidden'); }
  document.getElementById('stu-scan-overlay').classList.add('hidden');
  document.getElementById('stu-cam-idle').classList.remove('hidden');
  const btn = document.getElementById('btn-stu-cam');
  if (btn) { btn.textContent = 'Open Camera'; btn.className = 'btn btn-primary btn-full'; }
}

async function toggleStudentCamera() {
  if (STU_CAM_OPEN) { stopStudentCamera(); document.getElementById('stu-scan-status').textContent = 'Camera closed.'; return; }
  stopStudentCamera();
  const statusEl = document.getElementById('stu-scan-status');
  const btn = document.getElementById('btn-stu-cam');
  statusEl.textContent = 'Starting camera...';
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera API unavailable.', true);
  try {
    STU_STREAM = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    STU_CAM_OPEN = true;
    const video = document.getElementById('stu-video');
    const canvas = document.getElementById('stu-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    video.srcObject = STU_STREAM; video.classList.remove('hidden');
    document.getElementById('stu-cam-idle').classList.add('hidden');
    document.getElementById('stu-scan-overlay').classList.remove('hidden');
    btn.textContent = 'Close Camera'; btn.className = 'btn btn-danger btn-full';
    statusEl.textContent = 'Point camera at classroom QR...';
    await video.play();
    const scanLoop = async () => {
      if (!STU_CAM_OPEN || !STU_STREAM) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = typeof jsQR === 'function' ? jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
        if (code?.data) { stopStudentCamera(); statusEl.textContent = 'QR captured! Verifying...'; await submitStudentQr(code.data); return; }
      }
      STU_RAF = requestAnimationFrame(scanLoop);
    };
    STU_RAF = requestAnimationFrame(scanLoop);
  } catch (err) { stopStudentCamera(); statusEl.textContent = 'Camera denied.'; toast('Camera error: ' + err.message, true); }
}

async function submitStudentQr(rawText) {
  let payload;
  try { payload = JSON.parse(rawText); } catch { return toast('Invalid QR code.', true); }
  const send = async (lat = null, lng = null) => {
    const res = await api('submit_qr', { session_id: payload.s || payload.sid, nonce: payload.n, device_fp: getDeviceFp(), lat, lng });
    if (!res.ok) {
      if (res.error === 'DEVICE_MISMATCH') {
        document.getElementById('stu-scan-status').textContent = 'Device mismatch — submit a change request.';
        document.getElementById('stu-mismatch-text').textContent = res.message || 'Unrecognized device. Submit a Device Change Request.';
        document.getElementById('stu-mismatch-fp').textContent = getDeviceFp();
        document.getElementById('stu-mismatch-reason').value = '';
        openModal('modal-stu-dev-mismatch');
        return;
      }
      document.getElementById('stu-scan-status').textContent = res.message || res.error;
      return toast(res.message || res.error, true);
    }
    document.getElementById('stu-scan-status').textContent = 'Attendance Marked Present (P) ✓';
    toast('Attendance Marked Present (P)!');
  };
  if (SETTINGS.geofence_enabled && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => send(p.coords.latitude, p.coords.longitude), () => send(null, null), { enableHighAccuracy: true, timeout: 6000 });
  } else { await send(null, null); }
}

function validateStudentPasswordMatch() {
  const p1 = document.getElementById('stu-cp-new1').value;
  const p2 = document.getElementById('stu-cp-new2').value;
  const hint = document.getElementById('stu-cp-match-hint');
  if (!p1 && !p2) { hint.textContent = ''; return; }
  if (p1.length < 4) { hint.textContent = 'Use at least 4 characters.'; hint.style.color = 'var(--amber)'; return; }
  hint.textContent = p1 === p2 ? 'Passwords match ✓' : 'Passwords do not match';
  hint.style.color = p1 === p2 ? 'var(--green)' : 'var(--red)';
}

async function submitStudentPassword() {
  const current_password = document.getElementById('stu-cp-old').value;
  const p1 = document.getElementById('stu-cp-new1').value;
  const p2 = document.getElementById('stu-cp-new2').value;
  if (!p1 || p1.length < 4) return toast('New password must be at least 4 characters.', true);
  if (p1 !== p2) return toast('New passwords do not match.', true);
  const r = await api('change_password', { current_password, new_password: p1 });
  if (!r.ok) return toast(r.error, true);
  ['stu-cp-old', 'stu-cp-new1', 'stu-cp-new2'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('stu-cp-match-hint').textContent = '';
  toast('Password updated!');
}

async function submitDeviceRequestFromPopup() {
  const reason = document.getElementById('stu-mismatch-reason').value.trim();
  const r = await api('request_device_change', { student_id: CURRENT_USER?.id, new_device_fp: getDeviceFp(), reason });
  if (!r.ok) return toast(r.error, true);
  closeModal('modal-stu-dev-mismatch');
  toast(r.message || 'Device change request submitted!');
}

async function submitStudentDeviceRequest() {
  const r = await api('request_device_change', {
    student_id: CURRENT_USER?.id, new_device_fp: getDeviceFp(),
    reason: document.getElementById('stu-dev-reason').value.trim()
  });
  if (!r.ok) return toast(r.error, true);
  document.getElementById('stu-dev-reason').value = '';
  toast(r.message || 'Device change request submitted!');
}

// ================= CLASS-WISE GROUPING HELPER (FOR MERGED CLASSES) =================
function groupScannedByClass(roster) {
  const scanned = (roster || []).filter(r => r.status === 'P' || r.status === 'OD');
  const groups = new Map();
  for (const r of scanned) {
    const label = r.class_name ? `${r.class_name}${r.class_code ? ' (' + r.class_code + ')' : ''}` : (r.class_code || 'Class');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(r);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.roll_no || a.enrollment_no || '').localeCompare(String(b.roll_no || b.enrollment_no || ''), undefined, { numeric: true }));
  }
  return groups;
}

function renderGroupedRollPills(containerId, roster) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const groups = groupScannedByClass(roster);
  if (!groups.size) {
    el.innerHTML = '<span style="color:var(--text-mute);font-size:0.78rem;">Waiting for scans...</span>';
    return;
  }
  let html = '';
  for (const [clsLabel, items] of groups.entries()) {
    html += `<div>
      <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;color:var(--accent);margin-bottom:5px;">${clsLabel} (${items.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${items.map(r => `<span class="pill ${r.status === 'OD' ? 'amber' : 'green'} mono">${r.roll_no || r.enrollment_no || r.full_name}${r.status === 'OD' ? ' (OD)' : ''}</span>`).join('')}
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

function buildClassWiseEmailPayload() {
  const s = CURRENT_USER?.role === 'cr' ? CR_STATE.liveSession : FAC_STATE.liveSession;
  const roster = CURRENT_USER?.role === 'cr' ? CR_STATE.roster : FAC_STATE.roster;
  const qrCount = CURRENT_USER?.role === 'cr' ? CR_STATE.qrCount : FAC_STATE.qrCount;
  if (!s) return null;

  const groups = groupScannedByClass(roster);
  const totalMarked = (roster || []).filter(r => r.status === 'P' || r.status === 'OD').length;
  const classBlocks = [];
  for (const [clsLabel, items] of groups.entries()) {
    const rolls = items.map(r => `${r.roll_no || r.enrollment_no || r.full_name}${r.status === 'OD' ? ' (OD)' : ''}`).join(', ');
    classBlocks.push(`${clsLabel} [${items.length}]:\n${rolls}`);
  }

  const subjectLine = `Attendance ${s.session_code}: ${s.subject_name} | ${s.class_label} (${s.session_date})`;
  const bodyText = [
    `Session ID: ${s.session_code}`,
    `Date: ${s.session_date}`,
    `Subject: ${s.subject_name} (${s.subject_code || '-'})`,
    `Classes: ${s.class_label}`,
    `Total Marked (P + OD): ${totalMarked}`,
    `QR Headcount: ${qrCount}`,
    `Manual Headcount: ${s.manual_headcount ?? 'Not Entered'}`,
    ``,
    `Class-Wise Present / OD Roll Numbers:`,
    classBlocks.length ? classBlocks.join('\n\n') : 'None'
  ].join('\n');

  return { subjectLine, bodyText, classBlocks };
}

function copySessionRolls() {
  const payload = buildClassWiseEmailPayload();
  if (!payload || !payload.classBlocks.length) return toast('No roll numbers to copy yet.', true);
  navigator.clipboard?.writeText(payload.classBlocks.join('\n\n'));
  toast('Copied class-wise roll numbers!');
}

async function emailFacultySessionReport() {
  const payload = buildClassWiseEmailPayload();
  if (!payload) return;
  const r = await api('email_attendance_self', { subject: payload.subjectLine, text: payload.bodyText });
  if (!r.ok) return toast(r.error, true);
  toast('Class-wise report auto-emailed to your inbox!');
}

function openGmailSelf() {
  const payload = buildClassWiseEmailPayload();
  if (!payload) return;
  const to = encodeURIComponent(CURRENT_USER?.email || '');
  const su = encodeURIComponent(payload.subjectLine);
  const body = encodeURIComponent(payload.bodyText);
  window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}&body=${body}`, '_blank');
}

function openMailtoSelf() {
  const payload = buildClassWiseEmailPayload();
  if (!payload) return;
  const to = encodeURIComponent(CURRENT_USER?.email || '');
  const su = encodeURIComponent(payload.subjectLine);
  const body = encodeURIComponent(payload.bodyText);
  window.location.href = `mailto:${to}?subject=${su}&body=${body}`;
}

// ================= CR PORTAL =================
async function loadCRTodayLectures(force = false) {
  if (LOADED_TABS.crToday && !force) return;
  const res = await api('cr_today_lectures');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.crToday = true;
  CR_STATE.lectures = res.lectures || [];
  const box = document.getElementById('cr-lectures-list');
  box.innerHTML = CR_STATE.lectures.length ? CR_STATE.lectures.map(lec => `
    <div style="padding:14px;border-radius:12px;background:var(--bg-3);border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div>
        <div class="mono" style="font-size:0.74rem;color:var(--accent);">${lec.start_time} – ${lec.end_time} (v${lec.timetable_version})</div>
        <div style="font-weight:700;margin-top:2px;">${lec.subject_name} <span style="color:var(--text-mute);">(${lec.subject_code})</span></div>
        <div style="font-size:0.74rem;color:var(--text-dim);">${(lec.class_names || []).join(' + ')} · ${lec.window_reason}</div>
      </div>
      <button type="button" ${!lec.window_allowed ? 'disabled' : ''} onclick="crOpenSlotQr('${lec.slot_id}')" class="btn ${lec.window_allowed ? 'btn-primary' : 'btn-ghost'}">${lec.active_session ? 'Re-Open QR' : 'Open QR'}</button>
    </div>
  `).join('') : '<p style="color:var(--text-mute);font-size:0.82rem;">No lectures scheduled for your class today.</p>';

  const active = CR_STATE.lectures.find(l => l.active_session?.is_active);
  if (active?.active_session) openSessionMonitor(active.active_session.id, 'cr');
}

async function crOpenSlotQr(slotId) {
  const res = await api('cr_open_lecture_qr', { slot_id: slotId });
  if (!res.ok) return toast(res.error, true);
  toast("Today's lecture QR opened!");
  await openSessionMonitor(res.session.id, 'cr');
}

async function crMarkSelfAttendance() {
  if (!CR_STATE.liveSession) return;
  const res = await api('cr_mark_self', { session_id: CR_STATE.liveSession.id });
  if (!res.ok) return toast(res.error, true);
  toast('Your CR attendance has been marked Present (P)!');
  await refreshSessionMonitorData(CR_STATE.liveSession.id, 'cr');
}

// ================= FACULTY PORTAL =================
async function switchFacultyTab(tab) {
  ['live', 'classes', 'matrix', 'devices'].forEach(t => document.getElementById(`fac-tab-${t}`).classList.toggle('active', t === tab));
  document.querySelectorAll('[data-fac-tab]').forEach(b => b.classList.toggle('active', b.dataset.facTab === tab));
  document.getElementById('fac-sidebar').classList.remove('open');
  const titles = { live: 'Live QR <span>& Roster</span>', classes: 'My Classes <span>& Merged</span>', matrix: 'Past <span>Lectures</span>', devices: 'Device <span>Change Requests</span>' };
  document.getElementById('fac-page-title').innerHTML = titles[tab] || tab;
  if (tab === 'live' && !LOADED_TABS.facLiveSetup) await loadFacultyLiveSetup();
  else if (tab === 'classes' && !LOADED_TABS.facClasses) await loadFacultyClasses(false);
  else if (tab === 'matrix' && !LOADED_TABS.facMatrix) await loadFacultyMatrix(false);
}

async function loadFacultyLiveSetup() {
  const res = await api('faculty_classes');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.facLiveSetup = true;
  FAC_STATE.classes = res.classes || []; FAC_STATE.subjects = res.subjects || []; FAC_STATE.slots = res.slots || [];
  const clsHtml = FAC_STATE.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  document.getElementById('fac-start-class').innerHTML = clsHtml;
  document.getElementById('fac-merge-classes').innerHTML = clsHtml;
  document.getElementById('fac-merge-classes').selectedIndex = -1;
  document.getElementById('fac-start-subject').innerHTML = FAC_STATE.subjects.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
}

async function loadFacultyClasses(force = false) {
  if (LOADED_TABS.facClasses && !force) return;
  const res = await api('faculty_classes');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.facClasses = true;
  FAC_STATE.slots = res.slots || [];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  document.getElementById('fac-classes-grid').innerHTML = FAC_STATE.slots.length ? FAC_STATE.slots.map(sl => `
    <div class="panel" style="margin-bottom:0;">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span class="mono" style="font-size:0.74rem;color:var(--accent);">${days[sl.day_of_week]} · ${sl.start_time}–${sl.end_time}</span>
        ${(sl.class_ids || []).length > 1 ? '<span class="pill purple">MERGED</span>' : `<span class="pill blue">v${sl.version_no || 1}</span>`}
      </div>
      <div style="font-weight:700;margin-bottom:4px;">${sl.subject_name} (${sl.subject_code})</div>
      <div style="font-size:0.76rem;color:var(--text-dim);margin-bottom:12px;">${(sl.class_names || []).join(' + ')}</div>
      <button type="button" onclick="startSessionFromSlotById('${sl.id}')"  class="btn btn-primary btn-full">Start Lecture QR</button>
    </div>
  `).join('') : '<p style="color:var(--text-mute);">No timetable slots assigned yet.</p>';
}

async function loadFacultyDeviceRequests() {
  const box = document.getElementById('fac-dev-list');
  box.innerHTML = '<p style="color:var(--text-mute);font-size:0.82rem;">Loading pending requests...</p>';
  const res = await api('faculty_device_requests');
  if (!res.ok) return toast(res.error, true);
  const list = res.device_requests || [];
  box.innerHTML = list.length ? list.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding:12px;border-radius:10px;background:var(--bg-3);border:1px solid var(--border);">
      <div><strong>${r.student_name}</strong> (${r.roll_no}) · ${r.classes?.code || ''} · "${r.reason || '-'}" · <code class="mono">${r.new_device_fp}</code></div>
      <div style="display:flex;gap:8px;">
        <button type="button" onclick="reviewFacultyDeviceReq('${r.id}','APPROVED')" class="btn btn-green">Approve</button>
        <button type="button" onclick="reviewFacultyDeviceReq('${r.id}','REJECTED')" class="btn btn-danger">Reject</button>
      </div>
    </div>
  `).join('') : '<p style="color:var(--text-mute);font-size:0.82rem;">No pending device requests.</p>';
}

async function reviewFacultyDeviceReq(id, decision) {
  const r = await api('faculty_review_device_req', { request_id: id, decision });
  if (!r.ok) return toast(r.error, true);
  toast(`Device request ${decision.toLowerCase()}.`);
  await loadFacultyDeviceRequests();
}

async function startSessionFromSlotById(slotId) {
  const sl = (FAC_STATE.slots || []).find(x => x.id === slotId);
  if (!sl) return;
  switchFacultyTab('live');
  const res = await api('start_session', {
    class_id: sl.class_id, class_ids: sl.class_ids || [sl.class_id], subject_id: sl.subject_id,
    slot_id: sl.id, slot_start_time: sl.start_time, slot_end_time: sl.end_time, session_type: 'REGULAR'
  });
  if (!res.ok) return toast(res.error, true);
  toast(res.resumed ? 'Resumed existing lecture — Update Attendance mode!' : 'Lecture QR started!');
  await openSessionMonitor(res.session.id, 'fac');
}

async function startFacultyLecture(sessionType) {
  if (STARTING_SESSION) return;
  STARTING_SESSION = true;
  try {
  const primaryClass = document.getElementById('fac-start-class').value;
  const merged = [...document.getElementById('fac-merge-classes').selectedOptions].map(o => o.value);
  const res = await api('start_session', {
    class_id: primaryClass, class_ids: [...new Set([primaryClass, ...merged].filter(Boolean))],
    subject_id: document.getElementById('fac-start-subject').value, session_type: sessionType
  });
  if (!res.ok) return toast(res.error, true);
  toast(res.resumed ? 'Resumed existing lecture — Update Attendance mode!' : `${sessionType} session started!`);
  await openSessionMonitor(res.session.id, 'fac');
  } finally { STARTING_SESSION = false; }
}

async function toggleFacultyGeo() {
  if (!FAC_STATE.liveSession) return;
  const checked = document.getElementById('fac-geo-toggle').checked;
  const r = await api('toggle_session_geo', { session_id: FAC_STATE.liveSession.id, geofence_override: checked });
  if (!r.ok) return toast(r.error, true);
  toast(`GPS ${checked ? 'ON' : 'OFF'}`);
}

function togglePauseQr() {
  QR_PAUSED = !QR_PAUSED;
  const btn = document.getElementById('fac-pause-btn');
  const pill = document.getElementById('fac-live-pill');
  if (btn) btn.textContent = QR_PAUSED ? 'Resume QR' : 'Pause QR';
  if (pill) { pill.textContent = QR_PAUSED ? 'PAUSED' : 'LIVE'; pill.className = QR_PAUSED ? 'pill amber' : 'pill green'; }
  toast(QR_PAUSED ? 'QR rotation paused.' : 'QR rotation resumed.');
}

function openProjectorMode() {
  const s = CURRENT_USER?.role === 'cr' ? CR_STATE.liveSession : FAC_STATE.liveSession;
  if (!s) return;
  document.getElementById('proj-title').textContent = `${s.subject_name} · ${s.class_label}`;
  document.getElementById('proj-code').textContent = s.session_code;
  renderQrElement('proj-qr-box', s.id, s.current_nonce, 300);
  openModal('modal-projector');
}

async function loadFacultyMatrix(force = false) {
  if (LOADED_TABS.facMatrix && !force) return;
  const res = await api('faculty_attendance_matrix');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.facMatrix = true;
  FAC_STATE.sessions = res.sessions || [];
  document.getElementById('fac-history-tbody').innerHTML = FAC_STATE.sessions.length ? FAC_STATE.sessions.map(s => `
    <tr>
      <td class="mono" style="color:var(--accent);">${s.session_code}</td>
      <td class="mono">${s.session_date}</td>
      <td><strong>${s.class_label}</strong></td>
      <td>${s.subject_name}</td>
      <td><strong>${s.p_count + s.od_count}</strong></td>
      <td class="mono">${s.manual_headcount ?? '-'}</td>
      <td><button type="button" onclick="switchFacultyTab('live'); openSessionMonitor('${s.id}','fac')" class="btn btn-ghost">Open / Email</button></td>
    </tr>
  `).join('') : '<tr><td colspan="7" style="text-align:center;">No lectures recorded yet.</td></tr>';
}

// ================= LIVE SESSION MONITOR =================
function renderQrElement(containerId, sessionId, nonce, size = 196) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  if (typeof QRCode === 'function') new QRCode(box, { text: JSON.stringify({ s: sessionId, n: nonce }), width: size, height: size });
}

async function openSessionMonitor(sessionId, mode) {
  clearSessionLoops();
  QR_PAUSED = false;
  LAST_RENDERED_NONCE = '';
  LAST_FAC_ROSTER_SIG = '';
  LAST_CR_ROSTER_SIG = '';
  await refreshSessionMonitorData(sessionId, mode);
  CLOCK_TIMER = setInterval(() => {
    const nowStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    const el = document.getElementById(mode === 'cr' ? 'cr-qr-clock' : 'fac-qr-clock');
    if (el) el.textContent = nowStr;
    const pClock = document.getElementById('proj-clock');
    if (pClock) pClock.textContent = nowStr;
  }, 1000);
  QR_ROTATE_TIMER = setInterval(async () => {
    if (QR_PAUSED || document.hidden) return;
    const r = await api('rotate_nonce', { session_id: sessionId });
    if (r.ok) {
      LAST_RENDERED_NONCE = `${sessionId}:${r.nonce}`;
      renderQrElement(mode === 'cr' ? 'cr-qr-box' : 'fac-qr-box', sessionId, r.nonce);
      if (!document.getElementById('modal-projector').classList.contains('hidden')) {
        renderQrElement('proj-qr-box', sessionId, r.nonce, 300);
      }
    }
  }, (Number(SETTINGS.qr_interval_seconds) || 15) * 1000);
  const pollMs = Math.max(2, Number(SETTINGS.poll_interval_seconds) || 4) * 1000;
  ROSTER_POLL_TIMER = setInterval(() => {
    if (!document.hidden) pollSessionScansOnly(sessionId, mode);
  }, pollMs);
}

async function pollSessionScansOnly(sessionId, mode) {
  const res = await api('session_scans', { session_id: sessionId });
  if (!res.ok) return;
  const recMap = Object.fromEntries((res.records || []).map(r => [r.student_id, r]));
  const stateObj = mode === 'cr' ? CR_STATE : FAC_STATE;
  if (!stateObj.liveSession || stateObj.liveSession.id !== sessionId) return;

  stateObj.liveSession.is_active = res.session.is_active;
  stateObj.liveSession.manual_headcount = res.session.manual_headcount;

  const updatedRoster = (stateObj.roster || []).map(st => ({
    ...st,
    status: recMap[st.id]?.status || 'A',
    marked_via: recMap[st.id]?.marked_via || null
  }));
  stateObj.roster = updatedRoster;
  const qrCount = updatedRoster.filter(r => r.status === 'P' && r.marked_via === 'QR').length;
  stateObj.qrCount = qrCount;
  const scannedCount = updatedRoster.filter(r => r.status === 'P' || r.status === 'OD').length;
  const sig = updatedRoster.map(r => `${r.id}:${r.status}:${r.marked_via || ''}`).join('|');

  if (mode === 'cr') {
    if (sig !== LAST_CR_ROSTER_SIG) {
      LAST_CR_ROSTER_SIG = sig;
      document.getElementById('cr-scan-count').textContent = scannedCount;
      renderGroupedRollPills('cr-roll-pills', updatedRoster);
    }
    const hcInp = document.getElementById('cr-headcount-input');
    updateHeadcountUI('cr', qrCount, hcInp ? hcInp.value : res.session.manual_headcount);
    const markBtn = document.getElementById('btn-cr-mark-self');
    const selfDone = updatedRoster.some(r => r.id === CURRENT_USER?.id && (r.status === 'P' || r.status === 'OD'));
    markBtn.disabled = !(res.session.is_active && qrCount >= 2 && !selfDone);
    markBtn.textContent = selfDone ? 'My Attendance Marked ✓' : (qrCount < 2 ? `Mark My Attendance (Need ${2 - qrCount} QR scans)` : 'Mark My Attendance');
  } else {
    if (sig !== LAST_FAC_ROSTER_SIG) {
      LAST_FAC_ROSTER_SIG = sig;
      document.getElementById('fac-scan-count').textContent = scannedCount;
      renderGroupedRollPills('fac-roll-pills', updatedRoster);
      renderLiveRoster();
    }
    const hcInp = document.getElementById('fac-headcount-input');
    updateHeadcountUI('fac', qrCount, hcInp ? hcInp.value : res.session.manual_headcount);
  }
}

async function refreshSessionMonitorData(sessionId, mode) {
  const res = await api('session_roster', { session_id: sessionId });
  if (!res.ok) return;
  const s = res.session; const roster = res.roster || []; const qrCount = Number(res.qr_count || 0);
  const scannedCount = roster.filter(r => r.status === 'P' || r.status === 'OD').length;

  if (mode === 'cr') {
    CR_STATE.liveSession = s; CR_STATE.roster = roster; CR_STATE.qrCount = qrCount;
    document.getElementById('cr-live-panel').classList.remove('hidden');
    document.getElementById('cr-live-code').textContent = s.session_code;
    document.getElementById('cr-live-title').textContent = `${s.subject_name} · ${s.class_label}`;
    if (LAST_RENDERED_NONCE !== `${s.id}:${s.current_nonce}`) {
      LAST_RENDERED_NONCE = `${s.id}:${s.current_nonce}`;
      renderQrElement('cr-qr-box', s.id, s.current_nonce);
    }
    const crSig = roster.map(r => `${r.id}:${r.status}:${r.marked_via || ''}`).join('|');
    if (crSig !== LAST_CR_ROSTER_SIG) {
      LAST_CR_ROSTER_SIG = crSig;
      document.getElementById('cr-scan-count').textContent = scannedCount;
      renderGroupedRollPills('cr-roll-pills', roster);
    }

    const hcInp = document.getElementById('cr-headcount-input');
    if (hcInp && document.activeElement !== hcInp && s.manual_headcount != null) hcInp.value = s.manual_headcount;
    updateHeadcountUI('cr', qrCount, hcInp ? hcInp.value : s.manual_headcount);

    const markBtn = document.getElementById('btn-cr-mark-self');
    const selfDone = roster.some(r => r.id === CURRENT_USER?.id && (r.status === 'P' || r.status === 'OD'));
    markBtn.disabled = !(s.is_active && qrCount >= 2 && !selfDone);
    markBtn.textContent = selfDone ? 'My Attendance Marked ✓' : (qrCount < 2 ? `Mark My Attendance (Need ${2 - qrCount} QR scans)` : 'Mark My Attendance');
  } else {
    FAC_STATE.liveSession = s; FAC_STATE.roster = roster; FAC_STATE.qrCount = qrCount;
    document.getElementById('fac-live-panel').classList.remove('hidden');
    document.getElementById('fac-live-code').textContent = s.session_code;
    document.getElementById('fac-live-title').textContent = `${s.subject_name} (${s.subject_code}) · ${s.class_label}`;
    document.getElementById('fac-geo-toggle').checked = s.geofence_override === true || (s.geofence_override === null && Boolean(SETTINGS.geofence_enabled));
    if (LAST_RENDERED_NONCE !== `${s.id}:${s.current_nonce}`) {
      LAST_RENDERED_NONCE = `${s.id}:${s.current_nonce}`;
      renderQrElement('fac-qr-box', s.id, s.current_nonce);
    }
    const facSig = roster.map(r => `${r.id}:${r.status}:${r.marked_via || ''}`).join('|');
    if (facSig !== LAST_FAC_ROSTER_SIG) {
      LAST_FAC_ROSTER_SIG = facSig;
      document.getElementById('fac-scan-count').textContent = scannedCount;
      renderGroupedRollPills('fac-roll-pills', roster);
      renderLiveRoster();
    }

    const hcInp = document.getElementById('fac-headcount-input');
    if (hcInp && document.activeElement !== hcInp && s.manual_headcount != null) hcInp.value = s.manual_headcount;
    updateHeadcountUI('fac', qrCount, hcInp ? hcInp.value : s.manual_headcount);
  }
}

function updateHeadcountUI(prefix, qrCount, manualVal) {
  document.getElementById(`${prefix}-qr-headcount`).textContent = String(qrCount);
  const badge = document.getElementById(`${prefix}-headcount-status`);
  if (manualVal === '' || manualVal == null) { badge.textContent = 'Enter Count'; badge.className = 'pill blue'; return; }
  const m = Number(manualVal);
  if (m === Number(qrCount)) { badge.textContent = 'Verified ✓ (Match)'; badge.className = 'pill green'; }
  else { const d = m - Number(qrCount); badge.textContent = `Diff: ${d > 0 ? '+' + d : d}`; badge.className = 'pill amber'; }
}

async function saveHeadcount(prefix) {
  const session = prefix === 'cr' ? CR_STATE.liveSession : FAC_STATE.liveSession;
  if (!session) return;
  const val = document.getElementById(`${prefix}-headcount-input`).value;
  const r = await api('set_manual_headcount', { session_id: session.id, manual_headcount: val === '' ? null : Number(val) });
  if (!r.ok) return toast(r.error, true);
  updateHeadcountUI(prefix, prefix === 'cr' ? CR_STATE.qrCount : FAC_STATE.qrCount, val);
  toast('Manual headcount saved.');
}

function renderLiveRoster() {
  const q = (document.getElementById('fac-roster-search')?.value || '').trim().toLowerCase();
  const list = (FAC_STATE.roster || []).filter(st =>
    !q || (st.roll_no || '').toLowerCase().includes(q) || (st.enrollment_no || '').toLowerCase().includes(q) || (st.full_name || '').toLowerCase().includes(q) || (st.class_code || '').toLowerCase().includes(q)
  );
  document.getElementById('fac-manual-tbody').innerHTML = list.map(st => `
    <tr>
      <td class="mono"><strong>${st.roll_no || '-'}</strong> <span style="color:var(--text-mute);">(${st.enrollment_no || '-'})</span></td>
      <td><strong>${st.full_name}</strong> ${st.role === 'cr' ? '<span class="pill amber">CR</span>' : ''}</td>
      <td>${st.class_code || st.class_name || '-'}</td>
      <td><input type="checkbox" ${st.status === 'P' ? 'checked' : ''} onchange="onFacultyManualTick('${st.id}','P',this.checked)" style="width:17px;height:17px;cursor:pointer;"></td>
      <td><input type="checkbox" ${st.status === 'OD' ? 'checked' : ''} onchange="onFacultyManualTick('${st.id}','OD',this.checked)" style="width:17px;height:17px;cursor:pointer;"></td>
      <td><span class="pill ${st.status === 'P' ? 'green' : st.status === 'OD' ? 'amber' : 'red'}">${st.status}</span></td>
    </tr>
  `).join('');
}

async function onFacultyManualTick(studentId, targetStatus, checked) {
  if (!FAC_STATE.liveSession) return;
  const nextStatus = checked ? targetStatus : 'A';
  const row = (FAC_STATE.roster || []).find(st => st.id === studentId);
  const prevStatus = row ? row.status : 'A';
  const prevVia = row ? row.marked_via : null;
  if (row) {
    row.status = nextStatus;
    row.marked_via = nextStatus === 'A' ? null : 'MANUAL';
    LAST_FAC_ROSTER_SIG = FAC_STATE.roster.map(r => `${r.id}:${r.status}:${r.marked_via || ''}`).join('|');
    document.getElementById('fac-scan-count').textContent = FAC_STATE.roster.filter(r => r.status === 'P' || r.status === 'OD').length;
    renderGroupedRollPills('fac-roll-pills', FAC_STATE.roster);
    renderLiveRoster();
  }
  const r = await api('set_student_tick', { session_id: FAC_STATE.liveSession.id, student_id: studentId, status: nextStatus });
  if (!r.ok) {
    if (row) { row.status = prevStatus; row.marked_via = prevVia; renderGroupedRollPills('fac-roll-pills', FAC_STATE.roster); renderLiveRoster(); }
    return toast(r.error, true);
  }
}

async function closeActiveSession() {
  const s = CURRENT_USER?.role === 'cr' ? CR_STATE.liveSession : FAC_STATE.liveSession;
  if (!s) return;
  await api('close_session', { session_id: s.id });
  clearSessionLoops();
  closeModal('modal-projector');
  toast('Session closed.');
  if (CURRENT_USER?.role === 'cr') { CR_STATE.liveSession = null; document.getElementById('cr-live-panel').classList.add('hidden'); await loadCRTodayLectures(true); }
  else { FAC_STATE.liveSession = null; document.getElementById('fac-live-panel').classList.add('hidden'); }
}

// ================= ADMIN PORTAL (LAZY TABS) =================
async function switchAdminTab(tab) {
  CURRENT_ADMIN_TAB = tab;
  ['dashboard', 'users', 'academics', 'sessions', 'export', 'devices', 'performance', 'settings'].forEach(t => document.getElementById(`adm-tab-${t}`).classList.toggle('active', t === tab));
  document.querySelectorAll('[data-adm-tab]').forEach(b => b.classList.toggle('active', b.dataset.admTab === tab));
  document.getElementById('adm-sidebar').classList.remove('open');
  const titles = {
    dashboard: 'Dashboard <span>Overview</span>', users: 'Users, CRs <span>& Bulk CSV</span>',
    academics: 'Classes <span>& Timetable Matrix</span>', sessions: 'Live Sessions <span>& Proxy</span>',
    export: 'Export <span>Attendance Reports</span>', devices: 'Devices <span>& Audit Logs</span>', performance: 'Performance <span>& Timers</span>', settings: 'System <span>Settings & Geofence</span>'
  };
  document.getElementById('adm-page-title').innerHTML = titles[tab] || tab;
  if (tab === 'dashboard' && !LOADED_TABS.admDashboard) await loadAdminDashboard(false);
  else if (tab === 'users' && !LOADED_TABS.admUsers) await loadAdminUsers(false);
  else if (tab === 'academics' && !LOADED_TABS.admAcademics) await loadAdminAcademics(false);
  else if (tab === 'sessions' && !LOADED_TABS.admSessions) await loadAdminSessions(false);
  else if (tab === 'export' && !LOADED_TABS.admExport) await loadAdminExportSetup();
  else if (tab === 'devices' && !LOADED_TABS.admDevices) await loadAdminDevicesLogs(false);
  else if (tab === 'performance') { populateAdminPerformanceForm(); }
  else if (tab === 'settings') { populateAdminSettingsForm(); loadClassGeoList(); }
}

async function refreshCurrentAdminTab() {
  if (CURRENT_ADMIN_TAB === 'dashboard') await loadAdminDashboard(true);
  else if (CURRENT_ADMIN_TAB === 'users') await loadAdminUsers(true);
  else if (CURRENT_ADMIN_TAB === 'academics') await loadAdminAcademics(true);
  else if (CURRENT_ADMIN_TAB === 'sessions') await loadAdminSessions(true);
  else if (CURRENT_ADMIN_TAB === 'export') await loadAdminExportSetup(true);
  else if (CURRENT_ADMIN_TAB === 'devices') await loadAdminDevicesLogs(true);
  else if (CURRENT_ADMIN_TAB === 'settings') await loadClassGeoList();
  toast('Tab refreshed!');
}

async function loadAdminDashboard(force = false) {
  if (LOADED_TABS.admDashboard && !force) return;
  const res = await api('admin_dashboard_summary');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admDashboard = true;
  ADM_STATE.breakdown = res.class_breakdown || [];
  const k = res.kpis || {};
  document.getElementById('adm-kpi-stu').textContent = k.total_students ?? 0;
  document.getElementById('adm-kpi-fac').textContent = k.total_faculty ?? 0;
  document.getElementById('adm-kpi-cls').textContent = k.total_classes ?? 0;
  document.getElementById('adm-kpi-live').textContent = k.live_sessions ?? 0;
  document.getElementById('adm-live-badge').textContent = k.live_sessions ?? 0;
  document.getElementById('adm-leg-p').textContent = k.total_p ?? 0;
  document.getElementById('adm-leg-od').textContent = k.total_od ?? 0;
  document.getElementById('adm-leg-dev').textContent = k.pending_devices ?? 0;

  const avgPct = ADM_STATE.breakdown.length
    ? Math.round(ADM_STATE.breakdown.reduce((a, b) => a + Number(b.present_pct || 0), 0) / ADM_STATE.breakdown.length)
    : 0;
  document.getElementById('adm-donut-pct').textContent = `${avgPct}%`;
  document.getElementById('adm-donut-arc').setAttribute('stroke-dashoffset', String(251.2 - (251.2 * avgPct) / 100));

  document.getElementById('adm-class-bar-chart').innerHTML = ADM_STATE.breakdown.length
    ? ADM_STATE.breakdown.map(b => `
      <div class="bar-wrap">
        <div class="bar ${b.present_pct >= 75 ? 'green' : 'amber'}" style="height:${Math.max(8, b.present_pct)}%" title="${b.class_code}: ${b.present_pct}%"></div>
        <span class="bar-label">${b.class_code}</span>
      </div>
    `).join('')
    : '<p style="color:var(--text-mute);font-size:0.8rem;">No class data yet.</p>';

  document.getElementById('adm-breakdown-tbody').innerHTML = ADM_STATE.breakdown.length ? ADM_STATE.breakdown.map(b => `
    <tr>
      <td><strong>${b.class_name}</strong> <span class="mono" style="color:var(--accent);">(${b.class_code})</span></td>
      <td>${b.total_students}</td><td>${b.lectures_held}</td>
      <td><strong style="color:var(--green);">${b.present_pct}%</strong></td>
      <td><strong style="color:var(--amber);">${b.od_pct}%</strong></td>
      <td><strong style="color:var(--red);">${b.absent_pct}%</strong></td>
      <td><span class="pill ${b.defaulters_count > 0 ? 'red' : 'green'}">${b.defaulters_count}</span></td>
    </tr>
  `).join('') : '<tr><td colspan="7" style="text-align:center;">No classes created yet.</td></tr>';
}

async function loadAdminUsers(force = false) {
  if (LOADED_TABS.admUsers && !force) return;
  const res = await api('admin_tab_users');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admUsers = true;
  ADM_STATE.users = res.users || []; ADM_STATE.classes = res.classes || [];
  const opts = '<option value="">-- No Class --</option>' + ADM_STATE.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  document.getElementById('new-u-class').innerHTML = opts;
  document.getElementById('eu-class').innerHTML = opts;
  renderAdminUsersTable();
}

function renderAdminUsersTable() {
  const q = (document.getElementById('adm-user-search')?.value || '').trim().toLowerCase();
  const rf = document.getElementById('adm-user-role-filter')?.value || 'ALL';
  const rows = (ADM_STATE.users || []).filter(u => (rf === 'ALL' || u.role === rf) && (!q || (u.full_name || '').toLowerCase().includes(q) || (u.enrollment_no || '').toLowerCase().includes(q) || (u.roll_no || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.faculty_code || '').toLowerCase().includes(q)));
  document.getElementById('adm-users-tbody').innerHTML = rows.length ? rows.map(u => {
    const pCls = u.role === 'cr' ? 'amber' : u.role === 'faculty' ? 'blue' : u.role === 'admin' ? 'purple' : 'green';
    const ids = [u.faculty_code ? `<b>${u.faculty_code}</b>` : '', u.enrollment_no ? `Enroll: <b>${u.enrollment_no}</b>` : '', u.roll_no ? `Roll: <b>${u.roll_no}</b>` : '', u.email || ''].filter(Boolean).join(' · ');
    return `
      <tr>
        <td><span class="pill ${pCls}">${u.role.toUpperCase()}</span></td>
        <td><strong>${u.full_name}</strong></td>
        <td>${ids || '-'}</td>
        <td>${u.classes?.name || '-'}</td>
        <td style="white-space:nowrap;">
          <button type="button" onclick="openEditUserById('${u.id}')" class="btn btn-ghost" style="padding:5px 10px;">Edit</button>
          ${!u.is_super_admin ? `<button type="button" onclick="deleteAdminEntity('users','${u.id}')" class="btn btn-danger" style="padding:5px 10px;">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="5" style="text-align:center;">No users found.</td></tr>';
}

async function createAdminUser() {
  const full_name = document.getElementById('new-u-name').value.trim();
  if (!full_name) return toast('Enter full name.', true);
  const res = await api('admin_create_user', {
    role: document.getElementById('new-u-role').value, full_name,
    enrollment_no: document.getElementById('new-u-enroll').value.trim() || null,
    roll_no: document.getElementById('new-u-roll').value.trim() || null,
    email: document.getElementById('new-u-email').value.trim() || null,
    class_id: document.getElementById('new-u-class').value || null
  });
  if (!res.ok) return toast(res.error, true);
  ['new-u-name', 'new-u-enroll', 'new-u-roll', 'new-u-email'].forEach(id => { document.getElementById(id).value = ''; });
  toast('User added!'); LOADED_TABS.admDashboard = false; await loadAdminUsers(true);
}

function toggleFacultyPermsBox() {
  const role = document.getElementById('eu-role').value;
  document.getElementById('eu-fac-perms-box').classList.toggle('hidden', role !== 'faculty');
}

function openEditUserById(id) {
  const u = (ADM_STATE.users || []).find(x => x.id === id);
  if (!u) return;
  document.getElementById('eu-id').value = u.id; document.getElementById('eu-role').value = u.role;
  document.getElementById('eu-name').value = u.full_name || ''; document.getElementById('eu-enroll').value = u.enrollment_no || '';
  document.getElementById('eu-roll').value = u.roll_no || ''; document.getElementById('eu-email').value = u.email || '';
  document.getElementById('eu-class').value = u.class_id || ''; document.getElementById('eu-pass').value = '';
  document.getElementById('eu-active').checked = u.is_active !== false; document.getElementById('eu-reset-dev').checked = false;

  const fp = u.faculty_permissions || {};
  document.getElementById('fp-regular').checked = fp.can_start_regular !== false;
  document.getElementById('fp-extra').checked = fp.can_start_extra !== false;
  document.getElementById('fp-od').checked = fp.can_mark_od !== false;
  document.getElementById('fp-edit').checked = fp.can_edit_attendance !== false;
  document.getElementById('fp-gps').checked = fp.can_toggle_gps !== false;
  document.getElementById('fp-export').checked = fp.can_export_reports !== false;
  toggleFacultyPermsBox();
  openModal('modal-edit-user');
}

async function saveEditedUser() {
  const role = document.getElementById('eu-role').value;
  const faculty_permissions = role === 'faculty' ? {
    can_start_regular: document.getElementById('fp-regular').checked,
    can_start_extra: document.getElementById('fp-extra').checked,
    can_mark_od: document.getElementById('fp-od').checked,
    can_edit_attendance: document.getElementById('fp-edit').checked,
    can_toggle_gps: document.getElementById('fp-gps').checked,
    can_export_reports: document.getElementById('fp-export').checked
  } : undefined;

  const res = await api('admin_update_user', {
    user_id: document.getElementById('eu-id').value, role,
    full_name: document.getElementById('eu-name').value, enrollment_no: document.getElementById('eu-enroll').value,
    roll_no: document.getElementById('eu-roll').value, email: document.getElementById('eu-email').value,
    class_id: document.getElementById('eu-class').value || null, new_password: document.getElementById('eu-pass').value,
    is_active: document.getElementById('eu-active').checked, reset_device: document.getElementById('eu-reset-dev').checked,
    faculty_permissions
  });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-edit-user'); toast('User updated!'); LOADED_TABS.admDashboard = false; await loadAdminUsers(true);
}

function openSubAdminModal() { ['sa-name', 'sa-email', 'sa-pass'].forEach(id => { document.getElementById(id).value = ''; }); openModal('modal-subadmin'); }

async function saveNewSubAdmin() {
  const r = await api('admin_save_subadmin_perms', {
    full_name: document.getElementById('sa-name').value, email: document.getElementById('sa-email').value,
    password: document.getElementById('sa-pass').value,
    admin_permissions: {
      manage_users: document.getElementById('sap-users').checked,
      manage_academics: document.getElementById('sap-acad').checked,
      manage_timetable: document.getElementById('sap-tt').checked,
      assign_proxy: document.getElementById('sap-proxy').checked,
      approve_devices: document.getElementById('sap-dev').checked,
      manage_geofence: document.getElementById('sap-geo').checked,
      manage_settings: document.getElementById('sap-set').checked,
      view_reports: document.getElementById('sap-rep').checked,
      manage_admins: document.getElementById('sap-adm').checked
    }
  });
  if (!r.ok) return toast(r.error, true);
  closeModal('modal-subadmin'); toast('Sub-Admin created!'); await loadAdminUsers(true);
}

// Bulk CSV Helpers
function loadCsvIntoTextarea(e, targetId) {
  const f = e.target.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById(targetId).value = ev.target.result; };
  reader.readAsText(f);
}
function parseCsvRow(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}
function parseCsvLines(text) {
  return String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(l => {
    if (!l) return false;
    const first = parseCsvRow(l)[0]?.toLowerCase() || '';
    return first !== 'role' && first !== 'class_code';
  });
}
function downloadCsvFile(filename, rows) {
  const csv = rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = filename; a.click();
}
function downloadSampleUsersCsv() {
  downloadCsvFile('sample_users_v8.csv', [
    ['role', 'enrollment_no', 'roll_no', 'full_name', 'email', 'class_code', 'password'],
    ['student', '240303105001', '1', 'Aarav Mehta', 'aarav@college.edu', 'CLS-001', 'Pass@123'],
    ['cr', '240303105002', '2', 'Priya Nair', 'priya@college.edu', 'CLS-001', 'Pass@123'],
    ['faculty', '', '', 'Dr. Sharma', 'sharma@college.edu', '', 'Pass@123']
  ]);
}
function downloadSampleTtCsv() {
  downloadCsvFile('sample_timetable_v8.csv', [
    ['class_code', 'subject_code', 'faculty_email', 'day_of_week', 'start_time', 'end_time'],
    ['CLS-001', 'SUB-001', 'sharma@college.edu', 'Monday', '09:00', '10:00'],
    ['CLS-001+CLS-002', 'SUB-002', 'sharma@college.edu', 'Tuesday', '10:00', '11:00']
  ]);
}
async function submitBulkUsers() {
  const lines = parseCsvLines(document.getElementById('bulk-users-csv').value);
  const rows = lines.map(line => {
    const [role, enrollment_no, roll_no, full_name, email, class_code, password] = parseCsvRow(line);
    return { role, enrollment_no, roll_no, full_name, email, class_code, password };
  });
  const res = await api('admin_bulk_import_users', { rows });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-bulk-users');
  toast(`Imported ${res.imported} users!` + (res.errors?.length ? ` (${res.errors.length} skipped)` : ''));
  LOADED_TABS.admDashboard = false; await loadAdminUsers(true);
}
async function submitBulkTimetable() {
  const lines = parseCsvLines(document.getElementById('bulk-tt-csv').value);
  const rows = lines.map(line => {
    const [class_code, subject_code, faculty_email, day_of_week, start_time, end_time] = parseCsvRow(line);
    return { class_code, subject_code, faculty_email, day_of_week, start_time, end_time };
  });
  const res = await api('admin_bulk_import_timetable', { rows });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-bulk-tt');
  const autoNote = (res.created_classes || res.created_subjects) ? ` (Auto-created ${res.created_classes || 0} classes, ${res.created_subjects || 0} subjects)` : '';
  toast(`Imported ${res.imported} slots!${autoNote}` + (res.errors?.length ? ` (${res.errors.length} skipped)` : ''));
  await loadAdminAcademics(true);
}

// Admin Tab 3: Academics & Timetable Matrix
async function loadAdminAcademics(force = false) {
  if (LOADED_TABS.admAcademics && !force) return;
  const res = await api('admin_tab_academics');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admAcademics = true;
  ADM_STATE.classes = res.classes || []; ADM_STATE.subjects = res.subjects || [];
  ADM_STATE.slots = res.slots || []; ADM_STATE.faculty = res.faculty || [];

  document.getElementById('adm-classes-list').innerHTML = ADM_STATE.classes.map(c => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:10px;background:var(--bg-3);border:1px solid var(--border);">
      <div><span class="mono" style="color:var(--accent);margin-right:8px;">${c.code}</span><strong>${c.name}</strong></div>
      <button type="button" onclick="deleteAdminEntity('classes','${c.id}')" class="btn btn-danger" style="padding:4px 10px;">Delete</button>
    </div>
  `).join('');

  document.getElementById('adm-subjects-list').innerHTML = ADM_STATE.subjects.map(s => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:10px;background:var(--bg-3);border:1px solid var(--border);">
      <div><span class="mono" style="color:var(--green);margin-right:8px;">${s.code}</span><strong>${s.name}</strong></div>
      <button type="button" onclick="deleteAdminEntity('subjects','${s.id}')" class="btn btn-danger" style="padding:4px 10px;">Delete</button>
    </div>
  `).join('');

  const mSel = document.getElementById('matrix-class-select');
  const prev = mSel.value;
  mSel.innerHTML = ADM_STATE.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  if (prev && ADM_STATE.classes.some(c => c.id === prev)) mSel.value = prev;
  document.getElementById('tt-subject').innerHTML = ADM_STATE.subjects.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
  document.getElementById('tt-faculty').innerHTML = ADM_STATE.faculty.map(f => `<option value="${f.id}">${f.faculty_code ? '[' + f.faculty_code + '] ' : ''}${f.full_name}</option>`).join('');
  document.getElementById('tt-merged-classes').innerHTML = ADM_STATE.classes.map(c => `<option value="${c.id}">${c.code} - ${c.name}</option>`).join('');
  document.getElementById('tt-merged-classes').selectedIndex = -1;
  renderTimetableMatrix();
}

async function createAdminClass() {
  const res = await api('admin_create_class', { name: document.getElementById('new-cls-name').value, code: document.getElementById('new-cls-code').value });
  if (!res.ok) return toast(res.error, true);
  document.getElementById('new-cls-name').value = ''; document.getElementById('new-cls-code').value = '';
  toast(`Class created (${res.row?.code || 'Auto'})!`); LOADED_TABS.admDashboard = false; await loadAdminAcademics(true);
}

async function createAdminSubject() {
  const res = await api('admin_create_subject', { name: document.getElementById('new-sub-name').value, code: document.getElementById('new-sub-code').value });
  if (!res.ok) return toast(res.error, true);
  document.getElementById('new-sub-name').value = ''; document.getElementById('new-sub-code').value = '';
  toast(`Subject created (${res.row?.code || 'Auto'})!`); await loadAdminAcademics(true);
}

function resetTimetableForm() { document.getElementById('tt-edit-slot-id').value = ''; document.getElementById('tt-save-btn').textContent = 'Save Slot (New Version)'; }

async function saveTimetableSlot() {
  const selectedClassId = document.getElementById('matrix-class-select').value;
  const merged = [...document.getElementById('tt-merged-classes').selectedOptions].map(o => o.value);
  const classIds = [...new Set([selectedClassId, ...merged].filter(Boolean))];
  if (!classIds.length) return toast('Select a class first.', true);
  const res = await api('admin_save_timetable_slot', {
    slot_id: document.getElementById('tt-edit-slot-id').value || null,
    class_id: selectedClassId, class_ids: classIds,
    day_of_week: Number(document.getElementById('tt-day').value),
    start_time: document.getElementById('tt-start').value, end_time: document.getElementById('tt-end').value,
    subject_id: document.getElementById('tt-subject').value, faculty_id: document.getElementById('tt-faculty').value
  });
  if (!res.ok) return toast(res.error, true);
  resetTimetableForm(); toast(`Slot saved (v${res.version_no || 1})!`); await loadAdminAcademics(true);
}

function renderTimetableMatrix() {
  const classId = document.getElementById('matrix-class-select')?.value;
  const days = [{ d: 1, l: 'Mon' }, { d: 2, l: 'Tue' }, { d: 3, l: 'Wed' }, { d: 4, l: 'Thu' }, { d: 5, l: 'Fri' }, { d: 6, l: 'Sat' }];
  const cur = (ADM_STATE.slots || []).filter(sl => sl.is_current !== false && (!classId || (sl.class_ids || [sl.class_id]).includes(classId)));
  const wins = [...new Set(['09:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-13:00', '14:00-15:00', '15:00-16:00', ...cur.map(s => `${s.start_time}-${s.end_time}`)])].sort();
  document.getElementById('tt-matrix-head').innerHTML = `<tr><th>Time</th>${days.map(x => `<th>${x.l}</th>`).join('')}</tr>`;
  document.getElementById('tt-matrix-body').innerHTML = wins.map(w => {
    const [st, et] = w.split('-');
    return `<tr><td class="mono" style="white-space:nowrap;">${w}</td>${days.map(day => {
      const m = cur.find(sl => Number(sl.day_of_week) === day.d && `${sl.start_time}-${sl.end_time}` === w);
      if (!m) return `<td><button type="button" onclick="prefillMatrixSlot(${day.d},'${st}','${et}')" class="btn btn-ghost" style="width:100%;padding:6px;font-size:0.7rem;">+ Slot</button></td>`;
      return `<td><div style="padding:8px;border-radius:8px;background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.28);">
        <div style="font-weight:700;color:var(--text);font-size:0.78rem;">${m.subject_name} ${(m.class_ids || []).length > 1 ? '<span class="pill purple">MERGED</span>' : ''}</div>
        <div style="font-size:0.68rem;color:var(--text-dim);">${m.faculty_name} · v${m.version_no || 1}</div>
        <div style="margin-top:4px;display:flex;gap:8px;">
          <button type="button" onclick="editMatrixSlotById('${m.id}')"  style="background:none;border:none;color:var(--accent);font-size:0.7rem;font-weight:700;cursor:pointer;">Edit</button>
          <button type="button" onclick="deleteAdminEntity('timetable_slots','${m.id}')" style="background:none;border:none;color:var(--red);font-size:0.7rem;font-weight:700;cursor:pointer;">Del</button>
        </div>
      </div></td>`;
    }).join('')}</tr>`;
  }).join('');
}

function prefillMatrixSlot(d, st, et) {
  document.getElementById('tt-edit-slot-id').value = '';
  document.getElementById('tt-day').value = String(d); document.getElementById('tt-start').value = st; document.getElementById('tt-end').value = et;
  toast(`Selected ${st}–${et}. Pick Subject & Faculty, then Save.`);
}

function editMatrixSlotById(slotId) {
  const sl = (ADM_STATE.slots || []).find(x => x.id === slotId);
  if (!sl) return;
  document.getElementById('tt-edit-slot-id').value = sl.id;
  document.getElementById('tt-day').value = String(sl.day_of_week);
  document.getElementById('tt-start').value = sl.start_time; document.getElementById('tt-end').value = sl.end_time;
  document.getElementById('tt-subject').value = sl.subject_id; document.getElementById('tt-faculty').value = sl.faculty_id;
  document.getElementById('tt-save-btn').textContent = `Update Slot (v${Number(sl.version_no || 1) + 1})`;
  toast('Editing slot — saving creates a new version.');
}

// Admin Tab 4: Sessions & Proxy
async function loadAdminSessions(force = false) {
  if (LOADED_TABS.admSessions && !force) return;
  const res = await api('admin_tab_sessions_reports');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admSessions = true;
  ADM_STATE.sessions = res.sessions || []; ADM_STATE.classes = res.classes || [];
  ADM_STATE.students = res.students || []; ADM_STATE.records = res.records || [];
  document.getElementById('proxy-class').innerHTML = (res.classes || []).map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  document.getElementById('proxy-subject').innerHTML = (res.subjects || []).map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
  document.getElementById('proxy-faculty').innerHTML = (res.faculty || []).map(f => `<option value="${f.id}">${f.full_name}</option>`).join('');
  document.getElementById('adm-sessions-tbody').innerHTML = ADM_STATE.sessions.length ? ADM_STATE.sessions.map(s => `
    <tr>
      <td class="mono" style="color:var(--accent);">${s.session_code}</td>
      <td class="mono">${s.session_date}</td>
      <td><strong>${s.class_label}</strong></td>
      <td>${s.subject_name}</td><td>${s.faculty_name}</td>
      <td class="mono">${s.manual_headcount ?? '-'}</td>
      <td><span class="pill ${s.is_active ? 'green' : 'blue'}">${s.is_active ? 'LIVE' : 'CLOSED'}</span></td>
      <td>${s.is_active ? `<button type="button" onclick="forceCloseAdminSession('${s.id}')" class="btn btn-danger" style="padding:4px 10px;">Close</button>` : '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="8" style="text-align:center;">No sessions yet.</td></tr>';
}

async function assignProxySession() {
  const res = await api('admin_assign_proxy', {
    class_id: document.getElementById('proxy-class').value,
    subject_id: document.getElementById('proxy-subject').value,
    substitute_faculty_id: document.getElementById('proxy-faculty').value
  });
  if (!res.ok) return toast(res.error, true);
  toast(`Proxy ${res.session?.session_code || ''} started!`); LOADED_TABS.admDashboard = false; await loadAdminSessions(true);
}

async function forceCloseAdminSession(id) {
  await api('close_session', { session_id: id });
  toast('Session closed.'); LOADED_TABS.admDashboard = false; await loadAdminSessions(true);
}

// Admin Tab 5: Export Attendance Reports
async function loadAdminExportSetup(force = false) {
  if (LOADED_TABS.admExport && !force) return;
  const res = await api('admin_tab_sessions_reports');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admExport = true;
  ADM_STATE.sessions = res.sessions || []; ADM_STATE.classes = res.classes || [];
  ADM_STATE.students = res.students || []; ADM_STATE.records = res.records || [];
  document.getElementById('exp-class').innerHTML = '<option value="">All Classes</option>' + ADM_STATE.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
}

function generateAdminExport() {
  const clsId = document.getElementById('exp-class').value;
  const fromDate = document.getElementById('exp-from').value;
  const toDate = document.getElementById('exp-to').value;
  const fmt = document.getElementById('exp-format').value;

  const clsMap = Object.fromEntries((ADM_STATE.classes || []).map(c => [c.id, c]));
  const sessions = (ADM_STATE.sessions || []).filter(s => {
    const cIds = s.class_ids || [s.class_id];
    if (clsId && !cIds.includes(clsId)) return false;
    if (fromDate && s.session_date < fromDate) return false;
    if (toDate && s.session_date > toDate) return false;
    return true;
  });
  const students = (ADM_STATE.students || []).filter(st => !clsId || st.class_id === clsId);
  const recMap = new Map((ADM_STATE.records || []).map(r => [`${r.session_id}_${r.student_id}`, r]));

  let headers = [], rows = [];
  if (fmt === 'summary') {
    headers = ['Class', 'Roll No', 'Enrollment', 'Name', 'Present/OD', 'Total Lectures', '%', 'Status'];
    rows = students.map(st => {
      const mySess = sessions.filter(x => (x.class_ids || [x.class_id]).includes(st.class_id));
      const att = mySess.filter(x => recMap.has(`${x.id}_${st.id}`)).length;
      const pct = mySess.length ? Math.round((att / mySess.length) * 100) : 0;
      return [clsMap[st.class_id]?.code || '-', st.roll_no || '-', st.enrollment_no || '-', st.full_name, att, mySess.length, pct + '%', pct < 75 ? 'Defaulter' : 'Eligible'];
    });
  } else if (fmt === 'matrix') {
    headers = ['Class', 'Roll No', 'Name', ...sessions.map(x => `${x.session_date} (${x.subject_code || x.subject_name})`), '%'];
    rows = students.map(st => {
      let p = 0;
      const marks = sessions.map(x => { const r = recMap.get(`${x.id}_${st.id}`); if (r) { p++; return r.status; } return 'A'; });
      return [clsMap[st.class_id]?.code || '-', st.roll_no || '-', st.full_name, ...marks, (sessions.length ? Math.round((p / sessions.length) * 100) : 0) + '%'];
    });
  } else {
    headers = ['Session ID', 'Date', 'Class', 'Subject', 'Roll No', 'Student', 'Status', 'Method'];
    const stuMap = new Map(students.map(s => [s.id, s]));
    const sesMap = new Map(sessions.map(s => [s.id, s]));
    rows = (ADM_STATE.records || []).filter(r => sesMap.has(r.session_id) && stuMap.has(r.student_id)).map(r => {
      const s = stuMap.get(r.student_id); const x = sesMap.get(r.session_id);
      return [x.session_code, x.session_date, clsMap[s.class_id]?.code || '-', x.subject_name, s.roll_no || '-', s.full_name, r.status, r.marked_via || 'QR'];
    });
  }

  LAST_EXPORT_ROWS = [headers, ...rows];
  document.getElementById('exp-meta').textContent = `Report: ${fmt.toUpperCase()} · ${rows.length} rows · Generated ${new Date().toLocaleString()}`;
  document.getElementById('exp-preview-table').innerHTML =
    `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
  ['btn-exp-csv', 'btn-exp-copy', 'btn-exp-print', 'print-export-area'].forEach(id => document.getElementById(id).classList.remove('hidden'));
}

function downloadAdminExportCsv() { if (LAST_EXPORT_ROWS.length) downloadCsvFile('smartqr_attendance_export.csv', LAST_EXPORT_ROWS); }
function copyAdminExportTable() {
  if (!LAST_EXPORT_ROWS.length) return;
  navigator.clipboard?.writeText(LAST_EXPORT_ROWS.map(r => r.join('\t')).join('\n'));
  toast('Table copied for Excel!');
}

// Admin Tab 6: Devices & Logs
async function loadAdminDevicesLogs(force = false) {
  if (LOADED_TABS.admDevices && !force) return;
  const res = await api('admin_tab_devices_logs');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admDevices = true;
  document.getElementById('adm-dev-list').innerHTML = (res.device_requests || []).length ? res.device_requests.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding:12px;border-radius:10px;background:var(--bg-3);border:1px solid var(--border);">
      <div><strong>${r.student_name}</strong> (${r.roll_no}) · "${r.reason || '-'}" · <code class="mono">${r.new_device_fp}</code></div>
      <div style="display:flex;gap:8px;">
        <button type="button" onclick="reviewDeviceReq('${r.id}','APPROVED')" class="btn btn-green">Approve</button>
        <button type="button" onclick="reviewDeviceReq('${r.id}','REJECTED')" class="btn btn-danger">Reject</button>
      </div>
    </div>
  `).join('') : '<p style="color:var(--text-mute);font-size:0.82rem;">No pending device requests.</p>';
  document.getElementById('adm-logs-list').innerHTML = (res.logs || []).length ? res.logs.map(l => `
    <div style="padding:8px 10px;border-radius:8px;background:var(--bg-3);border:1px solid var(--border-2);display:flex;justify-content:space-between;gap:10px;"><div><strong style="color:var(--accent);">[${l.event_type}]</strong> ${l.details || ''}</div><span style="color:var(--text-mute);font-size:0.7rem;white-space:nowrap;">${l.created_at ? new Date(l.created_at).toLocaleString() : ''}</span></div>
  `).join('') : '<p style="color:var(--text-mute);">No logs yet.</p>';
}

async function reviewDeviceReq(id, decision) {
  const r = await api('admin_review_device_req', { request_id: id, decision });
  if (!r.ok) return toast(r.error, true);
  toast(`Request ${decision.toLowerCase()}.`); await loadAdminDevicesLogs(true);
}

// Admin Tab 7: Settings + Per-Class Geofence
function fillCurrentGps(latId, lngId) {
  if (!navigator.geolocation) return toast('Geolocation not supported.', true);
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById(latId).value = pos.coords.latitude.toFixed(6);
    document.getElementById(lngId).value = pos.coords.longitude.toFixed(6);
    toast('Current GPS coordinates captured!');
  }, () => toast('Location permission denied.', true), { enableHighAccuracy: true, timeout: 8000 });
}

function populateAdminPerformanceForm() {
  const qSec = SETTINGS.qr_interval_seconds || 15;
  const pSec = SETTINGS.poll_interval_seconds || 4;
  document.getElementById('perf-qr-timer').value = qSec;
  document.getElementById('perf-qr-val').textContent = qSec + 's';
  document.getElementById('perf-poll-timer').value = pSec;
  document.getElementById('perf-poll-val').textContent = pSec + 's';
  document.getElementById('perf-sess-timeout').value = SETTINGS.session_timeout_minutes || 60;
}

async function saveAdminPerformance() {
  const patch = {
    qr_interval_seconds: Number(document.getElementById('perf-qr-timer').value) || 15,
    poll_interval_seconds: Number(document.getElementById('perf-poll-timer').value) || 4,
    session_timeout_minutes: Number(document.getElementById('perf-sess-timeout').value) || 60
  };
  const r = await api('admin_save_settings', { patch });
  if (!r.ok) return toast(r.error, true);
  SETTINGS = { ...SETTINGS, ...patch };
  toast(`Saved! QR: ${patch.qr_interval_seconds}s · Poll: ${patch.poll_interval_seconds}s`);
}

function populateAdminSettingsForm() {
  document.getElementById('set-app-title').value = SETTINGS.app_title || '';
  document.getElementById('set-college-name').value = SETTINGS.college_name || '';
  document.getElementById('set-default-theme').value = SETTINGS.default_theme || 'dark';
  document.getElementById('set-geo-enabled').checked = Boolean(SETTINGS.geofence_enabled);
  document.getElementById('set-geo-lat').value = SETTINGS.campus_lat || '';
  document.getElementById('set-geo-lng').value = SETTINGS.campus_lng || '';
  document.getElementById('set-geo-rad').value = SETTINGS.geofence_radius_meters || 150;
  document.getElementById('set-smtp-email').value = SETTINGS.smtp_email || '';
  document.getElementById('set-smtp-pass').value = '';
}

async function saveAdminSettings() {
  const patch = {
    app_title: document.getElementById('set-app-title').value,
    college_name: document.getElementById('set-college-name').value,
    default_theme: document.getElementById('set-default-theme').value,
    geofence_enabled: document.getElementById('set-geo-enabled').checked,
    campus_lat: document.getElementById('set-geo-lat').value || null,
    campus_lng: document.getElementById('set-geo-lng').value || null,
    geofence_radius_meters: document.getElementById('set-geo-rad').value || 150,
    smtp_email: document.getElementById('set-smtp-email').value,
    smtp_app_password: document.getElementById('set-smtp-pass').value
  };
  const r = await api('admin_save_settings', { patch });
  if (!r.ok) return toast(r.error, true);
  SETTINGS = { ...SETTINGS, ...patch };
  applyTheme(patch.default_theme);
  toast('Settings saved!');
}

async function testAdminSmtp() {
  const r = await api('admin_test_smtp');
  if (!r.ok) return toast(r.error, true);
  toast('SMTP test email sent!');
}

async function loadClassGeoList() {
  const res = await api('admin_tab_academics');
  if (!res.ok) return;
  const classes = res.classes || [];
  document.getElementById('adm-class-geo-list').innerHTML = classes.length ? classes.map(c => `
    <div style="padding:12px;border-radius:10px;background:var(--bg-3);border:1px solid var(--border);display:grid;grid-template-columns:1.2fr 1fr 1fr 0.7fr auto;gap:8px;align-items:center;">
      <label style="font-size:0.78rem;font-weight:700;display:flex;align-items:center;gap:6px;">
        <input type="checkbox" id="cgeo-on-${c.id}" ${c.custom_geo_enabled ? 'checked' : ''}> ${c.code} · ${c.name}
      </label>
      <input id="cgeo-lat-${c.id}" value="${c.custom_lat ?? ''}" placeholder="Lat" class="input-box mono" style="padding:6px 8px;font-size:0.76rem;">
      <input id="cgeo-lng-${c.id}" value="${c.custom_lng ?? ''}" placeholder="Lng" class="input-box mono" style="padding:6px 8px;font-size:0.76rem;">
      <input id="cgeo-rad-${c.id}" type="number" value="${c.custom_radius_meters || 150}" placeholder="m" class="input-box mono" style="padding:6px 8px;font-size:0.76rem;">
      <div style="display:flex;gap:5px;">
        <button type="button" onclick="fillCurrentGps('cgeo-lat-${c.id}','cgeo-lng-${c.id}')" class="btn btn-amber" style="padding:6px 8px;" title="Use Current GPS">📍</button>
        <button type="button" onclick="saveClassGeo('${c.id}')" class="btn btn-primary" style="padding:6px 10px;">Save</button>
      </div>
    </div>
  `).join('') : '<p style="color:var(--text-mute);font-size:0.8rem;">No classes found.</p>';
}

async function saveClassGeo(classId) {
  const r = await api('admin_update_class_geo', {
    class_id: classId,
    custom_geo_enabled: document.getElementById(`cgeo-on-${classId}`).checked,
    custom_lat: document.getElementById(`cgeo-lat-${classId}`).value || null,
    custom_lng: document.getElementById(`cgeo-lng-${classId}`).value || null,
    custom_radius_meters: document.getElementById(`cgeo-rad-${classId}`).value || 150
  });
  if (!r.ok) return toast(r.error, true);
  toast('Class geofence updated!');
}

async function deleteAdminEntity(table, id) {
  const r = await api('admin_delete_entity', { table, id });
  if (!r.ok) return toast(r.error, true);
  toast('Deleted.'); LOADED_TABS.admDashboard = false;
  if (table === 'users') await loadAdminUsers(true); else await loadAdminAcademics(true);
}

window.addEventListener('DOMContentLoaded', initApp);
