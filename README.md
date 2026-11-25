# SmartQR Attendance System v8.0 (Publish-Ready)

## Features Included
- **Lazy Tab Loading:** Startup fetches only lightweight branding (`get_settings`) and session (`whoami`). Admin, Faculty, and CR tabs load data only when clicked, with manual refresh buttons.
- **CR (Class Representative) Role:** Today-only lectures within `(start - 10m)` to `(end + 1h)` IST, no manual roster, and a **Mark My Attendance** button unlocked only when the QR session is active and at least 2 students have scanned via QR.
- **Headcount Verification:** Manual Headcount input next to live QR Headcount for both Faculty and CR (`Verified ✓ (Match)` when equal, info-only with no effect on attendance).
- **Faculty Live View & Merged Classes:** Top split-screen (QR on left, scanned Roll Numbers on right) with full synced Manual Attendance Roster (`P` / `OD` checkboxes) below, supporting multi-class and merged classes (`2+` classes).
- **Simplified Student Portal (3 Tabs):** `1. Scan QR` (`getUserMedia` + `jsQR` with clean track release), `2. Password` (new password entered twice), and `3. Device Req`.
- **Auto Unique IDs & Versioned Timetable Matrix:** Auto-generated `CLS-XXX`, `SUB-XXX`, `FAC-XXX`, and `SES-YYYYMMDD-XXX` IDs, Class-Wise Attendance Breakdown analytics, Light/Dark mode toggle, and a per-class Day × Time timetable matrix that versions updates without affecting historical sessions.

## Deployment Steps (Vercel + Supabase)
1. **Supabase Database:** Open Supabase → **SQL Editor**, paste `supabase_v8.sql`, and click **Run**.
2. **Vercel Environment Variables:** In Vercel → **Settings → Environment Variables**, add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SESSION_SECRET`
3. **Deploy:** Extract this ZIP to your GitHub repo root, commit, and push to `main`. Vercel will build and deploy automatically.
