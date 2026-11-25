-- ============================================================================
-- SMARTQR ATTENDANCE v8.0 PRODUCTION SCHEMA, RBAC, TIMETABLE VERSIONS & RPCS
-- Safe to run on a fresh Supabase project OR upgrade an existing database.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. System Settings
CREATE TABLE IF NOT EXISTS system_settings (
  id INT PRIMARY KEY DEFAULT 1,
  app_title TEXT DEFAULT 'SmartQR Attendance',
  college_name TEXT DEFAULT 'Parul University • FMS',
  login_subtitle TEXT DEFAULT 'Enterprise Anti-Proxy Classroom Attendance',
  logo_url TEXT DEFAULT 'assets/logo.png',
  primary_color TEXT DEFAULT '#38bdf8',
  default_theme TEXT DEFAULT 'dark',
  qr_interval_seconds INT DEFAULT 15,
  session_timeout_minutes INT DEFAULT 60,
  enforce_lecture_time BOOLEAN DEFAULT FALSE,
  allow_extra_lectures BOOLEAN DEFAULT TRUE,
  geofence_enabled BOOLEAN DEFAULT FALSE,
  campus_lat DOUBLE PRECISION,
  campus_lng DOUBLE PRECISION,
  geofence_radius_meters INT DEFAULT 150,
  smtp_email TEXT DEFAULT '',
  smtp_app_password TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO system_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 2. Classes (with auto-generated unique code CLS-XXX)
CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  semester TEXT DEFAULT '',
  custom_geo_enabled BOOLEAN DEFAULT FALSE,
  custom_lat DOUBLE PRECISION,
  custom_lng DOUBLE PRECISION,
  custom_radius_meters INT DEFAULT 150,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Subjects (with auto-generated unique code SUB-XXX)
CREATE TABLE IF NOT EXISTS subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Users (student | cr | faculty | admin)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('student', 'cr', 'faculty', 'admin')),
  faculty_code TEXT,
  email TEXT,
  enrollment_no TEXT,
  roll_no TEXT,
  full_name TEXT NOT NULL,
  class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  password_hash TEXT NOT NULL,
  device_fp TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  is_super_admin BOOLEAN DEFAULT FALSE,
  admin_permissions JSONB DEFAULT '{
    "manage_users": true,
    "manage_academics": true,
    "manage_timetable": true,
    "assign_proxy": true,
    "approve_devices": true,
    "manage_geofence": true,
    "manage_settings": true,
    "view_reports": true,
    "manage_admins": false
  }'::jsonb,
  faculty_permissions JSONB DEFAULT '{
    "can_start_regular": true,
    "can_start_extra": true,
    "can_mark_od": true,
    "can_edit_attendance": true,
    "can_toggle_gps": true,
    "can_export_reports": true
  }'::jsonb,
  failed_attempts INT DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Timetable Slots (Versioned via version_no & is_current; supports merged classes via class_ids)
CREATE TABLE IF NOT EXISTS timetable_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  class_ids UUID[] DEFAULT ARRAY[]::UUID[],
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  faculty_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INT NOT NULL DEFAULT 1 CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL DEFAULT '09:00',
  end_time TEXT NOT NULL DEFAULT '10:00',
  version_no INT NOT NULL DEFAULT 1,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Attendance Sessions (with auto-generated unique session_code SES-YYYYMMDD-XXX, merged class_ids, manual_headcount, and lecture snapshots)
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_code TEXT NOT NULL,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  class_ids UUID[] DEFAULT ARRAY[]::UUID[],
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  faculty_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_id UUID REFERENCES timetable_slots(id) ON DELETE SET NULL,
  slot_start_time TEXT,
  slot_end_time TEXT,
  timetable_version INT DEFAULT 1,
  session_date DATE DEFAULT CURRENT_DATE,
  current_nonce TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  geofence_override BOOLEAN,
  session_type TEXT DEFAULT 'REGULAR',
  manual_headcount INT,
  headcount_updated_at TIMESTAMPTZ,
  assigned_by_admin UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Attendance Records
CREATE TABLE IF NOT EXISTS attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('P', 'OD')),
  marked_via TEXT DEFAULT 'QR',
  scan_lat DOUBLE PRECISION,
  scan_lng DOUBLE PRECISION,
  marked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, student_id)
);

-- 8. Device Change Requests
CREATE TABLE IF NOT EXISTS device_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roll_no TEXT NOT NULL,
  student_name TEXT NOT NULL,
  class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  new_device_fp TEXT NOT NULL,
  reason TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

-- 9. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  actor_id UUID,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safe Column Upgrades for Existing Databases
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS default_theme TEXT DEFAULT 'dark',
  ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT 'assets/logo.png',
  ADD COLUMN IF NOT EXISTS smtp_email TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS smtp_app_password TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS allow_extra_lectures BOOLEAN DEFAULT TRUE;

ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS semester TEXT DEFAULT '';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('student', 'cr', 'faculty', 'admin'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS faculty_code TEXT,
  ADD COLUMN IF NOT EXISTS enrollment_no TEXT,
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_permissions JSONB DEFAULT '{
    "manage_users": true,
    "manage_academics": true,
    "manage_timetable": true,
    "assign_proxy": true,
    "approve_devices": true,
    "manage_geofence": true,
    "manage_settings": true,
    "view_reports": true,
    "manage_admins": false
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS faculty_permissions JSONB DEFAULT '{
    "can_start_regular": true,
    "can_start_extra": true,
    "can_mark_od": true,
    "can_edit_attendance": true,
    "can_toggle_gps": true,
    "can_export_reports": true
  }'::jsonb;

UPDATE users SET is_super_admin = TRUE WHERE role = 'admin';

ALTER TABLE timetable_slots
  ADD COLUMN IF NOT EXISTS class_ids UUID[] DEFAULT ARRAY[]::UUID[],
  ADD COLUMN IF NOT EXISTS version_no INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS effective_to DATE;

UPDATE timetable_slots
SET class_ids = ARRAY[class_id]
WHERE (class_ids IS NULL OR cardinality(class_ids) = 0) AND class_id IS NOT NULL;

ALTER TABLE attendance_sessions
  ADD COLUMN IF NOT EXISTS session_code TEXT,
  ADD COLUMN IF NOT EXISTS class_ids UUID[] DEFAULT ARRAY[]::UUID[],
  ADD COLUMN IF NOT EXISTS slot_id UUID REFERENCES timetable_slots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS slot_start_time TEXT,
  ADD COLUMN IF NOT EXISTS slot_end_time TEXT,
  ADD COLUMN IF NOT EXISTS timetable_version INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS manual_headcount INT,
  ADD COLUMN IF NOT EXISTS headcount_updated_at TIMESTAMPTZ;

UPDATE attendance_sessions
SET class_ids = ARRAY[class_id]
WHERE (class_ids IS NULL OR cardinality(class_ids) = 0) AND class_id IS NOT NULL;

UPDATE attendance_sessions
SET session_code = 'SES-' || TO_CHAR(COALESCE(session_date, CURRENT_DATE), 'YYYYMMDD') || '-' || UPPER(SUBSTRING(REPLACE(id::TEXT, '-', ''), 1, 6))
WHERE session_code IS NULL OR session_code = '';

ALTER TABLE attendance_sessions
  ALTER COLUMN session_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_enrollment_unique ON users (LOWER(enrollment_no)) WHERE enrollment_no IS NOT NULL AND enrollment_no <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (LOWER(email)) WHERE email IS NOT NULL AND email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_code_unique ON classes (LOWER(code)) WHERE code IS NOT NULL AND code <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_code_unique ON subjects (LOWER(code)) WHERE code IS NOT NULL AND code <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_code_unique ON attendance_sessions (LOWER(session_code));

-- Enable RLS & Grants for service_role
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

-- Auto-Code Generators
CREATE OR REPLACE FUNCTION generate_next_code(p_prefix TEXT, p_table TEXT, p_col TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INT;
  v_num INT;
  v_candidate TEXT;
BEGIN
  IF p_table = 'classes' THEN
    SELECT COUNT(*) INTO v_count FROM classes;
  ELSIF p_table = 'subjects' THEN
    SELECT COUNT(*) INTO v_count FROM subjects;
  ELSIF p_table = 'users' THEN
    SELECT COUNT(*) INTO v_count FROM users WHERE role = 'faculty';
  ELSE
    v_count := 0;
  END IF;

  v_num := v_count + 1;
  LOOP
    v_candidate := p_prefix || '-' || LPAD(v_num::TEXT, 3, '0');
    IF p_table = 'classes' AND NOT EXISTS (SELECT 1 FROM classes WHERE LOWER(code) = LOWER(v_candidate)) THEN
      RETURN v_candidate;
    ELSIF p_table = 'subjects' AND NOT EXISTS (SELECT 1 FROM subjects WHERE LOWER(code) = LOWER(v_candidate)) THEN
      RETURN v_candidate;
    ELSIF p_table = 'users' AND NOT EXISTS (SELECT 1 FROM users WHERE LOWER(COALESCE(faculty_code, '')) = LOWER(v_candidate)) THEN
      RETURN v_candidate;
    END IF;
    v_num := v_num + 1;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION generate_session_code(p_date DATE DEFAULT CURRENT_DATE)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_seq INT;
  v_code TEXT;
BEGIN
  SELECT COUNT(*) + 1 INTO v_seq
  FROM attendance_sessions
  WHERE session_date = p_date;

  LOOP
    v_code := 'SES-' || TO_CHAR(p_date, 'YYYYMMDD') || '-' || LPAD(v_seq::TEXT, 3, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM attendance_sessions WHERE LOWER(session_code) = LOWER(v_code));
    v_seq := v_seq + 1;
  END LOOP;
  RETURN v_code;
END;
$$;

-- Distance helper
CREATE OR REPLACE FUNCTION calc_distance_meters(lat1 DOUBLE PRECISION, lon1 DOUBLE PRECISION, lat2 DOUBLE PRECISION, lon2 DOUBLE PRECISION)
RETURNS DOUBLE PRECISION LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  r DOUBLE PRECISION := 6371000;
  dlat DOUBLE PRECISION := radians(lat2 - lat1);
  dlon DOUBLE PRECISION := radians(lon2 - lon1);
  a DOUBLE PRECISION;
BEGIN
  a := sin(dlat/2)^2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)^2;
  RETURN 2 * r * atan2(sqrt(a), sqrt(1 - a));
END;
$$;

-- Login RPC
CREATE OR REPLACE FUNCTION rpc_verify_login_v8(p_identifier TEXT, p_password TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user RECORD;
  v_ident TEXT := LOWER(TRIM(p_identifier));
BEGIN
  SELECT * INTO v_user FROM users
  WHERE (
    LOWER(COALESCE(email, '')) = v_ident
    OR LOWER(COALESCE(enrollment_no, '')) = v_ident
    OR LOWER(COALESCE(roll_no, '')) = v_ident
    OR LOWER(COALESCE(faculty_code, '')) = v_ident
  )
  ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'faculty' THEN 2 WHEN 'cr' THEN 3 ELSE 4 END
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Account not found. Check ID, Enrollment No, or Email.');
  END IF;

  IF NOT v_user.is_active THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Account is disabled by Admin.');
  END IF;

  IF v_user.locked_until IS NOT NULL AND v_user.locked_until > NOW() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Too many failed attempts. Try again in 10 minutes.');
  END IF;

  IF v_user.password_hash = crypt(p_password, v_user.password_hash) THEN
    UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = v_user.id;
    RETURN jsonb_build_object('ok', TRUE, 'user', jsonb_build_object(
      'id', v_user.id,
      'role', v_user.role,
      'faculty_code', v_user.faculty_code,
      'email', v_user.email,
      'enrollment_no', v_user.enrollment_no,
      'roll_no', v_user.roll_no,
      'full_name', v_user.full_name,
      'class_id', v_user.class_id,
      'device_fp', v_user.device_fp,
      'is_super_admin', v_user.is_super_admin,
      'admin_permissions', v_user.admin_permissions,
      'faculty_permissions', v_user.faculty_permissions
    ));
  ELSE
    UPDATE users
    SET failed_attempts = COALESCE(failed_attempts, 0) + 1,
        locked_until = CASE WHEN COALESCE(failed_attempts, 0) + 1 >= 5 THEN NOW() + INTERVAL '10 minutes' ELSE NULL END
    WHERE id = v_user.id;
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Incorrect password.');
  END IF;
END;
$$;

-- Change password RPC
CREATE OR REPLACE FUNCTION rpc_change_password_v8(p_user_id UUID, p_old_password TEXT, p_new_password TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user RECORD;
BEGIN
  SELECT * INTO v_user FROM users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'User not found.');
  END IF;
  IF v_user.password_hash <> crypt(p_old_password, v_user.password_hash) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Current password is incorrect.');
  END IF;
  UPDATE users SET password_hash = crypt(p_new_password, gen_salt('bf', 12)) WHERE id = p_user_id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

-- Create user RPC
CREATE OR REPLACE FUNCTION rpc_admin_create_user_v8(
  p_role TEXT,
  p_email TEXT,
  p_enrollment_no TEXT,
  p_roll_no TEXT,
  p_full_name TEXT,
  p_class_id UUID,
  p_password TEXT,
  p_faculty_permissions JSONB DEFAULT NULL,
  p_faculty_code TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_role TEXT := LOWER(TRIM(COALESCE(p_role, 'student')));
  v_fcode TEXT;
BEGIN
  IF v_role NOT IN ('student', 'cr', 'faculty', 'admin') THEN
    v_role := 'student';
  END IF;

  IF v_role = 'faculty' THEN
    v_fcode := COALESCE(NULLIF(TRIM(p_faculty_code), ''), generate_next_code('FAC', 'users', 'faculty_code'));
  END IF;

  INSERT INTO users (
    role, faculty_code, email, enrollment_no, roll_no, full_name, class_id, password_hash, is_active, faculty_permissions
  )
  VALUES (
    v_role,
    v_fcode,
    NULLIF(TRIM(LOWER(p_email)), ''),
    NULLIF(TRIM(p_enrollment_no), ''),
    NULLIF(TRIM(p_roll_no), ''),
    TRIM(p_full_name),
    p_class_id,
    crypt(COALESCE(NULLIF(p_password, ''), 'Pass@123'), gen_salt('bf', 12)),
    TRUE,
    COALESCE(p_faculty_permissions, '{
      "can_start_regular": true,
      "can_start_extra": true,
      "can_mark_od": true,
      "can_edit_attendance": true,
      "can_toggle_gps": true,
      "can_export_reports": true
    }'::jsonb)
  );
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

-- Reset password RPC
CREATE OR REPLACE FUNCTION rpc_admin_reset_password_v8(p_user_id UUID, p_new_password TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE users SET password_hash = crypt(p_new_password, gen_salt('bf', 12)), failed_attempts = 0, locked_until = NULL
  WHERE id = p_user_id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

-- Submit QR RPC (supports student and cr roles, merged classes, and geofence)
CREATE OR REPLACE FUNCTION rpc_submit_qr_v8(
  p_session_id UUID,
  p_student_id UUID,
  p_nonce TEXT,
  p_device_fp TEXT,
  p_lat DOUBLE PRECISION DEFAULT NULL,
  p_lng DOUBLE PRECISION DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_sess RECORD;
  v_user RECORD;
  v_cls RECORD;
  v_set RECORD;
  v_geo_active BOOLEAN;
  v_target_lat DOUBLE PRECISION;
  v_target_lng DOUBLE PRECISION;
  v_target_rad INT;
  v_dist DOUBLE PRECISION;
  v_allowed_classes UUID[];
BEGIN
  SELECT * INTO v_sess FROM attendance_sessions WHERE id = p_session_id AND is_active = TRUE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Lecture session is closed or invalid.');
  END IF;

  IF v_sess.current_nonce IS DISTINCT FROM p_nonce THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'QR Code expired. Scan the live screen QR.');
  END IF;

  SELECT * INTO v_user FROM users WHERE id = p_student_id AND role IN ('student', 'cr') AND is_active = TRUE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Student account inactive or not found.');
  END IF;

  v_allowed_classes := COALESCE(NULLIF(v_sess.class_ids, ARRAY[]::UUID[]), ARRAY[v_sess.class_id]);
  IF v_user.class_id IS NULL OR NOT (v_user.class_id = ANY(v_allowed_classes)) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'You do not belong to this class or merged batch.');
  END IF;

  IF v_user.device_fp IS NULL OR v_user.device_fp = '' THEN
    UPDATE users SET device_fp = p_device_fp WHERE id = v_user.id;
  ELSIF v_user.device_fp <> p_device_fp THEN
    INSERT INTO audit_logs (event_type, actor_id, details)
    VALUES ('BLOCKED', v_user.id, 'Device mismatch for Roll ' || COALESCE(v_user.roll_no, '?'));
    RETURN jsonb_build_object('ok', FALSE, 'error', 'DEVICE_MISMATCH', 'message', 'Unrecognized device. Submit a Device Change Request.');
  END IF;

  SELECT * INTO v_set FROM system_settings WHERE id = 1;
  SELECT * INTO v_cls FROM classes WHERE id = v_user.class_id;

  IF v_cls.custom_geo_enabled AND v_cls.custom_lat IS NOT NULL AND v_cls.custom_lng IS NOT NULL THEN
    v_target_lat := v_cls.custom_lat;
    v_target_lng := v_cls.custom_lng;
    v_target_rad := COALESCE(v_cls.custom_radius_meters, 150);
  ELSE
    v_target_lat := v_set.campus_lat;
    v_target_lng := v_set.campus_lng;
    v_target_rad := COALESCE(v_set.geofence_radius_meters, 150);
  END IF;

  v_geo_active := COALESCE(v_sess.geofence_override, v_cls.custom_geo_enabled, v_set.geofence_enabled, FALSE);

  IF v_geo_active AND v_target_lat IS NOT NULL AND v_target_lng IS NOT NULL THEN
    IF p_lat IS NULL OR p_lng IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'Location permission is required for this lecture.');
    END IF;
    v_dist := calc_distance_meters(p_lat, p_lng, v_target_lat, v_target_lng);
    IF v_dist > v_target_rad THEN
      INSERT INTO audit_logs (event_type, actor_id, details)
      VALUES ('BLOCKED', v_user.id, 'Outside Geofence: ' || ROUND(v_dist) || 'm > ' || v_target_rad || 'm');
      RETURN jsonb_build_object('ok', FALSE, 'error', 'OUTSIDE CAMPUS — You are ' || ROUND(v_dist) || 'm away (Limit: ' || v_target_rad || 'm).');
    END IF;
  END IF;

  INSERT INTO attendance_records (session_id, student_id, status, marked_via, scan_lat, scan_lng)
  VALUES (p_session_id, v_user.id, 'P', 'QR', p_lat, p_lng)
  ON CONFLICT (session_id, student_id)
  DO UPDATE SET status = 'P', marked_via = 'QR', scan_lat = EXCLUDED.scan_lat, scan_lng = EXCLUDED.scan_lng, marked_at = NOW();

  RETURN jsonb_build_object('ok', TRUE, 'status', 'P');
END;
$$;

-- Update settings RPC
CREATE OR REPLACE FUNCTION rpc_update_settings_v8(p_patch JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_new_pass TEXT := NULLIF(TRIM(COALESCE(p_patch->>'smtp_app_password', '')), '');
  v_clear_smtp BOOLEAN := COALESCE((p_patch->>'clear_smtp')::BOOLEAN, FALSE);
BEGIN
  UPDATE system_settings SET
    app_title = COALESCE(NULLIF(TRIM(p_patch->>'app_title'), ''), app_title),
    college_name = COALESCE(NULLIF(TRIM(p_patch->>'college_name'), ''), college_name),
    login_subtitle = COALESCE(NULLIF(TRIM(p_patch->>'login_subtitle'), ''), login_subtitle),
    logo_url = COALESCE(NULLIF(TRIM(p_patch->>'logo_url'), ''), logo_url),
    primary_color = COALESCE(NULLIF(TRIM(p_patch->>'primary_color'), ''), primary_color),
    default_theme = CASE
      WHEN LOWER(TRIM(COALESCE(p_patch->>'default_theme', ''))) IN ('dark', 'light')
      THEN LOWER(TRIM(p_patch->>'default_theme'))
      ELSE default_theme
    END,
    qr_interval_seconds = COALESCE((p_patch->>'qr_interval_seconds')::INT, qr_interval_seconds),
    session_timeout_minutes = COALESCE((p_patch->>'session_timeout_minutes')::INT, session_timeout_minutes),
    enforce_lecture_time = COALESCE((p_patch->>'enforce_lecture_time')::BOOLEAN, enforce_lecture_time),
    allow_extra_lectures = COALESCE((p_patch->>'allow_extra_lectures')::BOOLEAN, allow_extra_lectures),
    geofence_enabled = COALESCE((p_patch->>'geofence_enabled')::BOOLEAN, geofence_enabled),
    campus_lat = COALESCE((p_patch->>'campus_lat')::DOUBLE PRECISION, campus_lat),
    campus_lng = COALESCE((p_patch->>'campus_lng')::DOUBLE PRECISION, campus_lng),
    geofence_radius_meters = COALESCE((p_patch->>'geofence_radius_meters')::INT, geofence_radius_meters),
    smtp_email = CASE
      WHEN v_clear_smtp THEN ''
      WHEN p_patch ? 'smtp_email' THEN TRIM(COALESCE(p_patch->>'smtp_email', ''))
      ELSE smtp_email
    END,
    smtp_app_password = CASE
      WHEN v_clear_smtp THEN ''
      WHEN v_new_pass IS NOT NULL THEN REPLACE(v_new_pass, ' ', '')
      ELSE smtp_app_password
    END,
    updated_at = NOW()
  WHERE id = 1;

  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

-- Function privileges
REVOKE ALL ON FUNCTION generate_next_code(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION generate_next_code(TEXT, TEXT, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION generate_session_code(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION generate_session_code(DATE) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_verify_login_v8(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_verify_login_v8(TEXT, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_change_password_v8(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_change_password_v8(UUID, TEXT, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_admin_create_user_v8(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_admin_create_user_v8(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, JSONB, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_admin_reset_password_v8(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_admin_reset_password_v8(UUID, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_submit_qr_v8(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_submit_qr_v8(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_update_settings_v8(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_update_settings_v8(JSONB) TO postgres, service_role;

-- Backfill faculty codes if missing
UPDATE users
SET faculty_code = 'FAC-' || LPAD(ROW_NUMBER() OVER (ORDER BY created_at, id)::TEXT, 3, '0')
WHERE role = 'faculty' AND (faculty_code IS NULL OR faculty_code = '');

-- Default Super Admin (pranavpatel.pps@gmail.com / PPS@2004)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') THEN
    INSERT INTO users (role, email, full_name, password_hash, is_active, is_super_admin)
    VALUES ('admin', 'pranavpatel.pps@gmail.com', 'Pranav Patel (Super Admin)', crypt('PPS@2004', gen_salt('bf', 12)), TRUE, TRUE);
  END IF;
END $$;
