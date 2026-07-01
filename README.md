# Mukesh Medical — WhatsApp Coexistence + Reply Dashboard

A single Node app that:
1. Runs Meta's **Embedded Signup** so you can connect the Mukesh Medical number via **Coexistence** (QR scan — keeps the WhatsApp Business app working).
2. Receives incoming customer messages via webhook.
3. Lets you read and reply from a simple inbox dashboard.

## What you need
- The Meta app is already set up (App ID `1039310715202655`, Embedded Signup config `1403795661596400`).
- A free Render account: https://render.com
- Your Meta **App Secret**: Meta app dashboard → App settings → Basic → App secret → Show.

## Deploy on Render (free)
1. Put this folder in a **GitHub repo** (or use Render's "public Git repository" option).
2. Render → New → **Web Service** → connect the repo.
3. Settings: Build command `npm install`, Start command `npm start`.
4. Add **Environment Variables** (from `.env.example`):
   - `APP_ID` = 1039310715202655
   - `CONFIG_ID` = 1403795661596400
   - `GRAPH_VERSION` = v21.0
   - `APP_SECRET` = (your app secret — paste here, never in code)
   - `VERIFY_TOKEN` = (invent a random string; keep it handy)
5. Deploy. Render gives you a URL like `https://mukesh-whatsapp.onrender.com`.

## Wire the webhook in Meta (one time)
1. Meta app → WhatsApp → Configuration → **Webhook** → Edit.
2. Callback URL: `https://YOUR-RENDER-URL/webhook`
3. Verify token: the **same** `VERIFY_TOKEN` you set above → Verify and save.
4. Subscribe to the **messages** field.

## Connect the number (Coexistence)
1. Open `https://YOUR-RENDER-URL/` in a browser, logged into the Facebook account that owns the app.
2. Click **Connect via Coexistence** → follow Meta's popup → a **QR code** appears.
3. On the Mukesh Medical phone: WhatsApp Business app → Settings → **Linked devices / scan** → scan the QR.
4. Choose to sync chats (up to 6 months). Done — the dashboard switches to the inbox.
5. Copy the `ACCESS_TOKEN` printed in Render's logs into the `ACCESS_TOKEN` env var so it persists across restarts.

## Notes
- Free Render sleeps after ~15 min idle; the first message after a quiet spell may take a few seconds (Meta retries — nothing is lost). Upgrade to always-on later.
- `data.json` (messages) is stored on disk; on free hosting it can reset on redeploy. Add a database later for permanent history.
- Add more features (auto-replies, templates, catalog, etc.) on top of this base.
