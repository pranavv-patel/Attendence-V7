const crypto = require('crypto');
const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || 'smartqr-v7-production-secret-key';

function cleanNullableText(val, { lower = false } = {}) {
  if (val === undefined || val === null) return null;
  const trimmed = String(val).trim();
  if (!trimmed) return null;
  return lower ? trimmed.toLowerCase() : trimmed;
}

function formatDbError(err, fallback = 'Database operation failed.') {
  const msg = String(err?.message || err || '');
  if (
    msg.includes('23505') ||
    msg.includes('duplicate key') ||
    msg.includes('idx_users_email_unique') ||
    msg.includes('idx_users_enrollment_unique')
  ) {
    if (msg.toLowerCase().includes('enrollment')) {
      return 'A user with this Enrollment No already exists.';
    }
    if (msg.toLowerCase().includes('email')) {
      return 'A user with this Email ID already exists.';
    }
    return 'Duplicate record: Email or Enrollment No already exists.';
  }
  return msg || fallback;
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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = req.query.action || body.action;

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

    if (action === 'whoami') {
      const sess = getSession(req);
      if (!sess) return res.json({ ok: true, user: null });
      const rows = await sbFetch(`users?id=eq.${sess.id}&select=id,role,email,enrollment_no,roll_no,full_name,class_id,device_fp,is_super_admin,admin_permissions,faculty_permissions,classes(name,code)`);
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
      if (!identifier || !password) return res.status(400).json({ ok: false, error: 'Enter Enrollment No / Email and password.' });

      const authRes = await sbRpc('rpc_verify_login_v7', { p_identifier: identifier, p_password: password });
      if (!authRes?.ok) return res.status(401).json({ ok: false, error: authRes?.error || 'Invalid credentials.' });

      const u = authRes.user;
      if (u.role === 'student' && deviceFp) {
        if (!u.device_fp) {
          await sbFetch(`users?id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ device_fp: deviceFp }) });
        } else if (u.device_fp !== deviceFp) {
          return res.status(403).json({
            ok: false,
            error: 'DEVICE_MISMATCH',
            student_id: u.id,
            student_name: u.full_name,
            enrollment_no: u.enrollment_no,
            roll_no: u.roll_no,
            class_id: u.class_id,
            message: 'Account locked to another device. Submit a Device Update Request to Admin.'
          });
        }
      }

      setSessionCookie(res, { id: u.id, role: u.role, email: u.email, full_name: u.full_name });
      const fullRows = await sbFetch(`users?id=eq.${u.id}&select=id,role,email,enrollment_no,roll_no,full_name,class_id,device_fp,is_super_admin,admin_permissions,faculty_permissions,classes(name,code)`);
      return res.json({ ok: true, user: fullRows[0] });
    }

    if (action === 'change_password') {
      const sess = requireRole(req, res, ['student', 'faculty', 'admin']);
      if (!sess) return;
      const { current_password, new_password } = body;
      if (!new_password || new_password.length < 4) {
        return res.status(400).json({ ok: false, error: 'New password must be at least 4 characters.' });
      }
      const r = await sbRpc('rpc_change_password_v5', {
        p_user_id: sess.id,
        p_old_password: current_password || '',
        p_new_password: new_password
      });
      if (!r?.ok) return res.status(400).json({ ok: false, error: r?.error || 'Password update failed.' });
      return res.json({ ok: true });
    }

    if (action === 'request_device_change') {
      const { student_id, new_device_fp, reason } = body;
      if (!student_id || !new_device_fp) return res.status(400).json({ ok: false, error: 'Missing device info.' });
      const stuRows = await sbFetch(`users?id=eq.${student_id}&role=eq.student&select=id,full_name,roll_no,enrollment_no,class_id`);
      const stu = stuRows[0];
      if (!stu) return res.status(404).json({ ok: false, error: 'Student not found.' });

      const existing = await sbFetch(`device_change_requests?student_id=eq.${student_id}&status=eq.PENDING&select=id`);
      if (existing.length > 0) {
        return res.json({ ok: true, message: 'You already have a pending request. Ask Admin to approve it.' });
      }

      await sbFetch('device_change_requests', {
        method: 'POST',
        body: JSON.stringify({
          student_id: stu.id,
          roll_no: stu.enrollment_no || stu.roll_no || '-',
          student_name: stu.full_name,
          class_id: stu.class_id,
          new_device_fp,
          reason: String(reason || 'New phone / browser reset').slice(0, 200)
        })
      });
      return res.json({ ok: true, message: 'Device update request sent to Admin!' });
    }

    if (action === 'student_dashboard') {
      const sess = requireRole(req, res, ['student']);
      if (!sess) return;
      const uRows = await sbFetch(`users?id=eq.${sess.id}&select=id,full_name,enrollment_no,roll_no,email,class_id,classes(name,code)`);
      const stu = uRows[0];
      const sessions = stu?.class_id
        ? await sbFetch(`attendance_sessions?class_id=eq.${stu.class_id}&select=id,subject_id,session_date,subjects(name,code)`)
        : [];
      const records = await sbFetch(`attendance_records?student_id=eq.${sess.id}&select=session_id,status`);
      const recMap = Object.fromEntries(records.map(r => [r.session_id, r.status]));

      const subjStats = {};
      for (const s of sessions) {
        const key = s.subject_id;
        if (!subjStats[key]) {
          subjStats[key] = { subject_name: s.subjects?.name || 'Subject', subject_code: s.subjects?.code || '', total: 0, attended: 0 };
        }
        subjStats[key].total += 1;
        if (recMap[s.id] === 'P' || recMap[s.id] === 'OD') subjStats[key].attended += 1;
      }
      return res.json({ ok: true, student: stu, summary: Object.values(subjStats) });
    }

    if (action === 'submit_qr') {
      const sess = requireRole(req, res, ['student']);
      if (!sess) return;
      const r = await sbRpc('rpc_submit_qr_v6', {
        p_session_id: body.session_id,
        p_student_id: sess.id,
        p_nonce: body.nonce,
        p_device_fp: body.device_fp,
        p_lat: body.lat ?? null,
        p_lng: body.lng ?? null
      });
      return res.json(r);
    }

    if (action === 'faculty_init') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;

      const uRows = await sbFetch(`users?id=eq.${sess.id}&select=faculty_permissions`);
      const fPerms = uRows[0]?.faculty_permissions || {};
      const slots = await sbFetch(`timetable_slots?faculty_id=eq.${sess.id}&select=*,classes(id,name,code,custom_geo_enabled,custom_radius_meters),subjects(id,name,code)`);
      const activeSessions = await sbFetch(`attendance_sessions?faculty_id=eq.${sess.id}&is_active=eq.true&select=*,classes(name,code),subjects(name,code)`);
      const settings = (await sbFetch('system_settings?id=eq.1&select=allow_extra_lectures,geofence_enabled,qr_interval_seconds'))[0] || {};

      const pairMap = {};
      for (const sl of slots) {
        const k = `${sl.class_id}_${sl.subject_id}`;
        if (!pairMap[k]) {
          pairMap[k] = {
            key: k,
            class_id: sl.class_id,
            class_name: sl.classes?.name || 'Class',
            class_code: sl.classes?.code || '',
            subject_id: sl.subject_id,
            subject_name: sl.subjects?.name || 'Subject',
            subject_code: sl.subjects?.code || ''
          };
        }
      }
      for (const as of activeSessions) {
        const k = `${as.class_id}_${as.subject_id}`;
        if (!pairMap[k]) {
          pairMap[k] = {
            key: k,
            class_id: as.class_id,
            class_name: as.classes?.name || 'Class',
            class_code: as.classes?.code || '',
            subject_id: as.subject_id,
            subject_name: as.subjects?.name || 'Subject',
            subject_code: as.subjects?.code || ''
          };
        }
      }

      return res.json({
        ok: true,
        assigned_pairs: Object.values(pairMap),
        slots,
        active_sessions: activeSessions,
        settings,
        faculty_permissions: fPerms
      });
    }

    if (action === 'faculty_class_dashboard') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;
      const { class_id, subject_id } = body;
      if (!class_id || !subject_id) return res.status(400).json({ ok: false, error: 'Select a class and subject.' });

      const students = await sbFetch(`users?role=eq.student&class_id=eq.${class_id}&is_active=eq.true&order=roll_no.asc&select=id,enrollment_no,roll_no,full_name,email`);
      const sessions = await sbFetch(`attendance_sessions?class_id=eq.${class_id}&subject_id=eq.${subject_id}&order=session_date.desc&select=id,session_date,session_type,is_active`);
      const sessIds = sessions.map(s => s.id);
      const records = sessIds.length
        ? await sbFetch(`attendance_records?session_id=in.(${sessIds.join(',')})&select=session_id,student_id,status`)
        : [];

      const totalLectures = sessions.length;
      const roster = students.map(st => {
        const stRecs = records.filter(r => r.student_id === st.id);
        const pCount = stRecs.filter(r => r.status === 'P').length;
        const odCount = stRecs.filter(r => r.status === 'OD').length;
        const attended = pCount + odCount;
        const pct = totalLectures > 0 ? Math.round((attended / totalLectures) * 100) : 100;
        return { ...st, p_count: pCount, od_count: odCount, attended, total_lectures: totalLectures, percentage: pct };
      });

      const avgPct = roster.length
        ? Math.round(roster.reduce((acc, r) => acc + r.percentage, 0) / roster.length)
        : 0;

      return res.json({ ok: true, total_lectures: totalLectures, average_pct: avgPct, roster });
    }

    if (action === 'start_session') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;
      const { class_id, subject_id, session_type, geofence_override } = body;
      const stype = session_type === 'EXTRA' ? 'EXTRA' : 'REGULAR';

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

      const nonce = crypto.randomBytes(6).toString('hex');
      const created = await sbFetch('attendance_sessions', {
        method: 'POST',
        body: JSON.stringify({
          class_id,
          subject_id,
          faculty_id: sess.id,
          current_nonce: nonce,
          is_active: true,
          session_type: stype,
          geofence_override: typeof geofence_override === 'boolean' ? geofence_override : null
        })
      });
      return res.json({ ok: true, session: created[0] });
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
      const { session_id, geofence_override } = body;
      await sbFetch(`attendance_sessions?id=eq.${session_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ geofence_override: Boolean(geofence_override) })
      });
      return res.json({ ok: true });
    }

    if (action === 'rotate_nonce') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;
      const nonce = crypto.randomBytes(6).toString('hex');
      await sbFetch(`attendance_sessions?id=eq.${body.session_id}&is_active=eq.true`, {
        method: 'PATCH',
        body: JSON.stringify({ current_nonce: nonce })
      });
      return res.json({ ok: true, nonce });
    }

    if (action === 'session_roster') {
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;
      const { session_id } = body;
      const sRows = await sbFetch(`attendance_sessions?id=eq.${session_id}&select=*,classes(id,name,code),subjects(id,name,code)`);
      const session = sRows[0];
      if (!session) return res.status(404).json({ ok: false, error: 'Session not found.' });

      const students = await sbFetch(`users?role=eq.student&class_id=eq.${session.class_id}&is_active=eq.true&order=roll_no.asc&select=id,enrollment_no,roll_no,full_name`);
      const records = await sbFetch(`attendance_records?session_id=eq.${session_id}&select=student_id,status,marked_via`);
      const recMap = Object.fromEntries(records.map(r => [r.student_id, r]));

      const roster = students.map(st => ({
        ...st,
        status: recMap[st.id]?.status || 'A',
        marked_via: recMap[st.id]?.marked_via || null
      }));
      return res.json({ ok: true, session, roster });
    }

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
      const sess = requireRole(req, res, ['faculty', 'admin']);
      if (!sess) return;
      await sbFetch(`attendance_sessions?id=eq.${body.session_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: false })
      });
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

    if (action === 'admin_overview') {
      const admin = await requireAdminPerm(req, res, null);
      if (!admin) return;

      const safeQuery = async (query, fallback = []) => {
        try {
          return await sbFetch(query);
        } catch {
          return fallback;
        }
      };

      const [users, classes, subjects, slots, activeSessions, deviceReqs, logs] = await Promise.all([
        sbFetch('users?order=role.asc,roll_no.asc,full_name.asc&select=id,role,email,enrollment_no,roll_no,full_name,class_id,device_fp,is_active,is_super_admin,admin_permissions,faculty_permissions,classes(name,code)'),
        sbFetch('classes?order=name.asc&select=*'),
        sbFetch('subjects?order=name.asc&select=*'),
        safeQuery('timetable_slots?order=day_of_week.asc,start_time.asc&select=*,classes(name,code),subjects(name,code),users(full_name,email)'),
        safeQuery('attendance_sessions?is_active=eq.true&select=*,classes(name,code),subjects(name,code),users!attendance_sessions_faculty_id_fkey(full_name)'),
        safeQuery('device_change_requests?status=eq.PENDING&order=created_at.desc&select=*,classes(name,code)'),
        safeQuery('audit_logs?order=created_at.desc&limit=50&select=*')
      ]);

      return res.json({
        ok: true,
        admin,
        users: users || [],
        classes: classes || [],
        subjects: subjects || [],
        slots: slots || [],
        active_sessions: activeSessions || [],
        device_requests: deviceReqs || [],
        logs: logs || []
      });
    }

    if (action === 'admin_create_user') {
      const admin = await requireAdminPerm(req, res, 'manage_users');
      if (!admin) return;

      const fullName = cleanNullableText(body.full_name);
      if (!fullName) return res.status(400).json({ ok: false, error: 'Full name is required.' });

      try {
        const r = await sbRpc('rpc_admin_create_user_v7', {
          p_role: body.role,
          p_email: cleanNullableText(body.email, { lower: true }),
          p_enrollment_no: cleanNullableText(body.enrollment_no),
          p_roll_no: cleanNullableText(body.roll_no),
          p_full_name: fullName,
          p_class_id: cleanNullableText(body.class_id),
          p_password: cleanNullableText(body.password) || 'Pass@123',
          p_faculty_permissions: body.faculty_permissions || null
        });
        if (r && r.ok === false) {
          return res.status(400).json({ ok: false, error: formatDbError({ message: r.error }) });
        }
        return res.json({ ok: true });
      } catch (err) {
        return res.status(400).json({ ok: false, error: formatDbError(err, 'Could not create user.') });
      }
    }

    if (action === 'admin_update_user') {
      const admin = await requireAdminPerm(req, res, 'manage_users');
      if (!admin) return;

      const { user_id, full_name, email, enrollment_no, roll_no, class_id, is_active, new_password, reset_device, faculty_permissions } = body;
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
      if (reset_device) patch.device_fp = null;
      if (faculty_permissions) patch.faculty_permissions = faculty_permissions;

      try {
        await sbFetch(`users?id=eq.${user_id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch)
        });

        if (new_password && String(new_password).trim().length >= 4) {
          await sbRpc('rpc_admin_reset_password_v5', {
            p_user_id: user_id,
            p_new_password: String(new_password).trim()
          });
        }
        return res.json({ ok: true });
      } catch (err) {
        return res.status(400).json({ ok: false, error: formatDbError(err, 'Could not update user.') });
      }
    }

    if (action === 'admin_bulk_import_users') {
      const admin = await requireAdminPerm(req, res, 'manage_users');
      if (!admin) return;
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return res.status(400).json({ ok: false, error: 'No valid CSV rows found.' });

      const classes = await sbFetch('classes?select=id,code,name');
      const clsByCode = {};
      classes.forEach(c => {
        clsByCode[c.code.toLowerCase().trim()] = c.id;
        clsByCode[c.name.toLowerCase().trim()] = c.id;
      });

      let imported = 0;
      const errors = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          const role = (r.role || 'student').toLowerCase().trim();
          const clsId = r.class_code ? (clsByCode[r.class_code.toLowerCase().trim()] || null) : null;
          await sbRpc('rpc_admin_create_user_v7', {
            p_role: ['student', 'faculty'].includes(role) ? role : 'student',
            p_email: cleanNullableText(r.email, { lower: true }),
            p_enrollment_no: cleanNullableText(r.enrollment_no),
            p_roll_no: cleanNullableText(r.roll_no),
            p_full_name: cleanNullableText(r.full_name) || 'Student',
            p_class_id: clsId,
            p_password: cleanNullableText(r.password) || 'Pass@123',
            p_faculty_permissions: null
          });
          imported++;
        } catch (e) {
          errors.push(`Row ${i + 1} (${r.full_name || r.enrollment_no || r.email}): ${formatDbError(e)}`);
        }
      }
      return res.json({ ok: true, imported, errors });
    }

    if (action === 'admin_bulk_import_timetable') {
      const admin = await requireAdminPerm(req, res, 'manage_timetable');
      if (!admin) return;
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return res.status(400).json({ ok: false, error: 'No timetable rows provided.' });

      const [classes, subjects, faculty] = await Promise.all([
        sbFetch('classes?select=id,code,name'),
        sbFetch('subjects?select=id,code,name'),
        sbFetch('users?role=eq.faculty&select=id,email,full_name')
      ]);

      const clsMap = {};
      classes.forEach(c => { clsMap[c.code.toLowerCase()] = c.id; clsMap[c.name.toLowerCase()] = c.id; });
      const subMap = {};
      subjects.forEach(s => { subMap[s.code.toLowerCase()] = s.id; subMap[s.name.toLowerCase()] = s.id; });
      const facMap = {};
      faculty.forEach(f => {
        if (f.email) facMap[f.email.toLowerCase()] = f.id;
        facMap[f.full_name.toLowerCase()] = f.id;
      });

      let imported = 0;
      const errors = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const cId = clsMap[(r.class_code || '').toLowerCase().trim()];
        const sId = subMap[(r.subject_code || '').toLowerCase().trim()];
        const fId = facMap[(r.faculty_email || '').toLowerCase().trim()];
        if (!cId || !sId || !fId) {
          errors.push(`Row ${i + 1}: Could not match Class '${r.class_code}', Subject '${r.subject_code}', or Faculty '${r.faculty_email}'.`);
          continue;
        }
        await sbFetch('timetable_slots', {
          method: 'POST',
          body: JSON.stringify({
            class_id: cId,
            subject_id: sId,
            faculty_id: fId,
            day_of_week: Number(r.day_of_week || 1),
            start_time: r.start_time || '09:00',
            end_time: r.end_time || '10:00'
          })
        });
        imported++;
      }
      return res.json({ ok: true, imported, errors });
    }

    if (action === 'admin_save_settings') {
      const admin = await requireAdminPerm(req, res, 'manage_settings');
      if (!admin) return;
      const r = await sbRpc('rpc_update_settings_v6', { p_patch: body.patch || {} });
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
        subject: 'SmartQR v7.1 SMTP Test — Active!',
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
      const { class_id, subject_id, substitute_faculty_id } = body;
      if (!class_id || !subject_id || !substitute_faculty_id) {
        return res.status(400).json({ ok: false, error: 'Select Class, Subject, and Substitute Faculty.' });
      }
      const nonce = crypto.randomBytes(6).toString('hex');
      const created = await sbFetch('attendance_sessions', {
        method: 'POST',
        body: JSON.stringify({
          class_id,
          subject_id,
          faculty_id: substitute_faculty_id,
          current_nonce: nonce,
          is_active: true,
          session_type: 'PROXY',
          assigned_by_admin: admin.id
        })
      });
      await sbFetch('audit_logs', {
        method: 'POST',
        body: JSON.stringify({ event_type: 'PROXY_ASSIGNED', actor_id: admin.id, details: `Admin assigned proxy lecture to faculty ${substitute_faculty_id}` })
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
            await sbRpc('rpc_admin_reset_password_v5', { p_user_id: target_user_id, p_new_password: password });
          }
        } else {
          await sbRpc('rpc_admin_create_user_v7', {
            p_role: 'admin',
            p_email: cleanNullableText(email, { lower: true }),
            p_enrollment_no: null,
            p_roll_no: null,
            p_full_name: cleanNullableText(full_name),
            p_class_id: null,
            p_password: password || 'Admin@123',
            p_faculty_permissions: null
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

    if (action === 'admin_export_backup') {
      const admin = await requireAdminPerm(req, res, 'view_reports');
      if (!admin) return;
      const [classes, subjects, students, sessions, records] = await Promise.all([
        sbFetch('classes?select=id,name,code'),
        sbFetch('subjects?select=id,name,code'),
        sbFetch('users?role=eq.student&order=roll_no.asc&select=id,enrollment_no,roll_no,full_name,email,class_id'),
        sbFetch('attendance_sessions?order=session_date.desc&select=id,class_id,subject_id,session_date,session_type'),
        sbFetch('attendance_records?select=session_id,student_id,status,marked_via,marked_at')
      ]);
      return res.json({ ok: true, classes, subjects, students, sessions, records });
    }

    if (action === 'admin_create_entity') {
      const { table, data } = body;
      const permMap = { classes: 'manage_academics', subjects: 'manage_academics', timetable_slots: 'manage_timetable' };
      const admin = await requireAdminPerm(req, res, permMap[table] || 'manage_settings');
      if (!admin) return;
      const created = await sbFetch(table, { method: 'POST', body: JSON.stringify(data) });
      return res.json({ ok: true, row: created[0] });
    }

    if (action === 'admin_delete_entity') {
      const { table, id } = body;
      const permMap = { users: 'manage_users', classes: 'manage_academics', subjects: 'manage_academics', timetable_slots: 'manage_timetable' };
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
