# Setup guide

The app is a static frontend + Netlify Functions + a Supabase Postgres database. People sign in with Netlify Identity; each login is matched by **email** to a row on the Employees page, which holds their per-page permissions (none / view / edit).

## 1. Create the database (Supabase)
1. Create a free project at supabase.com.
2. Open **SQL Editor → New query**, paste the contents of `db/schema.sql`, and run it. (If your database already exists, run `db/branding-migration.sql` instead.)
3. Open **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` (keep this secret; it is only ever used inside the Functions)

## 2. Deploy to Netlify
1. Put this folder in a Git repo and create a Netlify site from it (build command: none; publish directory: `.`; functions: `netlify/functions` — already set in `netlify.toml`). Netlify installs `@supabase/supabase-js` from `package.json` automatically.
2. **Site configuration → Environment variables**, add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_EMAILS` *(optional)* — comma-separated emails that become full admins on first login. If you leave it out, the very first person to sign in becomes the admin.

## 3. Turn on login (Netlify Identity)
1. **Site configuration → Identity → Enable Identity**.
2. Under **Registration preferences**, choose **Invite only** so strangers can't sign up.
3. Open the site's `login.html`. Invite your own email from **Identity → Invite users** (or use ADMIN_EMAILS), accept the email, and sign in. The first login creates your admin employee record.

## 4. Add everyone else
On the **Employees** page, add each person with their email, a password (min. 8 characters) and the access level for Inventory & Scan, Call List, Employees and Settings. Saving creates their login — no invite email needed. Editing a person and typing a new password resets it.

## 5. Move over old data (optional)
If the previous version was used in a browser, open **Settings** in that same browser as an admin and use **Import old browser data**. It is safe to run more than once.

## 6. Set your name and logo
Sign in as an admin, open **Settings → Branding**, and enter your venue name, subtitle and logo. Until then the app shows a generic placeholder.

## Notes
- Every request is re-checked on the server, so view-only users cannot change data even by tampering with the page.
- Rotate the service-role key in Supabase if it is ever exposed, then update the Netlify variable.
- Local testing: `npm install`, then `npx netlify dev` (needs the same environment variables in a `.env` file, which is git-ignored).
