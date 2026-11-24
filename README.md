# BTS Work Orders – deploy on GitHub Pages (free)

## 1. Put the code on GitHub
1. Unzip this folder.
2. On github.com click **New repository**, name it (e.g. `bts-work-orders`), set it **Public**, create it.
3. Click **uploading an existing file** and drag in EVERYTHING from the unzipped folder
   (including the hidden `.github` folder), then **Commit changes** to `main`.

## 2. Turn on Pages
Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Open the **Actions** tab; when "Deploy to GitHub Pages" turns green your site is live at:
`https://YOUR-USERNAME.github.io/bts-work-orders/`

Out of the box, data is saved **in each person's own browser only**.

## 3. (Optional) Shared team data with Supabase (free)
1. Create a project at supabase.com → **SQL Editor** → run:
   ```sql
   create table kv (key text primary key, value text not null);
   alter table kv enable row level security;
   create policy "open access" on kv for all using (true) with check (true);
   ```
2. Supabase → **Project Settings → API**: copy the Project URL and the `anon` public key.
3. GitHub repo → **Settings → Secrets and variables → Actions → Variables** → add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. **Actions → Deploy to GitHub Pages → Run workflow**.

⚠ With that policy anyone who has the website link can read/edit the data. Add a login
before storing anything sensitive.

## Notes
- The app starts with sample work orders; delete them before real use.
- Free GitHub Pages requires a public repo (the code is public, your data is not in the code).
- Local test: `npm install` then `npm run dev`.
