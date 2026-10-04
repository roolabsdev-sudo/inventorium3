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

#### Replacing a venue made by mistake

Someone who created a venue by accident can join the right one instead. In **Settings**, under *Created this
venue by mistake?*, they choose **Join a venue with a code**, enter the code and their name, and send the request.
Their new venue is deleted and they wait for approval like anyone else.

This is allowed only while the venue is plainly untouched. The server refuses (and deletes nothing) unless the person
owns it, is its only member, it has no items, shows, roles, locations, call lists or history, and nobody is waiting
to join it. A bad, expired or used-up code never costs them the venue: the venue is removed only after the request
has been safely made, and if removal fails the roster row is restored and the request withdrawn. If they are later
declined, they can create a venue again. Venues that have data are deleted through piece 5, not this way.

### Scanner codes: scan-only devices

Run `db/venues-scanner-codes.sql` once in the Supabase SQL editor, after `venues-onboarding.sql` (safe to run again;
undo with `venues-scanner-codes-rollback.sql`). It adds the `scanner_codes` and `scanner_devices` tables. The final
result table should show `ok` on all four rows. Until it has run, the **Scanners** page and the scanner-code box on the
sign-in page report an error; nothing else changes.

How it works:
1. An admin (anyone with **Employees: edit**) opens **Scanners** in the sidebar and chooses **New scanner code**:
   an optional label, how long it can be entered (1 hour to 7 days, default 1 day) and how many devices may use it
   (1 to 10, default 1). The code looks like `K7QM-2XPD`.
2. On the spare phone or tablet, open the sign-in page (`login.html?scanner=1` opens the code box straight away),
   type the code and, if you like, a name for the scanner. That is all: **no email or password**.
3. The device is now a scanner. It sees only the Scan page, and it can only check items in and out and use up stock.
   It stays a scanner, even after the browser is closed, until someone chooses **Sign out** in its sidebar, or an admin
   signs it out from the Scanners page (it stops working on its next use).

Rules the server enforces:
- A scanner device has no login. It holds a random token; only a hash of it is stored. The token is accepted by one function
  only (`scanner`). Every other function needs a real login, so a scanner can't open Inventory, Employees, Settings or
  Join requests even by editing the page. It can't add stock, change an item's status, edit or delete anything.
- Check-out, check-in and "use stock" run the very same code as the Inventory page (`_shared/itemactions.js`), so restricted
  items, inactive people, items already out and "not enough in stock" all apply.
- Every device is pinned to the venue of the code it used. A wrong, expired, turned-off, used-up or deleted-venue code all
  get the same message. Signing a device out never frees its place on a code: make a new code.
- Turning a code off stops new devices but leaves signed-in ones working; sign those out separately.
- At most 10 scanners signed in per venue and 20 unexpired codes per venue.
