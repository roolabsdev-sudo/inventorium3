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
   - *(`ADMIN_EMAILS` is no longer used. Nobody becomes an admin just by signing in: see step 3.)*

## 3. Turn on login (Netlify Identity)
1. **Site configuration → Identity → Enable Identity**.
2. Under **Registration preferences**, choose **Open** so anyone can create an account and set up their own venue. Leave **Autoconfirm** OFF: people must confirm their email before they can sign in. The app relies on this, because a roster match by email is only trustworthy for a confirmed address.
3. Open the site's `login.html` and choose **Create an account**, then confirm your email and sign in. If your email is already on a venue's roster you join that venue. Otherwise you land on a **Create your venue** page; whoever creates a venue becomes its owner and admin.

## 4. Add everyone else
Two ways. Either give people a **join code** (Join requests page, see piece 4 below) and approve them as they sign up, or add them yourself: on the **Employees** page, add each person with their email, a password (min. 8 characters) and the access level for Inventory & Scan, Call List, Employees and Settings. Saving creates their login — no invite email needed. Editing a person and typing a new password resets it, but only for logins this venue created: someone who signed up for themselves resets their own password with *Forgot password?*.

## 5. Move over old data (optional)
If the previous version was used in a browser, open **Settings** in that same browser as an admin and use **Import old browser data**. It is safe to run more than once.

## 6. Set your name and logo
Sign in as an admin, open **Settings → Branding**, and enter your venue name, subtitle and logo. Until then the app shows a generic placeholder.

## Notes
- Every request is re-checked on the server, so view-only users cannot change data even by tampering with the page.
- Rotate the service-role key in Supabase if it is ever exposed, then update the Netlify variable.
- Local testing: `npm install`, then `npx netlify dev` (needs the same environment variables in a `.env` file, which is git-ignored).

## Upgrading an existing database to multi-venue (piece 1)
Run `db/venues-groundwork.sql` once in the Supabase SQL editor. It adds a `venues` table, tags all existing data as Venue #1, and needs no redeploy. The last result table should show matching `total` and `in_venue_1` numbers on every row. To undo it, run `db/venues-rollback.sql`. (Fresh installs get all of this from `db/schema.sql`.)

## Multi-venue (in progress)

Run in this order, in the Supabase SQL editor:

1. `venues-groundwork.sql` — adds the `venues` table and `venue_id` columns. (Piece 1)
2. `venues-ids.sql` — makes ids unique per venue. Run it, then deploy the piece-2 code
   straight away (the site errors briefly in between).
3. `venues-drop-default.sql` — only after the piece-2 code is live and checked.

Undo, in reverse: `venues-ids-rollback.sql`, then `venues-rollback.sql`.

Every Netlify Function reaches data through `venueDb()` in `netlify/functions/_shared/auth.js`,
which pins each query to the caller's venue. Run `npm test` to check that one venue can't
read or change another's data.

### Piece 3: sign-up onboarding

Run `venues-onboarding.sql` once in the Supabase SQL editor (safe to run again; undo with
`venues-onboarding-rollback.sql`). It adds the `join_requests` table that the "Waiting for approval"
screen reads (piece 4 fills it) and makes the database refuse a second venue for the same owner email.
The site works whether you run it before or after deploying the piece-3 code. The final result table should
show `ok` on both rows.

What changed for people: signing in with an email that is on no roster no longer dead-ends. They get a
**Create your venue** page (name required; subtitle and logo optional) and become that venue's owner and admin.
Before opening sign-up to the public, set Netlify Identity registration to **Open** with Autoconfirm **off**.

### Piece 4: join codes and approval

Run `venues-join-codes.sql` once in the Supabase SQL editor, after `venues-onboarding.sql` (safe to run again;
undo with `venues-join-codes-rollback.sql`). It adds the `join_codes` table and the columns `join_requests` needs
to remember what a code promised. The final result table should show `ok` on all four rows. Deploy the code
before or after: until the SQL has run, the new page and the "Join with a code" form just report an error.

How it works:
1. An admin (anyone with **Employees: edit**) opens **Join requests** in the sidebar and chooses **New join code**:
   a role, what each page lets people do, how long it lasts (1 to 30 days, default 7) and an optional limit on uses.
   The code looks like `K7QM-2XPD`. Copy it and give it to your crew.
2. The person signs up at `login.html` (confirming their email), lands on the welcome page and chooses
   **Join with a code**. That only sends a request; they see "Waiting for approval" and can withdraw it.
3. The admin sees them under **Waiting for approval** and chooses **Approve** or **Decline**. Approving adds them to
   the roster with exactly the role and access the code promised; they choose **Check again** (or sign in again) and
   they are in. Declined people go back to the welcome page and may ask again.

Rules the server enforces: a code works only until it expires, is turned off or is used up (waiting and approved
requests count towards the limit; declined and cancelled ones give the place back); someone already on any roster
can't use a code; a person can wait on only one venue; and a wrong, expired, turned-off or used-up code all get
the same message. Codes are unique across venues because people type one without naming the venue.
Turning a code off stops new use but leaves requests already made for you to decide.
