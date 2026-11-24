-- ============================================================================
-- SMARTQR ATTENDANCE v7.1 VERIFIED PRODUCTION — COMPLETE SCHEMA, RBAC & GRANTS
-- Safe to run on a fresh Supabase project OR upgrade any v5/v6/v7 database.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Core Tables
CREATE TABLE IF NOT EXISTS system_settings (
  id INT PRIMARY KEY DEFAULT 1,
  app_title TEXT DEFAULT 'SmartQR Attendance',
  college_name TEXT DEFAULT 'Parul University • FMS',
  login_subtitle TEXT DEFAULT 'Enterprise Anti-Proxy Classroom Attendance',
  logo_url TEXT DEFAULT 'assets/logo.png',
  primary_color TEXT DEFAULT '#4f46e5',
  label_student TEXT DEFAULT 'Student',
  label_faculty TEXT DEFAULT 'Faculty',
  label_class TEXT DEFAULT 'Class / Division',
  label_roll TEXT DEFAULT 'Roll No',
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

CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  custom_geo_enabled BOOLEAN DEFAULT FALSE,
  custom_lat DOUBLE PRECISION,
  custom_lng DOUBLE PRECISION,
  custom_radius_meters INT DEFAULT 150,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')),
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

CREATE TABLE IF NOT EXISTS timetable_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  faculty_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INT DEFAULT 1,
  start_time TIME DEFAULT '09:00',
  end_time TIME DEFAULT '10:00',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  faculty_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date DATE DEFAULT CURRENT_DATE,
  current_nonce TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  geofence_override BOOLEAN,
  session_type TEXT DEFAULT 'REGULAR',
  assigned_by_admin UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  actor_id UUID,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Safe Column Upgrades for Existing Databases
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT 'assets/logo.png',
  ADD COLUMN IF NOT EXISTS smtp_email TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS smtp_app_password TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS allow_extra_lectures BOOLEAN DEFAULT TRUE;

ALTER TABLE users
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_enrollment_unique ON users (LOWER(enrollment_no)) WHERE enrollment_no IS NOT NULL AND enrollment_no <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (LOWER(email)) WHERE email IS NOT NULL AND email <> '';

ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS custom_geo_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS custom_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS custom_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS custom_radius_meters INT DEFAULT 150;

ALTER TABLE attendance_sessions
  ADD COLUMN IF NOT EXISTS geofence_override BOOLEAN,
  ADD COLUMN IF NOT EXISTS session_type TEXT DEFAULT 'REGULAR',
  ADD COLUMN IF NOT EXISTS assigned_by_admin UUID REFERENCES users(id) ON DELETE SET NULL;

-- 3. Row-Level Security + Explicit service_role Grants
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

-- 4. RPC Functions
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

CREATE OR REPLACE FUNCTION rpc_verify_login_v7(p_identifier TEXT, p_password TEXT)
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
  )
  ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'faculty' THEN 2 ELSE 3 END
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Account not found. Check Enrollment No or Email.');
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

CREATE OR REPLACE FUNCTION rpc_change_password_v5(p_user_id UUID, p_old_password TEXT, p_new_password TEXT)
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

CREATE OR REPLACE FUNCTION rpc_admin_create_user_v7(
  p_role TEXT,
  p_email TEXT,
  p_enrollment_no TEXT,
  p_roll_no TEXT,
  p_full_name TEXT,
  p_class_id UUID,
  p_password TEXT,
  p_faculty_permissions JSONB DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO users (
    role, email, enrollment_no, roll_no, full_name, class_id, password_hash, is_active, faculty_permissions
  )
  VALUES (
    p_role,
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

CREATE OR REPLACE FUNCTION rpc_admin_reset_password_v5(p_user_id UUID, p_new_password TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE users SET password_hash = crypt(p_new_password, gen_salt('bf', 12)), failed_attempts = 0, locked_until = NULL
  WHERE id = p_user_id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION rpc_submit_qr_v6(
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
BEGIN
  SELECT * INTO v_sess FROM attendance_sessions WHERE id = p_session_id AND is_active = TRUE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Lecture session is closed or invalid.');
  END IF;

  IF v_sess.current_nonce IS DISTINCT FROM p_nonce THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'QR Code expired. Scan the live screen QR.');
  END IF;

  SELECT * INTO v_user FROM users WHERE id = p_student_id AND role = 'student' AND is_active = TRUE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Student account inactive or not found.');
  END IF;

  IF v_user.class_id IS DISTINCT FROM v_sess.class_id THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'You do not belong to this class.');
  END IF;

  IF v_user.device_fp IS NULL OR v_user.device_fp = '' THEN
    UPDATE users SET device_fp = p_device_fp WHERE id = v_user.id;
  ELSIF v_user.device_fp <> p_device_fp THEN
    INSERT INTO audit_logs (event_type, actor_id, details)
    VALUES ('BLOCKED', v_user.id, 'Device mismatch for Roll ' || COALESCE(v_user.roll_no, '?'));
    RETURN jsonb_build_object('ok', FALSE, 'error', 'DEVICE_MISMATCH', 'message', 'Unrecognized device. Submit a Device Update Request to Admin.');
  END IF;

  SELECT * INTO v_set FROM system_settings WHERE id = 1;
  SELECT * INTO v_cls FROM classes WHERE id = v_sess.class_id;

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

CREATE OR REPLACE FUNCTION rpc_update_settings_v6(p_patch JSONB)
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
    label_student = COALESCE(NULLIF(TRIM(p_patch->>'label_student'), ''), label_student),
    label_faculty = COALESCE(NULLIF(TRIM(p_patch->>'label_faculty'), ''), label_faculty),
    label_class = COALESCE(NULLIF(TRIM(p_patch->>'label_class'), ''), label_class),
    label_roll = COALESCE(NULLIF(TRIM(p_patch->>'label_roll'), ''), label_roll),
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

REVOKE ALL ON FUNCTION rpc_verify_login_v7(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_verify_login_v7(TEXT, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_change_password_v5(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_change_password_v5(UUID, TEXT, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_admin_create_user_v7(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_admin_create_user_v7(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, JSONB) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_admin_reset_password_v5(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_admin_reset_password_v5(UUID, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_submit_qr_v6(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_submit_qr_v6(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) TO postgres, service_role;

REVOKE ALL ON FUNCTION rpc_update_settings_v6(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rpc_update_settings_v6(JSONB) TO postgres, service_role;

-- Default Super Admin (pranavpatel.pps@gmail.com / PPS@2004)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') THEN
    INSERT INTO users (role, email, full_name, password_hash, is_active, is_super_admin)
    VALUES ('admin', 'pranavpatel.pps@gmail.com', 'Pranav Patel (Super Admin)', crypt('PPS@2004', gen_salt('bf', 12)), TRUE, TRUE);
  END IF;
END $$;
