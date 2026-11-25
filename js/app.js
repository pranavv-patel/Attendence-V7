let CURRENT_USER = null;
let SETTINGS = {};
let PENDING_MISMATCH = null;

// Lazy tab cache flags (data fetched only when clicked)
const LOADED_TABS = {
  crToday: false,
  facLiveSetup: false,
  facClasses: false,
  facMatrix: false,
  admDashboard: false,
  admUsers: false,
  admAcademics: false,
  admSessions: false,
  admDevices: false
};

const ADM_STATE = {
  breakdown: [],
  users: [],
  classes: [],
  subjects: [],
  slots: [],
  faculty: [],
  sessions: [],
  deviceReqs: [],
  logs: []
};

const FAC_STATE = {
  slots: [],
  classes: [],
  subjects: [],
  sessions: [],
  liveSession: null,
  roster: [],
  qrCount: 0,
  perms: {}
};

const CR_STATE = {
  lectures: [],
  liveSession: null,
  roster: [],
  qrCount: 0
};

let QR_ROTATE_TIMER = null;
let CLOCK_TIMER = null;
let ROSTER_POLL_TIMER = null;
let QR_WIDGET = null;

// Student getUserMedia + jsQR camera state
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
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  localStorage.setItem('sqr_theme', isDark ? 'dark' : 'light');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = isDark ? '☀️ Light' : '🌙 Dark';
}

function initTheme() {
  const saved = localStorage.getItem('sqr_theme');
  const pref = saved || SETTINGS.default_theme || 'dark';
  applyTheme(pref);
}

function toggleTheme() {
  const nowDark = !document.documentElement.classList.contains('dark');
  applyTheme(nowDark ? 'dark' : 'light');
}

function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `fixed bottom-5 right-5 z-50 max-w-sm rounded-xl px-4 py-3 text-xs sm:text-sm font-semibold text-white shadow-2xl ${isErr ? 'bg-rose-600' : 'bg-slate-900 dark:bg-sky-600'}`;
  el.classList.remove('hidden');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add('hidden'), 3800);
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

function togglePassVis(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
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
    if (el) el.value = '';
  });
  document.getElementById('modal-change-pass').classList.remove('hidden');
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

function resetLazyFlags() {
  Object.keys(LOADED_TABS).forEach(k => { LOADED_TABS[k] = false; });
}

// Startup: ONLY lightweight get_settings + whoami (no heavy table loads on open)
async function initApp() {
  const fp = getDeviceFp();
  const fpPrev = document.getElementById('login-fp-code');
  if (fpPrev) fpPrev.textContent = fp;

  const sRes = await api('get_settings');
  if (sRes.ok && sRes.settings) {
    SETTINGS = sRes.settings;
    document.getElementById('brand-title').textContent = SETTINGS.app_title || 'SmartQR Attendance';
    document.getElementById('brand-college').textContent = SETTINGS.college_name || 'University Portal v8.0';
    if (SETTINGS.login_subtitle) {
      document.getElementById('login-subtitle').textContent = SETTINGS.login_subtitle;
    }
    if (SETTINGS.logo_url) {
      document.getElementById('brand-logo').src = SETTINGS.logo_url;
    }
  }
  initTheme();

  const me = await api('whoami');
  if (me.ok && me.user) {
    routeToRole(me.user);
  } else {
    showScreen('login');
  }
}

function showScreen(screenName) {
  ['login', 'student', 'cr', 'faculty', 'admin'].forEach(s => {
    document.getElementById('screen-' + s).classList.toggle('hidden', s !== screenName);
  });
  document.getElementById('nav-user-chip').classList.toggle('hidden', screenName === 'login');
  document.getElementById('nav-user-chip').classList.toggle('flex', screenName !== 'login');
  if (screenName !== 'student') stopStudentCamera();
}

function routeToRole(user) {
  CURRENT_USER = user;
  resetLazyFlags();
  clearSessionLoops();

  document.getElementById('nav-user-name').textContent = user.full_name;
  document.getElementById('nav-user-role').textContent = user.is_super_admin ? 'SUPER ADMIN' : String(user.role || '').toUpperCase();

  if (user.role === 'student') {
    showScreen('student');
    document.getElementById('stu-name').textContent = user.full_name;
    document.getElementById('stu-meta').textContent = `Enrollment: ${user.enrollment_no || '-'} • Roll: ${user.roll_no || '-'} • Class: ${user.classes?.name || '-'}`;
    document.getElementById('stu-tab-fp').textContent = getDeviceFp();
    switchStudentTab('scan');
  } else if (user.role === 'cr') {
    showScreen('cr');
    document.getElementById('cr-heading').textContent = `${user.full_name} (CR)`;
    document.getElementById('cr-sub').textContent = `Class: ${user.classes?.name || '-'} • Today's Lectures Only (Period to +1h)`;
    switchCRView();
  } else if (user.role === 'faculty') {
    showScreen('faculty');
    document.getElementById('fac-sidebar-meta').textContent = `${user.faculty_code || 'FAC'} • ${user.full_name}`;
    switchFacultyTab('live');
  } else if (user.role === 'admin') {
    showScreen('admin');
    switchAdminTab('dashboard');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  document.getElementById('device-mismatch-box').classList.add('hidden');
  const identifier = document.getElementById('login-id').value.trim();
  const password = document.getElementById('login-pass').value;
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  const res = await api('login', { identifier, password, device_fp: getDeviceFp() });
  btn.disabled = false;
  btn.textContent = 'Sign In Securely';

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
  const reason = document.getElementById('login-dev-reason').value.trim();
  const r = await api('request_device_change', {
    student_id: PENDING_MISMATCH.student_id,
    new_device_fp: getDeviceFp(),
    reason
  });
  if (!r.ok) return toast(r.error, true);
  toast(r.message || 'Device request sent!');
  document.getElementById('device-mismatch-box').classList.add('hidden');
}

async function logoutUser() {
  clearSessionLoops();
  stopStudentCamera();
  await api('logout');
  CURRENT_USER = null;
  showScreen('login');
}

// ================= STUDENT PORTAL (3 Options Only) =================
function switchStudentTab(tabName) {
  if (tabName !== 'scan') stopStudentCamera();
  ['scan', 'password', 'device'].forEach(t => {
    document.getElementById(`stu-tab-${t}`).classList.toggle('hidden', t !== tabName);
  });
  document.querySelectorAll('.stu-nav-btn').forEach(btn => {
    const active = btn.dataset.stuTab === tabName;
    btn.classList.toggle('text-sky-600', active);
    btn.classList.toggle('dark:text-sky-400', active);
    btn.classList.toggle('border-sky-500', active);
    btn.classList.toggle('text-slate-500', !active);
    btn.classList.toggle('dark:text-slate-400', !active);
    btn.classList.toggle('border-transparent', !active);
  });
  if (tabName === 'device') {
    document.getElementById('stu-tab-fp').textContent = getDeviceFp();
  }
}

// Clean getUserMedia + jsQR lifecycle so camera opens & closes repeatedly without getting stuck
function stopStudentCamera() {
  STU_CAM_OPEN = false;
  if (STU_RAF) {
    cancelAnimationFrame(STU_RAF);
    STU_RAF = null;
  }
  const video = document.getElementById('stu-video');
  if (STU_STREAM) {
    STU_STREAM.getTracks().forEach(track => {
      try { track.stop(); } catch {}
    });
    STU_STREAM = null;
  }
  if (video) {
    try { video.pause(); } catch {}
    video.srcObject = null;
    video.classList.add('hidden');
  }
  document.getElementById('stu-scan-overlay').classList.add('hidden');
  document.getElementById('stu-cam-idle').classList.remove('hidden');
  const btn = document.getElementById('btn-stu-cam');
  if (btn) {
    btn.textContent = 'Open Camera';
    btn.className = 'px-3.5 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-600 text-white text-xs font-bold';
  }
}

async function toggleStudentCamera() {
  if (STU_CAM_OPEN) {
    stopStudentCamera();
    document.getElementById('stu-scan-status').textContent = 'Camera closed.';
    return;
  }
  stopStudentCamera();
  const statusEl = document.getElementById('stu-scan-status');
  const btn = document.getElementById('btn-stu-cam');
  statusEl.textContent = 'Starting camera...';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusEl.textContent = 'Camera API not available in this browser.';
    return toast('Camera not supported on this browser.', true);
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    STU_STREAM = stream;
    STU_CAM_OPEN = true;

    const video = document.getElementById('stu-video');
    const canvas = document.getElementById('stu-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    video.srcObject = stream;
    video.classList.remove('hidden');
    document.getElementById('stu-cam-idle').classList.add('hidden');
    document.getElementById('stu-scan-overlay').classList.remove('hidden');
    btn.textContent = 'Close Camera';
    btn.className = 'px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold';
    statusEl.textContent = 'Point camera at classroom QR...';

    await video.play();

    const scanLoop = async () => {
      if (!STU_CAM_OPEN || !STU_STREAM) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = typeof jsQR === 'function' ? jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
        if (code && code.data) {
          stopStudentCamera();
          statusEl.textContent = 'QR captured! Submitting...';
          await handleStudentQrPayload(code.data);
          return;
        }
      }
      STU_RAF = requestAnimationFrame(scanLoop);
    };
    STU_RAF = requestAnimationFrame(scanLoop);
  } catch (err) {
    stopStudentCamera();
    statusEl.textContent = 'Camera permission denied or unavailable.';
    toast('Could not open camera: ' + (err.message || err), true);
  }
}

async function handleStudentQrPayload(rawText) {
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    document.getElementById('stu-scan-status').textContent = 'Invalid QR payload.';
    return toast('Invalid QR code.', true);
  }

  const sendAttendance = async (lat = null, lng = null) => {
    const res = await api('submit_qr', {
      session_id: payload.s || payload.sid,
      nonce: payload.n,
      device_fp: getDeviceFp(),
      lat,
      lng
    });
    if (!res.ok) {
      const msg = res.message || res.error || 'Could not mark attendance.';
      document.getElementById('stu-scan-status').textContent = msg;
      return toast(msg, true);
    }
    document.getElementById('stu-scan-status').textContent = 'Attendance Marked Present (P) ✓';
    toast('Attendance Marked Present (P)!');
  };

  if (SETTINGS.geofence_enabled && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => sendAttendance(pos.coords.latitude, pos.coords.longitude),
      () => sendAttendance(null, null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }
    );
  } else {
    await sendAttendance(null, null);
  }
}

function validateStudentPasswordMatch() {
  const p1 = document.getElementById('stu-cp-new1').value;
  const p2 = document.getElementById('stu-cp-new2').value;
  const hint = document.getElementById('stu-cp-match-hint');
  if (!p1 && !p2) {
    hint.textContent = '';
    return;
  }
  if (p1.length < 4) {
    hint.textContent = 'Use at least 4 characters.';
    hint.className = 'text-[11px] mt-1 font-semibold text-amber-600';
    return;
  }
  if (p1 === p2) {
    hint.textContent = 'Passwords match ✓';
    hint.className = 'text-[11px] mt-1 font-semibold text-emerald-600';
  } else {
    hint.textContent = 'Passwords do not match yet.';
    hint.className = 'text-[11px] mt-1 font-semibold text-rose-600';
  }
}

async function submitStudentPassword() {
  const current_password = document.getElementById('stu-cp-old').value;
  const p1 = document.getElementById('stu-cp-new1').value;
  const p2 = document.getElementById('stu-cp-new2').value;
  if (!p1 || p1.length < 4) return toast('New password must be at least 4 characters.', true);
  if (p1 !== p2) return toast('New passwords do not match.', true);

  const res = await api('change_password', { current_password, new_password: p1 });
  if (!res.ok) return toast(res.error, true);

  ['stu-cp-old', 'stu-cp-new1', 'stu-cp-new2'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('stu-cp-match-hint').textContent = '';
  toast('Password updated successfully!');
}

async function submitStudentDeviceRequest() {
  const reason = document.getElementById('stu-dev-reason').value.trim();
  const res = await api('request_device_change', {
    student_id: CURRENT_USER?.id,
    new_device_fp: getDeviceFp(),
    reason
  });
  if (!res.ok) return toast(res.error, true);
  document.getElementById('stu-dev-reason').value = '';
  toast(res.message || 'Device change request submitted!');
}

// ================= CR PORTAL =================
async function switchCRView() {
  if (!LOADED_TABS.crToday) {
    await loadCRTodayLectures(false);
  }
}

async function loadCRTodayLectures(force = false) {
  if (LOADED_TABS.crToday && !force) return;
  const res = await api('cr_today_lectures');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.crToday = true;
  CR_STATE.lectures = res.lectures || [];
  renderCRLecturesList();

  const existingActive = CR_STATE.lectures.find(l => l.active_session && l.active_session.is_active);
  if (existingActive && existingActive.active_session) {
    openSessionMonitor(existingActive.active_session.id, 'cr');
  }
}

function renderCRLecturesList() {
  const box = document.getElementById('cr-lectures-list');
  if (!CR_STATE.lectures.length) {
    box.innerHTML = '<p class="text-slate-400">No lectures scheduled for your class today.</p>';
    return;
  }

  box.innerHTML = CR_STATE.lectures.map(lec => {
    const classLabel = (lec.class_names || []).join(' + ');
    const allowed = lec.window_allowed;
    return `
      <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
        <div>
          <div class="font-mono text-[11px] font-bold text-sky-600 dark:text-sky-400">${lec.start_time} – ${lec.end_time} (v${lec.timetable_version})</div>
          <div class="font-extrabold text-sm mt-0.5">${lec.subject_name} <span class="text-slate-400 font-normal">(${lec.subject_code})</span></div>
          <div class="text-[11px] text-slate-500">${classLabel} • ${lec.window_reason}</div>
        </div>
        <button type="button" ${!allowed ? 'disabled' : ''} onclick="crOpenSlotQr('${lec.slot_id}')" class="px-3.5 py-2 rounded-xl font-bold text-xs ${allowed ? 'bg-sky-500 hover:bg-sky-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'}">
          ${lec.active_session ? 'Re-Open QR' : 'Open QR'}
        </button>
      </div>
    `;
  }).join('');
}

async function crOpenSlotQr(slotId) {
  const res = await api('cr_open_lecture_qr', { slot_id: slotId });
  if (!res.ok) return toast(res.error, true);
  toast("Today's lecture QR opened!");
  await openSessionMonitor(res.session.id, 'cr');
}

async function crMarkSelfAttendance() {
  if (!CR_STATE.liveSession) return toast('Open QR first.', true);
  const res = await api('cr_mark_self', { session_id: CR_STATE.liveSession.id });
  if (!res.ok) return toast(res.error, true);
  toast('Your CR attendance has been marked Present (P)!');
  await refreshSessionMonitorData(CR_STATE.liveSession.id, 'cr');
}

// ================= FACULTY PORTAL (Lazy Tabs) =================
async function switchFacultyTab(tab) {
  ['live', 'classes', 'matrix'].forEach(t => {
    document.getElementById(`fac-tab-${t}`).classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('.fac-nav-btn').forEach(btn => {
    const active = btn.dataset.facTab === tab;
    btn.classList.toggle('bg-slate-800', active);
    btn.classList.toggle('text-white', active);
  });

  if (tab === 'live' && !LOADED_TABS.facLiveSetup) {
    await loadFacultyLiveSetup();
  } else if (tab === 'classes' && !LOADED_TABS.facClasses) {
    await loadFacultyClasses(false);
  } else if (tab === 'matrix' && !LOADED_TABS.facMatrix) {
    await loadFacultyMatrix(false);
  }
}

async function loadFacultyLiveSetup() {
  const res = await api('faculty_classes');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.facLiveSetup = true;
  FAC_STATE.classes = res.classes || [];
  FAC_STATE.subjects = res.subjects || [];
  FAC_STATE.slots = res.slots || [];

  const clsHtml = FAC_STATE.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  document.getElementById('fac-start-class').innerHTML = clsHtml;
  document.getElementById('fac-merge-classes').innerHTML = clsHtml;
  document.getElementById('fac-start-subject').innerHTML = FAC_STATE.subjects.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
}

async function loadFacultyClasses(force = false) {
  if (LOADED_TABS.facClasses && !force) return;
  const res = await api('faculty_classes');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.facClasses = true;
  FAC_STATE.slots = res.slots || [];
  FAC_STATE.classes = res.classes || [];
  FAC_STATE.subjects = res.subjects || [];

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const grid = document.getElementById('fac-classes-grid');
  if (!FAC_STATE.slots.length) {
    grid.innerHTML = '<p class="text-slate-400">No timetable slots assigned yet.</p>';
    return;
  }
  grid.innerHTML = FAC_STATE.slots.map(sl => {
    const cIds = sl.class_ids || [sl.class_id];
    const isMerged = cIds.length > 1;
    return `
      <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2">
        <div class="flex items-center justify-between">
          <span class="font-mono text-[11px] font-bold text-sky-500">${days[sl.day_of_week] || ''} • ${sl.start_time}–${sl.end_time}</span>
          ${isMerged ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300">MERGED</span>' : '<span class="text-[10px] text-slate-400">v' + (sl.version_no || 1) + '</span>'}
        </div>
        <div class="font-extrabold text-sm">${sl.subject_name} <span class="text-slate-400 font-normal">(${sl.subject_code})</span></div>
        <div class="text-slate-500 dark:text-slate-400">${(sl.class_names || []).join(' + ')}</div>
        <button type="button" onclick='startSessionFromSlot(${JSON.stringify(sl).replace(/'/g, "&#39;")})' class="w-full mt-2 py-2 rounded-xl bg-sky-500 hover:bg-sky-600 text-white font-bold">Start Lecture QR</button>
      </div>
    `;
  }).join('');
}

async function startSessionFromSlot(sl) {
  switchFacultyTab('live');
  const res = await api('start_session', {
    class_id: sl.class_id,
    class_ids: sl.class_ids || [sl.class_id],
    subject_id: sl.subject_id,
    slot_id: sl.id,
    slot_start_time: sl.start_time,
    slot_end_time: sl.end_time,
    session_type: 'REGULAR'
  });
  if (!res.ok) return toast(res.error, true);
  toast('Lecture QR started!');
  await openSessionMonitor(res.session.id, 'fac');
}

async function startFacultyLecture(sessionType) {
  const primaryClass = document.getElementById('fac-start-class').value;
  const mergedSel = [...document.getElementById('fac-merge-classes').selectedOptions].map(o => o.value);
  const classIds = [...new Set([primaryClass, ...mergedSel].filter(Boolean))];
  const subjectId = document.getElementById('fac-start-subject').value;

  const res = await api('start_session', {
    class_id: primaryClass,
    class_ids: classIds,
    subject_id: subjectId,
    session_type: sessionType
  });
  if (!res.ok) return toast(res.error, true);
  toast(`${sessionType} session started!`);
  await openSessionMonitor(res.session.id, 'fac');
}

async function toggleFacultyGeo() {
  if (!FAC_STATE.liveSession) return;
  const checked = document.getElementById('fac-geo-toggle').checked;
  const res = await api('toggle_session_geo', { session_id: FAC_STATE.liveSession.id, geofence_override: checked });
  if (!res.ok) return toast(res.error, true);
  toast(`Session GPS ${checked ? 'enabled' : 'disabled'}.`);
}

async function loadFacultyMatrix(force = false) {
  if (LOADED_TABS.facMatrix && !force) return;
  const res = await api('faculty_attendance_matrix');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.facMatrix = true;
  FAC_STATE.sessions = res.sessions || [];

  const tbody = document.getElementById('fac-history-tbody');
  if (!FAC_STATE.sessions.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-slate-400">No lectures found yet.</td></tr>';
    return;
  }
  tbody.innerHTML = FAC_STATE.sessions.map(s => `
    <tr>
      <td class="p-3 font-mono font-bold text-sky-600 dark:text-sky-400">${s.session_code}</td>
      <td class="p-3 font-mono">${s.session_date}</td>
      <td class="p-3 font-bold">${s.class_label}</td>
      <td class="p-3">${s.subject_name}</td>
      <td class="p-3 text-center font-bold">${s.p_count + s.od_count}</td>
      <td class="p-3 text-center font-mono">${s.manual_headcount ?? '-'}</td>
      <td class="p-3 text-right">
        <button type="button" onclick="switchFacultyTab('live'); openSessionMonitor('${s.id}', 'fac')" class="px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-400 font-bold">Open</button>
      </td>
    </tr>
  `).join('');
}

// ================= SHARED LIVE SESSION MONITOR (Faculty & CR) =================
function renderQrElement(containerId, sessionId, nonce) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  if (typeof QRCode === 'function') {
    QR_WIDGET = new QRCode(box, {
      text: JSON.stringify({ s: sessionId, n: nonce }),
      width: 196,
      height: 196
    });
  }
}

async function openSessionMonitor(sessionId, mode) {
  clearSessionLoops();
  await refreshSessionMonitorData(sessionId, mode);

  CLOCK_TIMER = setInterval(() => {
    const nowStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    const el = document.getElementById(mode === 'cr' ? 'cr-qr-clock' : 'fac-qr-clock');
    if (el) el.textContent = nowStr;
  }, 1000);

  const rotateMs = (Number(SETTINGS.qr_interval_seconds) || 15) * 1000;
  QR_ROTATE_TIMER = setInterval(async () => {
    const r = await api('rotate_nonce', { session_id: sessionId });
    if (r.ok) {
      renderQrElement(mode === 'cr' ? 'cr-qr-box' : 'fac-qr-box', sessionId, r.nonce);
    }
  }, rotateMs);

  ROSTER_POLL_TIMER = setInterval(() => {
    refreshSessionMonitorData(sessionId, mode);
  }, 4000);
}

async function refreshSessionMonitorData(sessionId, mode) {
  const res = await api('session_roster', { session_id: sessionId });
  if (!res.ok) return;

  const s = res.session;
  const roster = res.roster || [];
  const qrCount = Number(res.qr_count || 0);

  if (mode === 'cr') {
    CR_STATE.liveSession = s;
    CR_STATE.roster = roster;
    CR_STATE.qrCount = qrCount;

    document.getElementById('cr-live-panel').classList.remove('hidden');
    document.getElementById('cr-live-code').textContent = s.session_code;
    document.getElementById('cr-live-title').textContent = `${s.subject_name} • ${s.class_label}`;
    renderQrElement('cr-qr-box', s.id, s.current_nonce);

    const scanned = roster.filter(r => r.status === 'P' || r.status === 'OD');
    document.getElementById('cr-scan-count').textContent = scanned.length;
    document.getElementById('cr-roll-pills').innerHTML = scanned.length
      ? scanned.map(r => `<span class="px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 font-mono font-bold">${r.roll_no || r.enrollment_no || r.full_name}</span>`).join('')
      : '<span class="text-slate-400">No scans yet.</span>';

    const hcInp = document.getElementById('cr-headcount-input');
    if (hcInp && document.activeElement !== hcInp && s.manual_headcount !== null && s.manual_headcount !== undefined) {
      hcInp.value = s.manual_headcount;
    }
    updateHeadcountVerificationUI('cr', qrCount, hcInp ? hcInp.value : s.manual_headcount);

    // CR "Mark My Attendance" button enabled only if session active AND >= 2 QR scans
    const markBtn = document.getElementById('btn-cr-mark-self');
    const selfAlready = roster.some(r => r.id === CURRENT_USER?.id && (r.status === 'P' || r.status === 'OD'));
    const canMark = Boolean(s.is_active) && qrCount >= 2 && !selfAlready;
    markBtn.disabled = !canMark;
    markBtn.textContent = selfAlready
      ? 'My Attendance Marked ✓'
      : qrCount < 2
        ? `Mark My Attendance (Need ${2 - qrCount} more QR scan)`
        : 'Mark My Attendance';
  } else {
    FAC_STATE.liveSession = s;
    FAC_STATE.roster = roster;
    FAC_STATE.qrCount = qrCount;

    document.getElementById('fac-live-panel').classList.remove('hidden');
    document.getElementById('fac-live-code').textContent = s.session_code;
    document.getElementById('fac-live-title').textContent = `${s.subject_name} (${s.subject_code}) • ${s.class_label}`;
    document.getElementById('fac-geo-toggle').checked = s.geofence_override === true || (s.geofence_override === null && Boolean(SETTINGS.geofence_enabled));
    renderQrElement('fac-qr-box', s.id, s.current_nonce);

    const scanned = roster.filter(r => r.status === 'P' || r.status === 'OD');
    document.getElementById('fac-scan-count').textContent = scanned.length;
    document.getElementById('fac-roll-pills').innerHTML = scanned.length
      ? scanned.map(r => `<span class="px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 font-mono font-bold">${r.roll_no || r.enrollment_no || r.full_name}${r.status === 'OD' ? ' (OD)' : ''}</span>`).join('')
      : '<span class="text-slate-400">Waiting for students to scan...</span>';

    const hcInp = document.getElementById('fac-headcount-input');
    if (hcInp && document.activeElement !== hcInp && s.manual_headcount !== null && s.manual_headcount !== undefined) {
      hcInp.value = s.manual_headcount;
    }
    updateHeadcountVerificationUI('fac', qrCount, hcInp ? hcInp.value : s.manual_headcount);
    renderLiveRoster();
  }
}

function updateHeadcountVerificationUI(prefix, qrCount, manualVal) {
  const qrEl = document.getElementById(`${prefix}-qr-headcount`);
  const badgeEl = document.getElementById(`${prefix}-headcount-status`);
  if (qrEl) qrEl.textContent = String(qrCount);
  if (!badgeEl) return;

  if (manualVal === '' || manualVal === null || manualVal === undefined) {
    badgeEl.textContent = 'Enter Count';
    badgeEl.className = 'text-center px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200';
    return;
  }

  const mNum = Number(manualVal);
  if (Number.isNaN(mNum)) {
    badgeEl.textContent = 'Invalid';
    return;
  }

  if (mNum === Number(qrCount)) {
    badgeEl.textContent = 'Verified ✓ (Match)';
    badgeEl.className = 'text-center px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  } else {
    const diff = mNum - Number(qrCount);
    badgeEl.textContent = `Diff: ${diff > 0 ? '+' + diff : diff}`;
    badgeEl.className = 'text-center px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
  }
}

async function saveHeadcount(prefix) {
  const session = prefix === 'cr' ? CR_STATE.liveSession : FAC_STATE.liveSession;
  if (!session) return;
  const val = document.getElementById(`${prefix}-headcount-input`).value;
  const res = await api('set_manual_headcount', {
    session_id: session.id,
    manual_headcount: val === '' ? null : Number(val)
  });
  if (!res.ok) return toast(res.error, true);
  const qrCount = prefix === 'cr' ? CR_STATE.qrCount : FAC_STATE.qrCount;
  updateHeadcountVerificationUI(prefix, qrCount, val);
  toast('Manual headcount saved for verification.');
}

function renderLiveRoster() {
  const q = (document.getElementById('fac-roster-search')?.value || '').trim().toLowerCase();
  const tbody = document.getElementById('fac-manual-tbody');
  if (!tbody) return;

  const filtered = (FAC_STATE.roster || []).filter(st =>
    !q ||
    (st.roll_no || '').toLowerCase().includes(q) ||
    (st.enrollment_no || '').toLowerCase().includes(q) ||
    (st.full_name || '').toLowerCase().includes(q) ||
    (st.class_code || '').toLowerCase().includes(q)
  );

  tbody.innerHTML = filtered.map(st => {
    const isP = st.status === 'P';
    const isOD = st.status === 'OD';
    const pill = isP
      ? '<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 font-bold">P</span>'
      : isOD
        ? '<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 font-bold">OD</span>'
        : '<span class="px-2 py-0.5 rounded bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 font-bold">A</span>';

    return `
      <tr>
        <td class="p-3 font-mono font-bold">${st.roll_no || '-'} <span class="text-slate-400 font-normal">(${st.enrollment_no || '-'})</span></td>
        <td class="p-3 font-semibold">${st.full_name} ${st.role === 'cr' ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">CR</span>' : ''}</td>
        <td class="p-3 text-slate-500">${st.class_code || st.class_name || '-'}</td>
        <td class="p-3 text-center"><input type="checkbox" ${isP ? 'checked' : ''} onchange="onFacultyManualTick('${st.id}', 'P', this.checked)" class="w-4 h-4 cursor-pointer" /></td>
        <td class="p-3 text-center"><input type="checkbox" ${isOD ? 'checked' : ''} onchange="onFacultyManualTick('${st.id}', 'OD', this.checked)" class="w-4 h-4 cursor-pointer" /></td>
        <td class="p-3 text-center">${pill}</td>
      </tr>
    `;
  }).join('');
}

async function onFacultyManualTick(studentId, targetStatus, checked) {
  if (!FAC_STATE.liveSession) return;
  const nextStatus = checked ? targetStatus : 'A';
  const res = await api('set_student_tick', {
    session_id: FAC_STATE.liveSession.id,
    student_id: studentId,
    status: nextStatus
  });
  if (!res.ok) return toast(res.error, true);
  await refreshSessionMonitorData(FAC_STATE.liveSession.id, 'fac');
}

function copySessionRolls() {
  const roster = CURRENT_USER?.role === 'cr' ? CR_STATE.roster : FAC_STATE.roster;
  const rolls = (roster || []).filter(r => r.status === 'P' || r.status === 'OD').map(r => r.roll_no || r.enrollment_no || r.full_name);
  if (!rolls.length) return toast('No roll numbers to copy.', true);
  navigator.clipboard?.writeText(rolls.join(', '));
  toast('Roll numbers copied!');
}

async function emailFacultySessionReport() {
  const s = FAC_STATE.liveSession;
  if (!s) return;
  const rolls = (FAC_STATE.roster || []).filter(r => r.status === 'P' || r.status === 'OD').map(r => r.roll_no || r.enrollment_no || r.full_name);
  const res = await api('email_attendance_self', {
    subject: `Attendance ${s.session_code}: ${s.subject_name} (${s.class_label})`,
    text: `Session: ${s.session_code}\nDate: ${s.session_date}\nClasses: ${s.class_label}\nSubject: ${s.subject_name}\nManual Headcount: ${s.manual_headcount ?? '-'}\nQR Headcount: ${FAC_STATE.qrCount}\nPresent/OD Rolls: ${rolls.join(', ')}`
  });
  if (!res.ok) return toast(res.error, true);
  toast('Report emailed to your inbox!');
}

async function closeActiveSession() {
  const session = CURRENT_USER?.role === 'cr' ? CR_STATE.liveSession : FAC_STATE.liveSession;
  if (!session) return;
  await api('close_session', { session_id: session.id });
  clearSessionLoops();
  toast('Session closed.');
  if (CURRENT_USER?.role === 'cr') {
    CR_STATE.liveSession = null;
    document.getElementById('cr-live-panel').classList.add('hidden');
    await loadCRTodayLectures(true);
  } else {
    FAC_STATE.liveSession = null;
    document.getElementById('fac-live-panel').classList.add('hidden');
  }
}

// ================= ADMIN PORTAL (Lazy Tab Loading) =================
async function switchAdminTab(tabName) {
  ['dashboard', 'users', 'academics', 'sessions', 'devices', 'settings'].forEach(t => {
    document.getElementById(`adm-tab-${t}`).classList.toggle('hidden', t !== tabName);
  });
  document.querySelectorAll('.adm-nav-btn').forEach(btn => {
    const active = btn.dataset.admTab === tabName;
    btn.classList.toggle('bg-slate-800', active);
    btn.classList.toggle('text-white', active);
  });

  if (tabName === 'dashboard' && !LOADED_TABS.admDashboard) {
    await loadAdminDashboard(false);
  } else if (tabName === 'users' && !LOADED_TABS.admUsers) {
    await loadAdminUsers(false);
  } else if (tabName === 'academics' && !LOADED_TABS.admAcademics) {
    await loadAdminAcademics(false);
  } else if (tabName === 'sessions' && !LOADED_TABS.admSessions) {
    await loadAdminSessions(false);
  } else if (tabName === 'devices' && !LOADED_TABS.admDevices) {
    await loadAdminDevicesLogs(false);
  } else if (tabName === 'settings') {
    populateAdminSettingsForm();
  }
}

async function loadAdminDashboard(force = false) {
  if (LOADED_TABS.admDashboard && !force) return;
  const res = await api('admin_dashboard_summary');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admDashboard = true;
  ADM_STATE.breakdown = res.class_breakdown || [];

  document.getElementById('adm-kpi-stu').textContent = res.kpis?.total_students ?? 0;
  document.getElementById('adm-kpi-fac').textContent = res.kpis?.total_faculty ?? 0;
  document.getElementById('adm-kpi-cls').textContent = res.kpis?.total_classes ?? 0;
  document.getElementById('adm-kpi-live').textContent = res.kpis?.live_sessions ?? 0;

  const tbody = document.getElementById('adm-breakdown-tbody');
  if (!ADM_STATE.breakdown.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-slate-400">No class breakdown data yet.</td></tr>';
    return;
  }
  tbody.innerHTML = ADM_STATE.breakdown.map(b => `
    <tr>
      <td class="p-3 font-bold">${b.class_name} <span class="font-mono text-sky-500">(${b.class_code})</span></td>
      <td class="p-3 text-center font-bold">${b.total_students}</td>
      <td class="p-3 text-center font-bold">${b.lectures_held}</td>
      <td class="p-3 text-center font-extrabold text-emerald-500">${b.present_pct}%</td>
      <td class="p-3 text-center font-bold text-amber-500">${b.od_pct}%</td>
      <td class="p-3 text-center font-bold text-rose-500">${b.absent_pct}%</td>
      <td class="p-3 text-center font-extrabold ${b.defaulters_count > 0 ? 'text-rose-500' : 'text-slate-400'}">${b.defaulters_count}</td>
    </tr>
  `).join('');
}

async function loadAdminUsers(force = false) {
  if (LOADED_TABS.admUsers && !force) return;
  const res = await api('admin_tab_users');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admUsers = true;
  ADM_STATE.users = res.users || [];
  ADM_STATE.classes = res.classes || [];

  const clsOpts = `<option value="">-- No Class --</option>` + ADM_STATE.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  document.getElementById('new-u-class').innerHTML = clsOpts;
  document.getElementById('eu-class').innerHTML = clsOpts;
  renderAdminUsersTable();
}

function renderAdminUsersTable() {
  const q = (document.getElementById('adm-user-search')?.value || '').trim().toLowerCase();
  const rf = document.getElementById('adm-user-role-filter')?.value || 'ALL';
  const tbody = document.getElementById('adm-users-tbody');

  const rows = (ADM_STATE.users || []).filter(u => {
    if (rf !== 'ALL' && u.role !== rf) return false;
    if (!q) return true;
    return (
      (u.full_name || '').toLowerCase().includes(q) ||
      (u.enrollment_no || '').toLowerCase().includes(q) ||
      (u.roll_no || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.faculty_code || '').toLowerCase().includes(q)
    );
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">No users found.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(u => {
    const badgeColor = u.role === 'cr'
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
      : u.role === 'faculty'
        ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
        : u.role === 'admin'
          ? 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300'
          : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';

    const ids = [
      u.faculty_code ? `ID: <b>${u.faculty_code}</b>` : '',
      u.enrollment_no ? `Enroll: <b>${u.enrollment_no}</b>` : '',
      u.roll_no ? `Roll: <b>${u.roll_no}</b>` : '',
      u.email || ''
    ].filter(Boolean).join(' • ');

    return `
      <tr>
        <td class="p-3"><span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${badgeColor}">${u.role}</span></td>
        <td class="p-3 font-bold">${u.full_name}</td>
        <td class="p-3">${ids || '-'}</td>
        <td class="p-3 text-slate-500">${u.classes?.name || '-'}</td>
        <td class="p-3 text-right whitespace-nowrap">
          <button type="button" onclick="openEditUserById('${u.id}')" class="px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-400 font-bold mr-1">Edit</button>
          ${!u.is_super_admin ? `<button type="button" onclick="deleteAdminEntity('users', '${u.id}')" class="px-2.5 py-1 rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-400 font-bold">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

async function createAdminUser() {
  const full_name = document.getElementById('new-u-name').value.trim();
  if (!full_name) return toast('Enter full name.', true);
  const res = await api('admin_create_user', {
    role: document.getElementById('new-u-role').value,
    full_name,
    enrollment_no: document.getElementById('new-u-enroll').value.trim() || null,
    roll_no: document.getElementById('new-u-roll').value.trim() || null,
    email: document.getElementById('new-u-email').value.trim() || null,
    class_id: document.getElementById('new-u-class').value || null
  });
  if (!res.ok) return toast(res.error, true);
  ['new-u-name', 'new-u-enroll', 'new-u-roll', 'new-u-email'].forEach(id => { document.getElementById(id).value = ''; });
  toast('User created!');
  LOADED_TABS.admDashboard = false;
  await loadAdminUsers(true);
}

function openEditUserById(userId) {
  const u = (ADM_STATE.users || []).find(x => x.id === userId);
  if (!u) return;
  document.getElementById('eu-id').value = u.id;
  document.getElementById('eu-role').value = u.role;
  document.getElementById('eu-name').value = u.full_name || '';
  document.getElementById('eu-enroll').value = u.enrollment_no || '';
  document.getElementById('eu-roll').value = u.roll_no || '';
  document.getElementById('eu-email').value = u.email || '';
  document.getElementById('eu-class').value = u.class_id || '';
  document.getElementById('eu-pass').value = '';
  document.getElementById('eu-active').checked = u.is_active !== false;
  document.getElementById('eu-reset-dev').checked = false;
  document.getElementById('modal-edit-user').classList.remove('hidden');
}

async function saveEditedUser() {
  const res = await api('admin_update_user', {
    user_id: document.getElementById('eu-id').value,
    role: document.getElementById('eu-role').value,
    full_name: document.getElementById('eu-name').value,
    enrollment_no: document.getElementById('eu-enroll').value,
    roll_no: document.getElementById('eu-roll').value,
    email: document.getElementById('eu-email').value,
    class_id: document.getElementById('eu-class').value || null,
    new_password: document.getElementById('eu-pass').value,
    is_active: document.getElementById('eu-active').checked,
    reset_device: document.getElementById('eu-reset-dev').checked
  });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-edit-user');
  toast('User updated!');
  LOADED_TABS.admDashboard = false;
  await loadAdminUsers(true);
}

function openSubAdminModal() {
  ['sa-name', 'sa-email', 'sa-pass'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('modal-subadmin').classList.remove('hidden');
}

async function saveNewSubAdmin() {
  const admin_permissions = {
    manage_users: true, manage_academics: true, manage_timetable: true,
    assign_proxy: true, approve_devices: true, manage_geofence: false,
    manage_settings: false, view_reports: true, manage_admins: false
  };
  const res = await api('admin_save_subadmin_perms', {
    full_name: document.getElementById('sa-name').value,
    email: document.getElementById('sa-email').value,
    password: document.getElementById('sa-pass').value,
    admin_permissions
  });
  if (!res.ok) return toast(res.error, true);
  closeModal('modal-subadmin');
  toast('Sub-Admin created!');
  await loadAdminUsers(true);
}

// Admin Tab 3: Auto-IDs & Timetable Matrix
async function loadAdminAcademics(force = false) {
  if (LOADED_TABS.admAcademics && !force) return;
  const res = await api('admin_tab_academics');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admAcademics = true;
  ADM_STATE.classes = res.classes || [];
  ADM_STATE.subjects = res.subjects || [];
  ADM_STATE.slots = res.slots || [];
  ADM_STATE.faculty = res.faculty || [];

  document.getElementById('adm-classes-list').innerHTML = ADM_STATE.classes.map(c => `
    <div class="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between">
      <div><span class="font-mono font-bold text-sky-500 mr-2">${c.code}</span><b>${c.name}</b></div>
      <button type="button" onclick="deleteAdminEntity('classes', '${c.id}')" class="text-rose-500 font-bold">Delete</button>
    </div>
  `).join('');

  document.getElementById('adm-subjects-list').innerHTML = ADM_STATE.subjects.map(s => `
    <div class="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between">
      <div><span class="font-mono font-bold text-emerald-500 mr-2">${s.code}</span><b>${s.name}</b></div>
      <button type="button" onclick="deleteAdminEntity('subjects', '${s.id}')" class="text-rose-500 font-bold">Delete</button>
    </div>
  `).join('');

  const matrixSel = document.getElementById('matrix-class-select');
  const prevClass = matrixSel.value;
  matrixSel.innerHTML = ADM_STATE.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  if (prevClass && ADM_STATE.classes.some(c => c.id === prevClass)) {
    matrixSel.value = prevClass;
  }

  document.getElementById('tt-subject').innerHTML = ADM_STATE.subjects.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
  document.getElementById('tt-faculty').innerHTML = ADM_STATE.faculty.map(f => `<option value="${f.id}">${f.faculty_code ? '[' + f.faculty_code + '] ' : ''}${f.full_name}</option>`).join('');
  document.getElementById('tt-merged-classes').innerHTML = ADM_STATE.classes.map(c => `<option value="${c.id}">${c.code} - ${c.name}</option>`).join('');

  renderTimetableMatrix();
}

async function createAdminClass() {
  const res = await api('admin_create_class', {
    name: document.getElementById('new-cls-name').value,
    code: document.getElementById('new-cls-code').value
  });
  if (!res.ok) return toast(res.error, true);
  document.getElementById('new-cls-name').value = '';
  document.getElementById('new-cls-code').value = '';
  toast(`Class created (${res.row?.code || 'Auto ID'})!`);
  LOADED_TABS.admDashboard = false;
  await loadAdminAcademics(true);
}

async function createAdminSubject() {
  const res = await api('admin_create_subject', {
    name: document.getElementById('new-sub-name').value,
    code: document.getElementById('new-sub-code').value
  });
  if (!res.ok) return toast(res.error, true);
  document.getElementById('new-sub-name').value = '';
  document.getElementById('new-sub-code').value = '';
  toast(`Subject created (${res.row?.code || 'Auto ID'})!`);
  await loadAdminAcademics(true);
}

function resetTimetableForm() {
  document.getElementById('tt-edit-slot-id').value = '';
  document.getElementById('tt-save-btn').textContent = 'Save Slot (New Version)';
}

async function saveTimetableSlot() {
  const selectedClassId = document.getElementById('matrix-class-select').value;
  const mergedSelected = [...document.getElementById('tt-merged-classes').selectedOptions].map(o => o.value);
  const classIds = [...new Set([selectedClassId, ...mergedSelected].filter(Boolean))];
  if (!classIds.length) return toast('Select a class first.', true);

  const res = await api('admin_save_timetable_slot', {
    slot_id: document.getElementById('tt-edit-slot-id').value || null,
    class_id: selectedClassId,
    class_ids: classIds,
    day_of_week: Number(document.getElementById('tt-day').value),
    start_time: document.getElementById('tt-start').value,
    end_time: document.getElementById('tt-end').value,
    subject_id: document.getElementById('tt-subject').value,
    faculty_id: document.getElementById('tt-faculty').value
  });
  if (!res.ok) return toast(res.error, true);
  resetTimetableForm();
  toast(`Saved timetable slot (Version v${res.version_no || 1})!`);
  await loadAdminAcademics(true);
}

// Render visual Day x Time Matrix for selected class
function renderTimetableMatrix() {
  const classId = document.getElementById('matrix-class-select')?.value;
  const headEl = document.getElementById('tt-matrix-head');
  const bodyEl = document.getElementById('tt-matrix-body');
  if (!headEl || !bodyEl) return;

  const days = [
    { d: 1, label: 'Mon' },
    { d: 2, label: 'Tue' },
    { d: 3, label: 'Wed' },
    { d: 4, label: 'Thu' },
    { d: 5, label: 'Fri' },
    { d: 6, label: 'Sat' }
  ];

  const currentSlots = (ADM_STATE.slots || []).filter(sl => {
    const isCur = sl.is_current !== false;
    const cIds = sl.class_ids || [sl.class_id];
    return isCur && (!classId || cIds.includes(classId));
  });

  const baseWindows = ['09:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-13:00', '14:00-15:00', '15:00-16:00'];
  const slotWindows = currentSlots.map(sl => `${sl.start_time}-${sl.end_time}`);
  const allWindows = [...new Set([...baseWindows, ...slotWindows])].sort();

  headEl.innerHTML = `<tr><th class="p-3">Time</th>${days.map(x => `<th class="p-3">${x.label}</th>`).join('')}</tr>`;

  bodyEl.innerHTML = allWindows.map(win => {
    const [st, et] = win.split('-');
    const cells = days.map(dayObj => {
      const match = currentSlots.find(sl => Number(sl.day_of_week) === dayObj.d && `${sl.start_time}-${sl.end_time}` === win);
      if (!match) {
        return `<td class="p-2 text-slate-400 align-top"><button type="button" onclick="prefillMatrixSlot(${dayObj.d}, '${st}', '${et}')" class="w-full py-2 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 hover:border-sky-400 text-[10px]">+ Slot</button></td>`;
      }
      const mergedTag = (match.class_ids || []).length > 1 ? ' <span class="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 text-[9px] font-extrabold">MERGED</span>' : '';
      return `
        <td class="p-2 align-top">
          <div class="p-2 rounded-xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 space-y-1">
            <div class="font-extrabold text-sky-900 dark:text-sky-200">${match.subject_name}${mergedTag}</div>
            <div class="text-[10px] text-slate-500">${match.faculty_name} • v${match.version_no || 1}</div>
            <div class="flex gap-2 pt-1">
              <button type="button" onclick='editMatrixSlot(${JSON.stringify(match).replace(/'/g, "&#39;")})' class="text-[10px] font-bold text-sky-600">Edit</button>
              <button type="button" onclick="deleteAdminEntity('timetable_slots', '${match.id}')" class="text-[10px] font-bold text-rose-500">Del</button>
            </div>
          </div>
        </td>
      `;
    }).join('');
    return `<tr><td class="p-3 font-mono font-bold whitespace-nowrap">${win}</td>${cells}</tr>`;
  }).join('');
}

function prefillMatrixSlot(dayNum, startStr, endStr) {
  document.getElementById('tt-edit-slot-id').value = '';
  document.getElementById('tt-day').value = String(dayNum);
  document.getElementById('tt-start').value = startStr;
  document.getElementById('tt-end').value = endStr;
  document.getElementById('tt-save-btn').textContent = 'Save Slot (New Version)';
  toast(`Prefilled ${startStr}–${endStr}. Pick Subject & Faculty, then click Save.`);
}

function editMatrixSlot(sl) {
  document.getElementById('tt-edit-slot-id').value = sl.id;
  document.getElementById('tt-day').value = String(sl.day_of_week);
  document.getElementById('tt-start').value = sl.start_time;
  document.getElementById('tt-end').value = sl.end_time;
  document.getElementById('tt-subject').value = sl.subject_id;
  document.getElementById('tt-faculty').value = sl.faculty_id;
  document.getElementById('tt-save-btn').textContent = `Update Slot (v${Number(sl.version_no || 1) + 1})`;
  toast('Editing slot — saving creates a new version while keeping past sessions intact.');
}

// Admin Tab 4: Sessions & Proxy
async function loadAdminSessions(force = false) {
  if (LOADED_TABS.admSessions && !force) return;
  const res = await api('admin_tab_sessions_reports');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admSessions = true;
  ADM_STATE.sessions = res.sessions || [];
  ADM_STATE.classes = res.classes || [];
  ADM_STATE.subjects = res.subjects || [];
  ADM_STATE.faculty = res.faculty || [];

  document.getElementById('proxy-class').innerHTML = ADM_STATE.classes.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('');
  document.getElementById('proxy-subject').innerHTML = ADM_STATE.subjects.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
  document.getElementById('proxy-faculty').innerHTML = ADM_STATE.faculty.map(f => `<option value="${f.id}">${f.full_name}</option>`).join('');

  const tbody = document.getElementById('adm-sessions-tbody');
  if (!ADM_STATE.sessions.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="p-4 text-center text-slate-400">No sessions recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = ADM_STATE.sessions.map(s => `
    <tr>
      <td class="p-3 font-mono font-bold text-sky-500">${s.session_code}</td>
      <td class="p-3 font-mono">${s.session_date}</td>
      <td class="p-3 font-bold">${s.class_label}</td>
      <td class="p-3">${s.subject_name}</td>
      <td class="p-3">${s.faculty_name}</td>
      <td class="p-3 text-center font-mono">${s.manual_headcount ?? '-'}</td>
      <td class="p-3 text-center font-bold">${s.is_active ? 'LIVE' : 'CLOSED'}</td>
      <td class="p-3 text-right">
        ${s.is_active ? `<button type="button" onclick="forceCloseAdminSession('${s.id}')" class="px-2.5 py-1 rounded-lg bg-rose-500/15 text-rose-500 font-bold">Close</button>` : '-'}
      </td>
    </tr>
  `).join('');
}

async function assignProxySession() {
  const res = await api('admin_assign_proxy', {
    class_id: document.getElementById('proxy-class').value,
    subject_id: document.getElementById('proxy-subject').value,
    substitute_faculty_id: document.getElementById('proxy-faculty').value
  });
  if (!res.ok) return toast(res.error, true);
  toast(`Proxy session ${res.session?.session_code || ''} started!`);
  LOADED_TABS.admDashboard = false;
  await loadAdminSessions(true);
}

async function forceCloseAdminSession(sessionId) {
  const res = await api('close_session', { session_id: sessionId });
  if (!res.ok) return toast(res.error, true);
  toast('Session closed.');
  LOADED_TABS.admDashboard = false;
  await loadAdminSessions(true);
}

// Admin Tab 5: Devices & Logs
async function loadAdminDevicesLogs(force = false) {
  if (LOADED_TABS.admDevices && !force) return;
  const res = await api('admin_tab_devices_logs');
  if (!res.ok) return toast(res.error, true);
  LOADED_TABS.admDevices = true;
  ADM_STATE.deviceReqs = res.device_requests || [];
  ADM_STATE.logs = res.logs || [];

  const devBox = document.getElementById('adm-dev-list');
  devBox.innerHTML = ADM_STATE.deviceReqs.length
    ? ADM_STATE.deviceReqs.map(r => `
      <div class="p-3 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <div>
          <b>${r.student_name}</b> (${r.roll_no}) • Reason: "${r.reason || '-'}" • New FP: <span class="font-mono">${r.new_device_fp}</span>
        </div>
        <div class="flex gap-2">
          <button type="button" onclick="reviewDeviceReq('${r.id}', 'APPROVED')" class="px-3 py-1 rounded-lg bg-emerald-600 text-white font-bold">Approve</button>
          <button type="button" onclick="reviewDeviceReq('${r.id}', 'REJECTED')" class="px-3 py-1 rounded-lg bg-rose-600 text-white font-bold">Reject</button>
        </div>
      </div>
    `).join('')
    : '<p class="text-slate-400">No pending device change requests.</p>';

  const logsBox = document.getElementById('adm-logs-list');
  logsBox.innerHTML = ADM_STATE.logs.length
    ? ADM_STATE.logs.map(l => `<div class="p-2 rounded-lg border border-slate-200 dark:border-slate-800"><b>[${l.event_type}]</b> ${l.details || ''}</div>`).join('')
    : '<p class="text-slate-400">No logs yet.</p>';
}

async function reviewDeviceReq(requestId, decision) {
  const res = await api('admin_review_device_req', { request_id: requestId, decision });
  if (!res.ok) return toast(res.error, true);
  toast(`Device request ${decision.toLowerCase()}.`);
  await loadAdminDevicesLogs(true);
}

// Admin Tab 6: Settings
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
  const res = await api('admin_save_settings', { patch });
  if (!res.ok) return toast(res.error, true);
  SETTINGS = { ...SETTINGS, ...patch };
  applyTheme(patch.default_theme);
  toast('Settings saved!');
}

async function testAdminSmtp() {
  const res = await api('admin_test_smtp');
  if (!res.ok) return toast(res.error, true);
  toast('SMTP test email sent!');
}

async function deleteAdminEntity(table, id) {
  const res = await api('admin_delete_entity', { table, id });
  if (!res.ok) return toast(res.error, true);
  toast('Deleted.');
  LOADED_TABS.admDashboard = false;
  if (table === 'users') await loadAdminUsers(true);
  else await loadAdminAcademics(true);
}

window.addEventListener('DOMContentLoaded', initApp);
