const crypto = require('crypto');
const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || 'smartqr-v8-production-secret-key';

function cleanNullableText(val, { lower = false } = {}) {
  if (val === undefined || val === null) return null;
  let trimmed = String(val).replace(/^\uFEFF/, '').trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    trimmed = trimmed.slice(1, -1).replace(/""/g, '"').trim();
  }
  if (!trimmed) return null;
  return lower ? trimmed.toLowerCase() : trimmed;
}

async function logAudit(eventType, actorId, details) {
  try {
    await sbFetch('audit_logs', {
      method: 'POST',
      body: JSON.stringify({
        event_type: String(eventType || 'INFO').slice(0, 50),
        actor_id: actorId || null,
        details: String(details || '').slice(0, 500)
      })
    });
  } catch {}
}

function parseDayOfWeek(val) {
  const s = String(val ?? '').trim().toLowerCase();
  const map = {
    '0': 0, 'sun': 0, 'sunday': 0,
    '1': 1, 'mon': 1, 'monday': 1,
    '2': 2, 'tue': 2, 'tues': 2, 'tuesday': 2,
    '3': 3, 'wed': 3, 'wednesday': 3,
    '4': 4, 'thu': 4, 'thur': 4, 'thurs': 4, 'thursday': 4,
    '5': 5, 'fri': 5, 'friday': 5,
    '6': 6, 'sat': 6, 'saturday': 6
  };
  return map[s] !== undefined ? map[s] : 1;
}

function normalizeTimeHHMM(val, fallback = '09:00') {
  const raw = String(val || '').trim().toUpperCase();
  if (!raw) return fallback;
  const ampm = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = ampm[2];
    if (ampm[3] === 'PM' && h < 12) h += 12;
    if (ampm[3] === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  const hm = raw.match(/^(\d{1,2}):(\d{2})/);
  if (hm) return `${String(Number(hm[1])).padStart(2, '0')}:${hm[2]}`;
  return fallback;
}

function formatDbError(err, fallback = 'Database operation failed.') {
  const msg = String(err?.message || err || '');
  if (
    msg.includes('23505') ||
    msg.includes('duplicate key') ||
    msg.includes('idx_users_email_unique') ||
    msg.includes('idx_users_enrollment_unique') ||
    msg.includes('idx_classes_code_unique') ||
    msg.includes('idx_subjects_code_unique')
  ) {
    if (msg.toLowerCase().includes('enrollment')) return 'A user with this Enrollment No already exists.';
    if (msg.toLowerCase().includes('email')) return 'A user with this Email ID already exists.';
    if (msg.toLowerCase().includes('code')) return 'A record with this unique code already exists.';
    return 'Duplicate record already exists.';
  }
  return msg || fallback;
}

function getISTClock() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const dayOfWeek = ist.getDay(); // 0=Sun..6=Sat
  const hh = String(ist.getHours()).padStart(2, '0');
  const mm = String(ist.getMinutes()).padStart(2, '0');
  const yyyy = ist.getFullYear();
  const mo = String(ist.getMonth() + 1).padStart(2, '0');
  const dd = String(ist.getDate()).padStart(2, '0');
  return {
    dayOfWeek,
    hhmm: `${hh}:${mm}`,
    minutesOfDay: ist.getHours() * 60 + ist.getMinutes(),
    dateStr: `${yyyy}-${mo}-${dd}`
  };
}

function timeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const parts = hhmm.split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function isWithinCRWindow(startTime, endTime, ist) {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  if (startMin === null || endMin === null) return { allowed: false, reason: 'Invalid slot timing' };
  const windowStart = startMin - 10;
  const windowEnd = endMin + 60;
  if (ist.minutesOfDay < windowStart) {
    return { allowed: false, reason: `Opens at ${startTime} (-10m)` };
  }
  if (ist.minutesOfDay > windowEnd) {
    return { allowed: false, reason: `Window ended (+1h after ${endTime})` };
  }
  return { allowed: true, reason: 'Active window' };
}

async function sbFetch(path, options = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.');
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(data?.message || data?.error || `DB Error ${res.status}`);
  return data;
}

async function sbRpc(fnName, params = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `RPC ${fnName} failed`);
  return data;
}

function signToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/sqr_sess=([^;]+)/);
  return match ? verifyToken(match[1]) : null;
}

function setSessionCookie(res, payload) {
  const token = signToken({ ...payload, exp: Date.now() + 12 * 3600 * 1000 });
  res.setHeader('Set-Cookie', `sqr_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
}

function requireRole(req, res, roles) {
  const sess = getSession(req);
  if (!sess || !roles.includes(sess.role)) {
    res.status(401).json({ ok: false, error: 'Unauthorized session. Please log in again.' });
    return null;
  }
  return sess;
}

async function requireAdminPerm(req, res, permKey) {
  const sess = requireRole(req, res, ['admin']);
  if (!sess) return null;
  const rows = await sbFetch(`users?id=eq.${sess.id}&select=id,email,full_name,is_super_admin,admin_permissions,is_active`);
  const admin = rows[0];
  if (!admin || !admin.is_active) {
    res.status(401).json({ ok: false, error: 'Admin account disabled.' });
    return null;
  }
  if (!admin.is_super_admin && permKey && !admin.admin_permissions?.[permKey]) {
    res.status(403).json({ ok: false, error: `Access Denied: Missing '${permKey}' permission.` });
    return null;
  }
  return admin;
}

async function getSmtpCreds() {
  const rows = await sbFetch('system_settings?id=eq.1&select=smtp_email,smtp_app_password');
  const dbEmail = (rows[0]?.smtp_email || '').trim();
  const dbPass = (rows[0]?.smtp_app_password || '').trim();
  if (dbEmail && dbPass) return { user: dbEmail, pass: dbPass };
  const envEmail = (process.env.SMTP_EMAIL || '').trim();
  const envPass = (process.env.SMTP_APP_PASSWORD || '').trim();
  if (envEmail && envPass) return { user: envEmail, pass: envPass };
  return null;
}

async function nextCode(prefix, table, col) {
  const rows = await sbRpc('generate_next_code', { p_prefix: prefix, p_table: table, p_col: col });
  return typeof rows === 'string' ? rows : (rows?.code || `${prefix}-${Date.now().toString().slice(-3)}`);
}

async function nextSessionCode(dateStr) {
  const code = await sbRpc('generate_session_code', { p_date: dateStr || getISTClock().dateStr });
  return typeof code === 'string' ? code : `SES-${Date.now()}`;
}

function normalizeClassIds(primaryClassId, rawClassIds) {
  const list = Array.isArray(rawClassIds) ? rawClassIds : [];
  const combined = [primaryClassId, ...list].map(x => cleanNullableText(x)).filter(Boolean);
  return [...new Set(combined)];
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = req.query.action || body.action;

        // Combined lightweight startup (settings + whoami in 1 request)
    if (action === 'init') {
      const sess = getSession(req);
      const [setRows, userRows] = await Promise.all([
        sbFetch('system_settings?id=eq.1&select=*'),
        sess ? sbFetch(`users?id=eq.${sess.id}&select=id,role,faculty_code,email,enrollment_no,roll_no,full_name,class_id,device_fp,is_super_admin,admin_permissions,faculty_permissions,classes(id,name,code)`) : Promise.resolve([])
      ]);
      const s = setRows[0] || {};
      const dbEmail = (s.smtp_email || '').trim();
      const dbPass = (s.smtp_app_password || '').trim();
      const envEmail = (process.env.SMTP_EMAIL || '').trim();
      const envPass = (process.env.SMTP_APP_PASSWORD || '').trim();
      delete s.smtp_app_password;
      s.smtp_configured = Boolean((dbEmail && dbPass) || (envEmail && envPass));
      if (!sess || sess.role !== 'admin') {
        delete s.campus_lat;
        delete s.campus_lng;
        delete s.smtp_email;
      }
      return res.json({ ok: true, settings: s, user: userRows[0] || null });
    }

    // Lightweight startup settings
    if (action === 'get_settings') {
      const rows = await sbFetch('system_settings?id=eq.1&select=*');
      const s = rows[0] || {};
      const sess = getSession(req);
      const dbEmail = (s.smtp_email || '').trim();
      const dbPass = (s.smtp_app_password || '').trim();
      const envEmail = (process.env.SMTP_EMAIL || '').trim();
      const envPass = (process.env.SMTP_APP_PASSWORD || '').trim();

      delete s.smtp_app_password;
      s.smtp_configured = Boolean((dbEmail && dbPass) || (envEmail && envPass));
      if (!sess || sess.role !== 'admin') {
        delete s.campus_lat;
        delete s.campus_lng;
        delete s.smtp_email;
      }
      return res.json({ ok: true, settings: s });
    }

    // Lightweight startup session check
    if (action === 'whoami') {
      const sess = getSession(req);
      if (!sess) return res.json({ ok: true, user: null });
      const rows = await sbFetch(`users?id=eq.${sess.id}&select=id,role,faculty_code,email,enrollment_no,roll_no,full_name,class_id,device_fp,is_super_admin,admin_permissions,faculty_permissions,classes(id,name,code)`);
      return res.json({ ok: true, user: rows[0] || null });
    }

    if (action === 'logout') {
      res.setHeader('Set-Cookie', 'sqr_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return res.json({ ok: true });
    }

    if (action === 'login') {
      const identifier = String(body.identifier || '').trim().toLowerCase();
      const password = String(body.password || '');
      const deviceFp = String(body.device_fp || '').trim();
      if (!identifier || !password) {
        return res.status(400).json({ ok: false, error: 'Enter ID / Enrollment No / Email and password.' });
      }

      const authRes = await sbRpc('rpc_verify_login_v8', { p_identifier: identifier, p_password: password });
      if (!authRes?.ok) {
        return res.status(401).json({ ok: false, error: authRes?.error || 'Invalid credentials.' });
      }

      const u = authRes.user;
      if ((u.role === 'student' || u.role === 'cr') && deviceFp && !u.device_fp) {
        await sbFetch(`users?id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ device_fp: deviceFp }) });
      }

      setSessionCookie(res, { id: u.id, role: u.role, email: u.email, full_name: u.full_name });
      const fullRows = await sbFetch(`users?id=eq.${u.id}&select=id,role,faculty_code,email,enrollment_no,roll_no,full_name,class_id,device_fp,is_super_admin,admin_permissions,faculty_permissions,classes(id,name,code)`);
      await logAudit('LOGIN', u.id, `${u.role.toUpperCase()} login: ${u.full_name}`);
      return res.json({ ok: true, user: fullRows[0] });
    }

    if (action === 'change_password') {
      const sess = requireRole(req, res, ['student', 'cr', 'faculty', 'admin']);
      if (!sess) return;
      const { current_password, new_password } = body;
      if (!new_password || String(new_password).length < 4) {
        return res.status(400).json({ ok: false, error: 'New password must be at least 4 characters.' });
      }
      const r = await sbRpc('rpc_change_password_v8', {
        p_user_id: sess.id,
        p_old_password: current_password || '',
        p_new_password: new_password
      });
      if (!r?.ok) return res.status(400).json({ ok: false, error: r?.error || 'Password update failed.' });
      return res.json({ ok: true });
    }

    if (action === 'request_device_change') {
      const { student_id, new_device_fp, reason } = body;
      const sess = getSession(req);
      const targetId = cleanNullableText(student_id) || (sess && ['student', 'cr'].includes(sess.role) ? sess.id : null);
      const fp = cleanNullableText(new_device_fp);
      if (!targetId || !fp) {
        return res.status(400).json({ ok: false, error: 'Missing student or device information.' });
      }

      const stuRows = await sbFetch(`users?id=eq.${targetId}&role=in.(student,cr)&select=id,full_name,roll_no,enrollment_no,class_id`);
      const stu = stuRows[0];
      if (!stu) return res.status(404).json({ ok: false, error: 'Student account not found.' });

      const existing = await sbFetch(`device_change_requests?student_id=eq.${targetId}&status=eq.PENDING&select=id`);
      if (existing.length > 0) {
        return res.json({ ok: true, message: 'You already have a pending device change request.' });
      }

      await sbFetch('device_change_requests', {
        method: 'POST',
        body: JSON.stringify({
          student_id: stu.id,
          roll_no: stu.enrollment_no || stu.roll_no || '-',
          student_name: stu.full_name,
          class_id: stu.class_id,
          new_device_fp: fp,
          reason: String(reason || 'New phone / browser reset').slice(0, 200)
        })
      });
      return res.json({ ok: true, message: 'Device change request submitted for review!' });
    }

    // Student / CR QR submission
    if (action === 'submit_qr') {
      const sess = requireRole(req, res, ['student', 'cr']);
      if (!sess) return;
      const r = await sbRpc('rpc_submit_qr_v8', {
        p_session_id: body.session_id,
        p_student_id: sess.id,
        p_nonce: body.nonce,
        p_device_fp: body.device_fp,
        p_lat: body.lat ?? null,
        p_lng: body.lng ?? null
      });
      return res.json(r);
    }

    // CR Today's Lectures (lazy tab load)
    if (action === 'cr_today_lectures') {
      const sess = requireRole(req, res, ['cr']);
      if (!sess) return;

      const uRows = await sbFetch(`users?id=eq.${sess.id}&select=id,full_name,roll_no,enrollment_no,class_id,classes(id,name,code)`);
      const cr = uRows[0];
      if (!cr || !cr.class_id) {
        return res.json({ ok: true, cr, lectures: [], ist: getISTClock() });
      }

      const ist = getISTClock();
      const [slots, classes, subjects, todaySessions] = await Promise.all([
        sbFetch(`timetable_slots?day_of_week=eq.${ist.dayOfWeek}&is_current=eq.true&order=start_time.asc&select=*,subjects(id,name,code)`),
        sbFetch('classes?select=id,name,code'),
        sbFetch('subjects?select=id,name,code'),
        sbFetch(`attendance_sessions?session_date=eq.${ist.dateStr}&order=created_at.desc&select=*,subjects(id,name,code)`)
      ]);

      const clsMap = Object.fromEntries((classes || []).map(c => [c.id, c]));
      const subMap = Object.fromEntries((subjects || []).map(s => [s.id, s]));

      const classSlots = (slots || []).filter(sl => {
        const cIds = normalizeClassIds(sl.class_id, sl.class_ids);
        return cIds.includes(cr.class_id);
      });

      const lectures = classSlots.map(sl => {
        const win = isWithinCRWindow(sl.start_time, sl.end_time, ist);
        const cIds = normalizeClassIds(sl.class_id, sl.class_ids);
        const matchingSession = (todaySessions || []).find(ses => {
          const sCIds = normalizeClassIds(ses.class_id, ses.class_ids);
          return ses.subject_id === sl.subject_id &&
            sCIds.includes(cr.class_id) &&
            (!ses.slot_id || ses.slot_id === sl.id);
        }) || (todaySessions || []).find(ses => {
          const sCIds = normalizeClassIds(ses.class_id, ses.class_ids);
          return ses.subject_id === sl.subject_id && sCIds.includes(cr.class_id);
        });

        return {
          slot_id: sl.id,
          day_of_week: sl.day_of_week,
          start_time: sl.start_time,
          end_time: sl.end_time,
          timetable_version: sl.version_no || 1,
          subject_id: sl.subject_id,
          subject_name: sl.subjects?.name || subMap[sl.subject_id]?.name || 'Subject',
          subject_code: sl.subjects?.code || subMap[sl.subject_id]?.code || '',
          class_id: cr.class_id,
          class_ids: cIds,
          class_names: cIds.map(id => clsMap[id]?.name || 'Class'),
          window_allowed: win.allowed,
          window_reason: win.reason,
          active_session: matchingSession || null
        };
      });

      return res.json({ ok: true, cr, ist, lectures });
    }

    // CR Open/Resume Today's Lecture QR
    if (action === 'cr_open_lecture_qr') {
      const sess = requireRole(req, res, ['cr']);
      if (!sess) return;

      const uRows = await sbFetch(`users?id=eq.${sess.id}&select=id,class_id`);
      const cr = uRows[0];
      if (!cr?.class_id) return res.status(400).json({ ok: false, error: 'CR is not assigned to a class.' });

      // Enforce strictly 1 active QR session at a time per faculty
      await sbFetch(`attendance_sessions?faculty_id=eq.${sess.id}&is_active=eq.true`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: false })
      });

      const ist = getISTClock();
      const slotId = cleanNullableText(body.slot_id);
      if (!slotId) return res.status(400).json({ ok: false, error: 'Missing lecture slot.' });

      const slotRows = await sbFetch(`timetable_slots?id=eq.${slotId}&is_current=eq.true&select=*`);
      const slot = slotRows[0];
      if (!slot) return res.status(404).json({ ok: false, error: 'Timetable slot not found.' });

      const cIds = normalizeClassIds(slot.class_id, slot.class_ids);
      if (!cIds.includes(cr.class_id) || Number(slot.day_of_week) !== ist.dayOfWeek) {
        return res.status(403).json({ ok: false, error: "CR can only open today's lectures for their own class." });
      }

      const win = isWithinCRWindow(slot.start_time, slot.end_time, ist);
      if (!win.allowed) {
        return res.status(403).json({ ok: false, error: `Access denied: ${win.reason}.` });
      }

      const existingRows = await sbFetch(`attendance_sessions?slot_id=eq.${slot.id}&session_date=eq.${ist.dateStr}&order=created_at.desc&limit=1&select=*`);
      let session = existingRows[0];

      if (session) {
        if (!session.is_active) {
          const updated = await sbFetch(`attendance_sessions?id=eq.${session.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ is_active: true })
          });
          session = updated[0] || session;
        }
      } else {
        const sCode = await nextSessionCode(ist.dateStr);
        const nonce = crypto.randomBytes(6).toString('hex');
        const created = await sbFetch('attendance_sessions', {
          method: 'POST',
          body: JSON.stringify({
            session_code: sCode,
            class_id: slot.class_id,
            class_ids: cIds,
            subject_id: slot.subject_id,
            faculty_id: slot.faculty_id,
            slot_id: slot.id,
            slot_start_time: slot.start_time,
            slot_end_time: slot.end_time,
            timetable_version: slot.version_no || 1,
            session_date: ist.dateStr,
            current_nonce: nonce,
            is_active: true,
            session_type: 'CR_OPEN'
          })
        });
        session = created[0];
      }

      return res.json({ ok: true, session });
    }

    // CR "Mark My Attendance" (requires open QR session + >= 2 QR scans)
    if (action === 'cr_mark_self') {
      const sess = requireRole(req, res, ['cr']);
      if (!sess) return;

      const sessionId = cleanNullableText(body.session_id);
      if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session.' });

      const sRows = await sbFetch(`attendance_sessions?id=eq.${sessionId}&select=*`);
      const s = sRows[0];
      if (!s || !s.is_active) {
        return res.status(400).json({ ok: false, error: 'QR session must be open to mark your attendance.' });
      }

      const qrRecs = await sbFetch(`attendance_records?session_id=eq.${sessionId}&status=eq.P&marked_via=eq.QR&select=student_id`);
      const qrCount = (qrRecs || []).length;
      if (qrCount < 2) {
        return res.status(400).json({
          ok: false,
          error: `At least 2 students must mark via QR first (currently ${qrCount}/2).`
        });
      }

      await sbFetch('attendance_records?on_conflict=session_id,student_id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: JSON.stringify({
          session_id: sessionId,
          student_id: sess.id,
          status: 'P',
          marked_via: 'CR_SELF'
        })
      });

      return res.json({ ok: true, qr_count: qrCount });
    }

    // Update Manual Headcount (Faculty & CR)
    if (action === 'set_manual_headcount') {
      const sess = requireRole(req, res, ['faculty', 'cr', 'admin']);
      if (!sess) return;

      const sessionId = cleanNullableText(body.session_id);
      if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session_id.' });

      const rawCount = body.manual_headcount;
      const headcount = (rawCount === '' || rawCount === null || rawCount === undefined)
        ? null
        : Math.max(0, Math.floor(Number(rawCount)));

      if (headcount !== null && Number.isNaN(headcount)) {
        return res.status(400).json({ ok: false, error: 'Headcount must be a valid number.' });
      }

      await sbFetch(`attendance_sessions?id=eq.${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          manual_headcount: headcount,
          headcount_updated_at: new Date().toISOString()
        })
      });

      return res.json({ ok: true, manual_headcount: headcount });
    }

    // Faculty lazy load: My Classes
    if (action === 'faculty_classes') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;

      const [slots, classes, subjects] = await Promise.all([
        sbFetch(`timetable_slots?faculty_id=eq.${sess.id}&is_current=eq.true&order=day_of_week.asc,start_time.asc&select=*`),
        sbFetch('classes?order=name.asc&select=id,name,code,semester'),
        sbFetch('subjects?order=name.asc&select=id,name,code')
      ]);

      const clsMap = Object.fromEntries((classes || []).map(c => [c.id, c]));
      const subMap = Object.fromEntries((subjects || []).map(s => [s.id, s]));

      const enriched = (slots || []).map(sl => {
        const cIds = normalizeClassIds(sl.class_id, sl.class_ids);
        return {
          ...sl,
          class_ids: cIds,
          class_names: cIds.map(id => clsMap[id]?.name || 'Class'),
          class_codes: cIds.map(id => clsMap[id]?.code || ''),
          subject_name: subMap[sl.subject_id]?.name || 'Subject',
          subject_code: subMap[sl.subject_id]?.code || ''
        };
      });

      return res.json({ ok: true, slots: enriched, classes: classes || [], subjects: subjects || [] });
    }

    // Faculty lazy load: Attendance Matrix / History
    if (action === 'faculty_attendance_matrix') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;

      const [sessions, classes, subjects, students] = await Promise.all([
        sbFetch(`attendance_sessions?faculty_id=eq.${sess.id}&order=session_date.desc,created_at.desc&limit=60&select=*`),
        sbFetch('classes?select=id,name,code'),
        sbFetch('subjects?select=id,name,code'),
        sbFetch('users?role=in.(student,cr)&is_active=eq.true&order=roll_no.asc&select=id,enrollment_no,roll_no,full_name,class_id')
      ]);

      const clsMap = Object.fromEntries((classes || []).map(c => [c.id, c]));
      const subMap = Object.fromEntries((subjects || []).map(s => [s.id, s]));
      const sessIds = (sessions || []).map(s => s.id);
      const records = sessIds.length
        ? await sbFetch(`attendance_records?session_id=in.(${sessIds.join(',')})&select=session_id,student_id,status`)
        : [];

      const countBySess = {};
      for (const r of records || []) {
        if (!countBySess[r.session_id]) countBySess[r.session_id] = { p: 0, od: 0 };
        if (r.status === 'P') countBySess[r.session_id].p++;
        if (r.status === 'OD') countBySess[r.session_id].od++;
      }

      const enrichedSessions = (sessions || []).map(s => {
        const cIds = normalizeClassIds(s.class_id, s.class_ids);
        return {
          ...s,
          class_ids: cIds,
          class_label: cIds.map(id => clsMap[id]?.code || clsMap[id]?.name || 'Class').join(' + '),
          subject_name: subMap[s.subject_id]?.name || 'Subject',
          subject_code: subMap[s.subject_id]?.code || '',
          p_count: countBySess[s.id]?.p || 0,
          od_count: countBySess[s.id]?.od || 0
        };
      });

      return res.json({
        ok: true,
        sessions: enrichedSessions,
        students: students || [],
        records: records || []
      });
    }

    // Start Live Session (Faculty or Admin; supports merged class_ids)
    if (action === 'start_session') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;

      const mergedIds = normalizeClassIds(body.class_id, body.class_ids);
      const subjectId = cleanNullableText(body.subject_id);
      if (!mergedIds.length || !subjectId) {
        return res.status(400).json({ ok: false, error: 'Select at least one class and a subject.' });
      }

      const stype = body.session_type === 'EXTRA' ? 'EXTRA' : 'REGULAR';
      if (sess.role === 'faculty') {
        const uRows = await sbFetch(`users?id=eq.${sess.id}&select=faculty_permissions`);
        const fp = uRows[0]?.faculty_permissions || {};
        if (stype === 'REGULAR' && fp.can_start_regular === false) {
          return res.status(403).json({ ok: false, error: 'Admin has disabled starting regular sessions for your account.' });
        }
        if (stype === 'EXTRA') {
          const setRows = await sbFetch('system_settings?id=eq.1&select=allow_extra_lectures');
          if (!setRows[0]?.allow_extra_lectures || fp.can_start_extra === false) {
            return res.status(403).json({ ok: false, error: 'Extra lectures are disabled for your account.' });
          }
        }
      }

      // Enforce strictly 1 active QR session at a time per faculty
      await sbFetch(`attendance_sessions?faculty_id=eq.${sess.id}&is_active=eq.true`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: false })
      });

      const ist = getISTClock();
      const slotId = cleanNullableText(body.slot_id);
      const todayRows = await sbFetch(`attendance_sessions?session_date=eq.${ist.dateStr}&subject_id=eq.${subjectId}&order=created_at.desc&select=*`);
      const sortedTarget = [...mergedIds].sort().join(',');
      const existing = (todayRows || []).find(s => {
        if (slotId && s.slot_id && s.slot_id === slotId) return true;
        const sIds = normalizeClassIds(s.class_id, s.class_ids).sort().join(',');
        return sIds === sortedTarget && s.session_type === stype;
      });

      if (existing) {
        const nonce = crypto.randomBytes(6).toString('hex');
        const updated = await sbFetch(`attendance_sessions?id=eq.${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ is_active: true, current_nonce: nonce })
        });
        const resumedSess = updated[0] || { ...existing, is_active: true, current_nonce: nonce };
        await logAudit('SESSION_RESUMED', sess.id, `Resumed ${resumedSess.session_code} for attendance update`);
        return res.json({ ok: true, session: resumedSess, resumed: true });
      }

      const sCode = await nextSessionCode(ist.dateStr);
      const nonce = crypto.randomBytes(6).toString('hex');
      const created = await sbFetch('attendance_sessions', {
        method: 'POST',
        body: JSON.stringify({
          session_code: sCode,
          class_id: mergedIds[0],
          class_ids: mergedIds,
          subject_id: subjectId,
          faculty_id: sess.id,
          slot_id: slotId,
          slot_start_time: cleanNullableText(body.slot_start_time),
          slot_end_time: cleanNullableText(body.slot_end_time),
          session_date: ist.dateStr,
          current_nonce: nonce,
          is_active: true,
          session_type: stype,
          geofence_override: typeof body.geofence_override === 'boolean' ? body.geofence_override : null
        })
      });

      await logAudit('SESSION_STARTED', sess.id, `Started ${sCode} (${stype}) for ${mergedIds.length} class(es)`);
      return res.json({ ok: true, session: created[0], resumed: false });
    }

    if (action === 'toggle_session_geo') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;
      if (sess.role === 'faculty') {
        const uRows = await sbFetch(`users?id=eq.${sess.id}&select=faculty_permissions`);
        if (uRows[0]?.faculty_permissions?.can_toggle_gps === false) {
          return res.status(403).json({ ok: false, error: 'Admin has locked GPS geofencing control for your account.' });
        }
      }
      await sbFetch(`attendance_sessions?id=eq.${body.session_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ geofence_override: Boolean(body.geofence_override) })
      });
      return res.json({ ok: true });
    }

    if (action === 'rotate_nonce') {
      const sess = requireRole(req, res, ['cr', 'faculty', 'admin']);
      if (!sess) return;
      const nonce = crypto.randomBytes(6).toString('hex');
      await sbFetch(`attendance_sessions?id=eq.${body.session_id}&is_active=eq.true`, {
        method: 'PATCH',
        body: JSON.stringify({ current_nonce: nonce })
      });
      return res.json({ ok: true, nonce });
    }

        // Ultra-lightweight live scan polling (fetches ONLY attendance_records + session status)
    if (action === 'session_scans') {
      const sess = requireRole(req, res, ['cr', 'faculty', 'admin']);
      if (!sess) return;
      const sessionId = cleanNullableText(body.session_id);
      if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session_id.' });
      const [sRows, records] = await Promise.all([
        sbFetch(`attendance_sessions?id=eq.${sessionId}&select=id,is_active,current_nonce,manual_headcount`),
        sbFetch(`attendance_records?session_id=eq.${sessionId}&select=student_id,status,marked_via`)
      ]);
      if (!sRows[0]) return res.status(404).json({ ok: false, error: 'Session not found.' });
      return res.json({ ok: true, session: sRows[0], records: records || [] });
    }

    // Faculty Device Change Requests (on-demand refresh only)
    if (action === 'faculty_device_requests') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;
      const reqs = await sbFetch('device_change_requests?status=eq.PENDING&order=created_at.desc&select=*,classes(name,code)');
      return res.json({ ok: true, device_requests: reqs || [] });
    }

    if (action === 'faculty_review_device_req') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;
      const { request_id, decision } = body;
      if (!['APPROVED', 'REJECTED'].includes(decision)) {
        return res.status(400).json({ ok: false, error: 'Invalid decision.' });
      }
      const reqRows = await sbFetch(`device_change_requests?id=eq.${request_id}&select=*`);
      const reqItem = reqRows[0];
      if (!reqItem) return res.status(404).json({ ok: false, error: 'Request not found.' });
      if (decision === 'APPROVED') {
        await sbFetch(`users?id=eq.${reqItem.student_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ device_fp: reqItem.new_device_fp })
        });
      }
      await sbFetch(`device_change_requests?id=eq.${request_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: decision, reviewed_by: sess.id, reviewed_at: new Date().toISOString() })
      });
      await logAudit('FACULTY_DEVICE_' + decision, sess.id, `${decision} device request for ${reqItem.student_name} (${reqItem.roll_no})`);
      return res.json({ ok: true });
    }

    // Live Session Roster (supports single & merged classes + headcount stats)
    if (action === 'session_roster') {
      const sess = requireRole(req, res, ['cr', 'faculty', 'admin']);
      if (!sess) return;

      const sessionId = cleanNullableText(body.session_id);
      if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session_id.' });

      const [sRows, classes, subjects] = await Promise.all([
        sbFetch(`attendance_sessions?id=eq.${sessionId}&select=*`),
        sbFetch('classes?select=id,name,code'),
        sbFetch('subjects?select=id,name,code')
      ]);
      const session = sRows[0];
      if (!session) return res.status(404).json({ ok: false, error: 'Session not found.' });

      const clsMap = Object.fromEntries((classes || []).map(c => [c.id, c]));
      const subMap = Object.fromEntries((subjects || []).map(s => [s.id, s]));
      const cIds = normalizeClassIds(session.class_id, session.class_ids);

      const classFilter = cIds.length === 1 ? `class_id=eq.${cIds[0]}` : `class_id=in.(${cIds.join(',')})`;
      const [students, records] = await Promise.all([
        sbFetch(`users?role=in.(student,cr)&${classFilter}&is_active=eq.true&order=roll_no.asc,full_name.asc&select=id,role,enrollment_no,roll_no,full_name,class_id`),
        sbFetch(`attendance_records?session_id=eq.${sessionId}&select=student_id,status,marked_via`)
      ]);

      const recMap = Object.fromEntries((records || []).map(r => [r.student_id, r]));
      const roster = (students || []).map(st => ({
        ...st,
        class_name: clsMap[st.class_id]?.name || '',
        class_code: clsMap[st.id]?.code || clsMap[st.class_id]?.code || '',
        status: recMap[st.id]?.status || 'A',
        marked_via: recMap[st.id]?.marked_via || null
      }));

      const qrCount = roster.filter(r => r.status === 'P' && r.marked_via === 'QR').length;
      const totalMarked = roster.filter(r => r.status === 'P' || r.status === 'OD').length;

      return res.json({
        ok: true,
        session: {
          ...session,
          class_ids: cIds,
          class_names: cIds.map(id => clsMap[id]?.name || 'Class'),
          class_label: cIds.map(id => clsMap[id]?.code || clsMap[id]?.name || 'Class').join(' + '),
          subject_name: subMap[session.subject_id]?.name || 'Subject',
          subject_code: subMap[session.subject_id]?.code || ''
        },
        roster,
        qr_count: qrCount,
        total_marked: totalMarked
      });
    }

    // Manual P / OD / A tick (Faculty & Admin only; CR cannot call this)
    if (action === 'set_student_tick') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;

      const { session_id, student_id, status } = body;
      if (sess.role === 'faculty') {
        const uRows = await sbFetch(`users?id=eq.${sess.id}&select=faculty_permissions`);
        const fp = uRows[0]?.faculty_permissions || {};
        if (fp.can_edit_attendance === false) {
          return res.status(403).json({ ok: false, error: 'Manual attendance editing is disabled for your account.' });
        }
        if (status === 'OD' && fp.can_mark_od === false) {
          return res.status(403).json({ ok: false, error: 'Marking On-Duty (OD) is disabled for your account.' });
        }
      }

      if (status === 'A') {
        await sbFetch(`attendance_records?session_id=eq.${session_id}&student_id=eq.${student_id}`, { method: 'DELETE' });
      } else {
        await sbFetch('attendance_records?on_conflict=session_id,student_id', {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=representation',
          body: JSON.stringify({ session_id, student_id, status, marked_via: 'MANUAL' })
        });
      }
      return res.json({ ok: true });
    }

    if (action === 'close_session') {
      const sess = requireRole(req, res, ['cr', 'faculty', 'admin']);
      if (!sess) return;
      await sbFetch(`attendance_sessions?id=eq.${body.session_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: false })
      });
      await logAudit('SESSION_CLOSED', sess.id, `Closed session ${body.session_id}`);
      return res.json({ ok: true });
    }

    if (action === 'email_attendance_self') {
      const user = requireRole(req, res, ['faculty', 'admin']);
      if (!user) return;
      if (!user.email || !user.email.includes('@')) {
        return res.status(400).json({ ok: false, error: 'Your profile has no valid email ID.' });
      }
      const smtp = await getSmtpCreds();
      if (!smtp) return res.status(400).json({ ok: false, error: 'Admin has not configured Gmail SMTP yet.' });

      const transporter = nodemailer.createTransport({ service: 'gmail', auth: smtp });
      await transporter.sendMail({
        from: `"SmartQR Attendance" <${smtp.user}>`,
        to: user.email,
        subject: String(body.subject || 'Lecture Attendance Report').slice(0, 200),
        text: String(body.text || '').slice(0, 20000)
      });
      return res.json({ ok: true });
    }

    // ================= LAZY ADMIN TAB ENDPOINTS =================
    if (action === 'admin_dashboard_summary') {
      const admin = await requireAdminPerm(req, res, null);
      if (!admin) return;

      const safeQuery = async (q, fb = []) => {
        try { return await sbFetch(q); } catch { return fb; }
      };

      const [users, classes, sessions, records, deviceReqs, logs] = await Promise.all([
        safeQuery('users?select=id,role,class_id,is_active'),
        safeQuery('classes?order=name.asc&select=id,name,code,semester'),
        safeQuery('attendance_sessions?select=id,class_id,class_ids,session_date,session_type,is_active'),
        safeQuery('attendance_records?select=session_id,student_id,status'),
        safeQuery('device_change_requests?status=eq.PENDING&select=id'),
        safeQuery('audit_logs?order=created_at.desc&limit=15&select=*')
      ]);

      const students = (users || []).filter(u => u.role === 'student' || u.role === 'cr');
      const faculty = (users || []).filter(u => u.role === 'faculty');
      const liveSessions = (sessions || []).filter(s => s.is_active);

      let totalP = 0, totalOD = 0;
      for (const r of records || []) {
        if (r.status === 'P') totalP++;
        else if (r.status === 'OD') totalOD++;
      }

      const classBreakdown = (classes || []).map(c => {
        const cStudents = students.filter(st => st.class_id === c.id);
        const cStuCount = cStudents.length;
        const cSessions = (sessions || []).filter(se => normalizeClassIds(se.class_id, se.class_ids).includes(c.id));
        const lecHeld = cSessions.length;
        const cSessIds = new Set(cSessions.map(se => se.id));
        const cRecs = (records || []).filter(r => cSessIds.has(r.session_id));

        let pCnt = 0, odCnt = 0;
        const attByStu = {};
        for (const r of cRecs) {
          if (r.status === 'P') pCnt++;
          if (r.status === 'OD') odCnt++;
          if (r.status === 'P' || r.status === 'OD') {
            attByStu[r.student_id] = (attByStu[r.student_id] || 0) + 1;
          }
        }

        const totalSlots = cStuCount * lecHeld;
        const presentPct = totalSlots > 0 ? Math.round((pCnt / totalSlots) * 1000) / 10 : 0;
        const odPct = totalSlots > 0 ? Math.round((odCnt / totalSlots) * 1000) / 10 : 0;
        const absCnt = Math.max(0, totalSlots - pCnt - odCnt);
        const absentPct = totalSlots > 0 ? Math.round((absCnt / totalSlots) * 1000) / 10 : 0;

        let defaulters = 0;
        if (lecHeld > 0) {
          for (const st of cStudents) {
            const pct = ((attByStu[st.id] || 0) / lecHeld) * 100;
            if (pct < 75) defaulters++;
          }
        }

        return {
          class_id: c.id,
          class_name: c.name,
          class_code: c.code,
          semester: c.semester || '',
          total_students: cStuCount,
          lectures_held: lecHeld,
          present_pct: presentPct,
          od_pct: odPct,
          absent_pct: absentPct,
          defaulters_count: defaulters
        };
      });

      return res.json({
        ok: true,
        kpis: {
          total_students: students.length,
          total_faculty: faculty.length,
          total_classes: (classes || []).length,
          live_sessions: liveSessions.length,
          pending_devices: (deviceReqs || []).length,
          total_p: totalP,
          total_od: totalOD
        },
        class_breakdown: classBreakdown,
        recent_logs: logs || []
      });
    }

    if (action === 'admin_tab_users') {
      const admin = await requireAdminPerm(req, res, null);
      if (!admin) return;
      const [users, classes] = await Promise.all([
        sbFetch('users?order=role.asc,roll_no.asc,full_name.asc&select=id,role,faculty_code,email,enrollment_no,roll_no,full_name,class_id,device_fp,is_active,is_super_admin,admin_permissions,faculty_permissions,classes(id,name,code)'),
        sbFetch('classes?order=name.asc&select=id,name,code,semester')
      ]);
      return res.json({ ok: true, users: users || [], classes: classes || [] });
    }

    if (action === 'admin_tab_academics') {
      const admin = await requireAdminPerm(req, res, null);
      if (!admin) return;
      const [classes, subjects, slots, faculty] = await Promise.all([
        sbFetch('classes?order=name.asc&select=*'),
        sbFetch('subjects?order=name.asc&select=*'),
        sbFetch('timetable_slots?order=version_no.desc,day_of_week.asc,start_time.asc&select=*'),
        sbFetch('users?role=eq.faculty&order=full_name.asc&select=id,faculty_code,full_name,email')
      ]);

      const clsMap = Object.fromEntries((classes || []).map(c => [c.id, c]));
      const subMap = Object.fromEntries((subjects || []).map(s => [s.id, s]));
      const facMap = Object.fromEntries((faculty || []).map(f => [f.id, f]));

      const enrichedSlots = (slots || []).map(sl => {
        const cIds = normalizeClassIds(sl.class_id, sl.class_ids);
        return {
          ...sl,
          class_ids: cIds,
          class_names: cIds.map(id => clsMap[id]?.name || 'Class'),
          class_codes: cIds.map(id => clsMap[id]?.code || ''),
          subject_name: subMap[sl.subject_id]?.name || 'Subject',
          subject_code: subMap[sl.subject_id]?.code || '',
          faculty_name: facMap[sl.faculty_id]?.full_name || 'Faculty',
          faculty_code: facMap[sl.faculty_id]?.faculty_code || ''
        };
      });

      return res.json({
        ok: true,
        classes: classes || [],
        subjects: subjects || [],
        slots: enrichedSlots,
        faculty: faculty || []
      });
    }

    if (action === 'admin_tab_sessions_reports') {
      const admin = await requireAdminPerm(req, res, null);
      if (!admin) return;
      const [sessions, classes, subjects, faculty, students, records] = await Promise.all([
        sbFetch('attendance_sessions?order=session_date.desc,created_at.desc&limit=100&select=*'),
        sbFetch('classes?order=name.asc&select=id,name,code'),
        sbFetch('subjects?order=name.asc&select=id,name,code'),
        sbFetch('users?role=eq.faculty&select=id,faculty_code,full_name,email'),
        sbFetch('users?role=in.(student,cr)&order=roll_no.asc&select=id,role,enrollment_no,roll_no,full_name,email,class_id'),
        sbFetch('attendance_records?select=session_id,student_id,status,marked_via,marked_at')
      ]);

      const clsMap = Object.fromEntries((classes || []).map(c => [c.id, c]));
      const subMap = Object.fromEntries((subjects || []).map(s => [s.id, s]));
      const facMap = Object.fromEntries((faculty || []).map(f => [f.id, f]));

      const enrichedSessions = (sessions || []).map(s => {
        const cIds = normalizeClassIds(s.class_id, s.class_ids);
        return {
          ...s,
          class_ids: cIds,
          class_label: cIds.map(id => clsMap[id]?.code || clsMap[id]?.name || 'Class').join(' + '),
          subject_name: subMap[s.subject_id]?.name || 'Subject',
          subject_code: subMap[s.subject_id]?.code || '',
          faculty_name: facMap[s.faculty_id]?.full_name || 'Faculty'
        };
      });

      return res.json({
        ok: true,
        sessions: enrichedSessions,
        classes: classes || [],
        subjects: subjects || [],
        faculty: faculty || [],
        students: students || [],
        records: records || []
      });
    }

    if (action === 'admin_tab_devices_logs') {
      const admin = await requireAdminPerm(req, res, null);
      if (!admin) return;
      const [deviceReqs, logs] = await Promise.all([
        sbFetch('device_change_requests?status=eq.PENDING&order=created_at.desc&select=*,classes(name,code)'),
        sbFetch('audit_logs?order=created_at.desc&limit=80&select=*')
      ]);
      return res.json({ ok: true, device_requests: deviceReqs || [], logs: logs || [] });
    }

    // Create User (student | cr | faculty)
    if (action === 'admin_create_user') {
      const admin = await requireAdminPerm(req, res, 'manage_users');
      if (!admin) return;

      const fullName = cleanNullableText(body.full_name);
      if (!fullName) return res.status(400).json({ ok: false, error: 'Full name is required.' });

      const role = ['student', 'cr', 'faculty'].includes(String(body.role || '').toLowerCase())
        ? String(body.role).toLowerCase()
        : 'student';

      try {
        const r = await sbRpc('rpc_admin_create_user_v8', {
          p_role: role,
          p_email: cleanNullableText(body.email, { lower: true }),
          p_enrollment_no: cleanNullableText(body.enrollment_no),
          p_roll_no: cleanNullableText(body.roll_no),
          p_full_name: fullName,
          p_class_id: role === 'faculty' ? null : cleanNullableText(body.class_id),
          p_password: cleanNullableText(body.password) || 'Pass@123',
          p_faculty_permissions: body.faculty_permissions || null,
          p_faculty_code: role === 'faculty' ? cleanNullableText(body.faculty_code) : null
        });
        if (r && r.ok === false) {
          return res.status(400).json({ ok: false, error: formatDbError({ message: r.error }) });
        }
        return res.json({ ok: true });
      } catch (err) {
        return res.status(400).json({ ok: false, error: formatDbError(err, 'Could not create user.') });
      }
    }

    // Update User (including promoting/demoting between student and cr)
    if (action === 'admin_update_user') {
      const admin = await requireAdminPerm(req, res, 'manage_users');
      if (!admin) return;

      const { user_id, role, full_name, email, enrollment_no, roll_no, class_id, is_active, new_password, reset_device, faculty_permissions, faculty_code } = body;
      if (!user_id) return res.status(400).json({ ok: false, error: 'Missing user_id.' });

      const cleanName = cleanNullableText(full_name);
      if (!cleanName) return res.status(400).json({ ok: false, error: 'Full name is required.' });

      const patch = {
        full_name: cleanName,
        email: cleanNullableText(email, { lower: true }),
        enrollment_no: cleanNullableText(enrollment_no),
        roll_no: cleanNullableText(roll_no),
        class_id: cleanNullableText(class_id),
        is_active: is_active !== false
      };
      if (role && ['student', 'cr', 'faculty', 'admin'].includes(role)) {
        patch.role = role;
      }
      if (faculty_code !== undefined) {
        patch.faculty_code = cleanNullableText(faculty_code);
      }
      if (reset_device) patch.device_fp = null;
      if (faculty_permissions) patch.faculty_permissions = faculty_permissions;

      try {
        await sbFetch(`users?id=eq.${user_id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch)
        });

        if (new_password && String(new_password).trim().length >= 4) {
          await sbRpc('rpc_admin_reset_password_v8', {
            p_user_id: user_id,
            p_new_password: String(new_password).trim()
          });
        }
        return res.json({ ok: true });
      } catch (err) {
        return res.status(400).json({ ok: false, error: formatDbError(err, 'Could not update user.') });
      }
    }

    // Bulk Import Users
    if (action === 'admin_bulk_import_users') {
      const admin = await requireAdminPerm(req, res, 'manage_users');
      if (!admin) return;
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return res.status(400).json({ ok: false, error: 'No valid CSV rows found.' });

      const classes = await sbFetch('classes?select=id,code,name');
      const clsByCode = {};
      (classes || []).forEach(c => {
        clsByCode[c.code.toLowerCase().trim()] = c.id;
        clsByCode[c.name.toLowerCase().trim()] = c.id;
      });

      let imported = 0;
      const errors = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          const roleRaw = (r.role || 'student').toLowerCase().trim();
          const role = ['student', 'cr', 'faculty'].includes(roleRaw) ? roleRaw : 'student';
          const clsId = r.class_code ? (clsByCode[r.class_code.toLowerCase().trim()] || null) : null;
          await sbRpc('rpc_admin_create_user_v8', {
            p_role: role,
            p_email: cleanNullableText(r.email, { lower: true }),
            p_enrollment_no: cleanNullableText(r.enrollment_no),
            p_roll_no: cleanNullableText(r.roll_no),
            p_full_name: cleanNullableText(r.full_name) || 'Student',
            p_class_id: role === 'faculty' ? null : clsId,
            p_password: cleanNullableText(r.password) || 'Pass@123',
            p_faculty_permissions: null,
            p_faculty_code: role === 'faculty' ? cleanNullableText(r.faculty_code) : null
          });
          imported++;
        } catch (e) {
          errors.push(`Row ${i + 1} (${r.full_name || r.enrollment_no || r.email}): ${formatDbError(e)}`);
        }
      }
      await logAudit('BULK_IMPORT_USERS', admin.id, `Imported ${imported} users (${errors.length} skipped)`);
      return res.json({ ok: true, imported, errors });
    }

    // Create Class with auto-generated unique code CLS-XXX
    if (action === 'admin_create_class') {
      const admin = await requireAdminPerm(req, res, 'manage_academics');
      if (!admin) return;
      const name = cleanNullableText(body.name);
      if (!name) return res.status(400).json({ ok: false, error: 'Class name is required.' });
      const code = cleanNullableText(body.code) || (await nextCode('CLS', 'classes', 'code'));
      try {
        const created = await sbFetch('classes', {
          method: 'POST',
          body: JSON.stringify({
            name,
            code: code.toUpperCase(),
            semester: cleanNullableText(body.semester) || ''
          })
        });
        return res.json({ ok: true, row: created[0] });
      } catch (err) {
        return res.status(400).json({ ok: false, error: formatDbError(err, 'Could not create class.') });
      }
    }

    // Create Subject with auto-generated unique code SUB-XXX
    if (action === 'admin_create_subject') {
      const admin = await requireAdminPerm(req, res, 'manage_academics');
      if (!admin) return;
      const name = cleanNullableText(body.name);
      if (!name) return res.status(400).json({ ok: false, error: 'Subject name is required.' });
      const code = cleanNullableText(body.code) || (await nextCode('SUB', 'subjects', 'code'));
      try {
        const created = await sbFetch('subjects', {
          method: 'POST',
          body: JSON.stringify({
            name,
            code: code.toUpperCase()
          })
        });
        return res.json({ ok: true, row: created[0] });
      } catch (err) {
        return res.status(400).json({ ok: false, error: formatDbError(err, 'Could not create subject.') });
      }
    }

    // Save Timetable Slot (supports merged classes & versioned history without altering past sessions)
    if (action === 'admin_save_timetable_slot') {
      const admin = await requireAdminPerm(req, res, 'manage_timetable');
      if (!admin) return;

      const mergedIds = normalizeClassIds(body.class_id, body.class_ids);
      const subjectId = cleanNullableText(body.subject_id);
      const facultyId = cleanNullableText(body.faculty_id);
      const dayOfWeek = Number(body.day_of_week ?? 1);
      const startTime = String(body.start_time || '09:00').trim();
      const endTime = String(body.end_time || '10:00').trim();

      if (!mergedIds.length || !subjectId || !facultyId) {
        return res.status(400).json({ ok: false, error: 'Select class(es), subject, and faculty.' });
      }

      const ist = getISTClock();
      const editId = cleanNullableText(body.slot_id);
      let nextVersion = 1;

      if (editId) {
        const oldRows = await sbFetch(`timetable_slots?id=eq.${editId}&select=*`);
        const oldSlot = oldRows[0];
        if (oldSlot) {
          nextVersion = Number(oldSlot.version_no || 1) + 1;
          await sbFetch(`timetable_slots?id=eq.${editId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              is_current: false,
              effective_to: ist.dateStr
            })
          });
        }
      } else {
        const existingCurrent = await sbFetch(`timetable_slots?class_id=eq.${mergedIds[0]}&day_of_week=eq.${dayOfWeek}&start_time=eq.${encodeURIComponent(startTime)}&is_current=eq.true&select=id,version_no`);
        if (existingCurrent && existingCurrent.length > 0) {
          const maxV = Math.max(...existingCurrent.map(x => Number(x.version_no || 1)));
          nextVersion = maxV + 1;
          for (const ex of existingCurrent) {
            await sbFetch(`timetable_slots?id=eq.${ex.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ is_current: false, effective_to: ist.dateStr })
            });
          }
        }
      }

      const created = await sbFetch('timetable_slots', {
        method: 'POST',
        body: JSON.stringify({
          class_id: mergedIds[0],
          class_ids: mergedIds,
          subject_id: subjectId,
          faculty_id: facultyId,
          day_of_week: dayOfWeek,
          start_time: startTime,
          end_time: endTime,
          version_no: nextVersion,
          is_current: true,
          effective_from: ist.dateStr
        })
      });

      return res.json({ ok: true, row: created[0], version_no: nextVersion });
    }

    // Bulk Import Timetable
    if (action === 'admin_bulk_import_timetable') {
      const admin = await requireAdminPerm(req, res, 'manage_timetable');
      if (!admin) return;
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return res.status(400).json({ ok: false, error: 'No timetable rows provided.' });

      const [classes, subjects, faculty] = await Promise.all([
        sbFetch('classes?select=id,code,name'),
        sbFetch('subjects?select=id,code,name'),
        sbFetch('users?role=eq.faculty&select=id,faculty_code,email,full_name')
      ]);

      const clsMap = {};
      (classes || []).forEach(c => {
        clsMap[c.code.toLowerCase()] = c.id;
        clsMap[c.name.toLowerCase()] = c.id;
      });
      const subMap = {};
      (subjects || []).forEach(s => {
        subMap[s.code.toLowerCase()] = s.id;
        subMap[s.name.toLowerCase()] = s.id;
      });
      const facMap = {};
      (faculty || []).forEach(f => {
        if (f.email) facMap[f.email.toLowerCase()] = f.id;
        if (f.faculty_code) facMap[f.faculty_code.toLowerCase()] = f.id;
        facMap[f.full_name.toLowerCase()] = f.id;
      });

      const ist = getISTClock();
      let imported = 0;
      const errors = [];

      let createdClasses = 0;
      let createdSubjects = 0;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const rawClsStr = cleanNullableText(r.class_code) || '';
        const rawClsTokens = rawClsStr.split(/[+|;]/).map(s => cleanNullableText(s)).filter(Boolean);
        const cIds = [];

        for (const tok of rawClsTokens) {
          const key = tok.toLowerCase();
          if (clsMap[key]) {
            cIds.push(clsMap[key]);
          } else {
            const newCode = tok.toUpperCase().replace(/\s+/g, '-').slice(0, 24);
            const createdCls = await sbFetch('classes', {
              method: 'POST',
              body: JSON.stringify({ name: tok, code: newCode, semester: '' })
            });
            if (createdCls?.[0]?.id) {
              clsMap[key] = createdCls[0].id;
              clsMap[newCode.toLowerCase()] = createdCls[0].id;
              cIds.push(createdCls[0].id);
              createdClasses++;
            }
          }
        }

        const uniqueCIds = [...new Set(cIds)];
        const rawSub = cleanNullableText(r.subject_code) || '';
        let sId = rawSub ? subMap[rawSub.toLowerCase()] : null;
        if (!sId && rawSub) {
          const newSubCode = rawSub.toUpperCase().replace(/\s+/g, '-').slice(0, 24);
          const subName = cleanNullableText(r.subject_name) || rawSub;
          const createdSub = await sbFetch('subjects', {
            method: 'POST',
            body: JSON.stringify({ name: subName, code: newSubCode })
          });
          if (createdSub?.[0]?.id) {
            sId = createdSub[0].id;
            subMap[rawSub.toLowerCase()] = sId;
            subMap[newSubCode.toLowerCase()] = sId;
            createdSubjects++;
          }
        }

        const facKey = (cleanNullableText(r.faculty_email, { lower: true }) || cleanNullableText(r.faculty_code, { lower: true }) || '');
        const fId = facKey ? facMap[facKey] : null;

        if (!uniqueCIds.length || !sId || !fId) {
          errors.push(`Row ${i + 1}: Missing Class '${rawClsStr}', Subject '${rawSub}', or Faculty '${facKey}'.`);
          continue;
        }

        await sbFetch('timetable_slots', {
          method: 'POST',
          body: JSON.stringify({
            class_id: uniqueCIds[0],
            class_ids: uniqueCIds,
            subject_id: sId,
            faculty_id: fId,
            day_of_week: parseDayOfWeek(r.day_of_week),
            start_time: normalizeTimeHHMM(r.start_time, '09:00'),
            end_time: normalizeTimeHHMM(r.end_time, '10:00'),
            version_no: 1,
            is_current: true,
            effective_from: ist.dateStr
          })
        });
        imported++;
      }

      await logAudit('BULK_IMPORT_TIMETABLE', admin.id, `Imported ${imported} slots (Auto-created ${createdClasses} classes, ${createdSubjects} subjects)`);
      return res.json({ ok: true, imported, created_classes: createdClasses, created_subjects: createdSubjects, errors });
    }

    if (action === 'admin_save_settings') {
      const admin = await requireAdminPerm(req, res, 'manage_settings');
      if (!admin) return;
      const r = await sbRpc('rpc_update_settings_v8', { p_patch: body.patch || {} });
      await logAudit('SETTINGS_UPDATED', admin.id, `Updated system settings (QR Timer: ${body.patch?.qr_interval_seconds || '-'}s)`);
      return res.json(r);
    }

    if (action === 'admin_test_smtp') {
      const admin = await requireAdminPerm(req, res, 'manage_settings');
      if (!admin) return;
      const smtp = await getSmtpCreds();
      if (!smtp) return res.status(400).json({ ok: false, error: 'Save Gmail & App Password first.' });
      const transporter = nodemailer.createTransport({ service: 'gmail', auth: smtp });
      await transporter.sendMail({
        from: `"SmartQR Attendance" <${smtp.user}>`,
        to: admin.email || smtp.user,
        subject: 'SmartQR v8.0 SMTP Test — Active!',
        text: `Automated Gmail SMTP (${smtp.user}) is configured and working.`
      });
      return res.json({ ok: true });
    }

    if (action === 'admin_update_class_geo') {
      const admin = await requireAdminPerm(req, res, 'manage_geofence');
      if (!admin) return;
      const { class_id, custom_geo_enabled, custom_lat, custom_lng, custom_radius_meters } = body;
      await sbFetch(`classes?id=eq.${class_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          custom_geo_enabled: Boolean(custom_geo_enabled),
          custom_lat: custom_geo_enabled ? Number(custom_lat) : null,
          custom_lng: custom_geo_enabled ? Number(custom_lng) : null,
          custom_radius_meters: Number(custom_radius_meters || 150)
        })
      });
      return res.json({ ok: true });
    }

    if (action === 'admin_assign_proxy') {
      const admin = await requireAdminPerm(req, res, 'assign_proxy');
      if (!admin) return;
      const mergedIds = normalizeClassIds(body.class_id, body.class_ids);
      const subjectId = cleanNullableText(body.subject_id);
      const subFacId = cleanNullableText(body.substitute_faculty_id);
      if (!mergedIds.length || !subjectId || !subFacId) {
        return res.status(400).json({ ok: false, error: 'Select Class, Subject, and Substitute Faculty.' });
      }
      const ist = getISTClock();
      const sCode = await nextSessionCode(ist.dateStr);
      const nonce = crypto.randomBytes(6).toString('hex');
      const created = await sbFetch('attendance_sessions', {
        method: 'POST',
        body: JSON.stringify({
          session_code: sCode,
          class_id: mergedIds[0],
          class_ids: mergedIds,
          subject_id: subjectId,
          faculty_id: subFacId,
          session_date: ist.dateStr,
          current_nonce: nonce,
          is_active: true,
          session_type: 'PROXY',
          assigned_by_admin: admin.id
        })
      });
      await sbFetch('audit_logs', {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'PROXY_ASSIGNED',
          actor_id: admin.id,
          details: `Session ${sCode} assigned to faculty ${subFacId}`
        })
      });
      return res.json({ ok: true, session: created[0] });
    }

    if (action === 'admin_review_device_req') {
      const admin = await requireAdminPerm(req, res, 'approve_devices');
      if (!admin) return;
      const { request_id, decision } = body;
      const reqRows = await sbFetch(`device_change_requests?id=eq.${request_id}&select=*`);
      const reqItem = reqRows[0];
      if (!reqItem) return res.status(404).json({ ok: false, error: 'Request not found.' });

      if (decision === 'APPROVED') {
        await sbFetch(`users?id=eq.${reqItem.student_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ device_fp: reqItem.new_device_fp })
        });
      }
      await sbFetch(`device_change_requests?id=eq.${request_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: decision, reviewed_by: admin.id, reviewed_at: new Date().toISOString() })
      });
      await logAudit('DEVICE_' + decision, admin.id, `${decision} device request for ${reqItem.student_name} (${reqItem.roll_no})`);
      return res.json({ ok: true });
    }

    if (action === 'admin_save_subadmin_perms') {
      const admin = await requireAdminPerm(req, res, 'manage_admins');
      if (!admin) return;
      const { target_user_id, email, full_name, password, admin_permissions, is_active } = body;

      try {
        if (target_user_id) {
          await sbFetch(`users?id=eq.${target_user_id}&role=eq.admin`, {
            method: 'PATCH',
            body: JSON.stringify({
              full_name: cleanNullableText(full_name),
              email: cleanNullableText(email, { lower: true }),
              admin_permissions,
              is_active: is_active !== false
            })
          });
          if (password && password.length >= 4) {
            await sbRpc('rpc_admin_reset_password_v8', { p_user_id: target_user_id, p_new_password: password });
          }
        } else {
          await sbRpc('rpc_admin_create_user_v8', {
            p_role: 'admin',
            p_email: cleanNullableText(email, { lower: true }),
            p_enrollment_no: null,
            p_roll_no: null,
            p_full_name: cleanNullableText(full_name),
            p_class_id: null,
            p_password: password || 'Admin@123',
            p_faculty_permissions: null,
            p_faculty_code: null
          });
          const cleanEmail = cleanNullableText(email, { lower: true });
          if (cleanEmail) {
            const created = await sbFetch(`users?email=eq.${encodeURIComponent(cleanEmail)}&role=eq.admin&select=id`);
            if (created[0]) {
              await sbFetch(`users?id=eq.${created[0].id}`, {
                method: 'PATCH',
                body: JSON.stringify({ is_super_admin: false, admin_permissions })
              });
            }
          }
        }
        return res.json({ ok: true });
      } catch (err) {
        return res.status(400).json({ ok: false, error: formatDbError(err, 'Could not save Sub-Admin.') });
      }
    }

    if (action === 'admin_delete_entity') {
      const { table, id } = body;
      const permMap = {
        users: 'manage_users',
        classes: 'manage_academics',
        subjects: 'manage_academics',
        timetable_slots: 'manage_timetable'
      };
      const admin = await requireAdminPerm(req, res, permMap[table] || 'manage_settings');
      if (!admin) return;
      await sbFetch(`${table}?id=eq.${id}`, { method: 'DELETE' });
      return res.json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
};
