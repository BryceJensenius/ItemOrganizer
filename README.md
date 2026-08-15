# Stow Item Organizer

Stow is a private inventory app for recording what you own and where you put it. The React frontend supports search, camera uploads, optional precise location, AI-assisted item identification, and item details with an OpenStreetMap view. A FastAPI service stores each account's records in MongoDB.

## Run locally

Requirements: Docker Desktop and Node.js 22 or newer.

1. Copy `.env.example` to `.env`.
2. Replace `JWT_SECRET` with a long random value and add an optional `OPENAI_API_KEY`.
3. Start the API and database:

   ```powershell
   docker compose up --build -d
   ```

4. Start the frontend:

   ```powershell
   Set-Location frontend
   Copy-Item .env.example .env.local
   npm install
   npm run dev
   ```

5. Open `http://localhost:5173`. API documentation is at `http://localhost:8000/docs`.

MongoDB and uploaded images use named Docker volumes, so recreating containers does not erase them. Back up both `itemorganizer_mongo-data` and `itemorganizer_uploads` before moving machines.

## OpenAI setup

`OPENAI_API_KEY` must be set in the root `.env` used by Docker Compose. Do not put this key in a GitHub variable or any `VITE_*` value. Vite embeds those values in public browser JavaScript. The image is sent from the local API to OpenAI only when **Fill details with AI** is selected.

The app uses `gpt-4o-mini` by default. Change `OPENAI_MODEL` in `.env` to another vision-capable model that supports structured outputs.

## Publish the frontend

The workflow in `.github/workflows/deploy-pages.yml` publishes on every push to `main`.

1. In the GitHub repository, open **Settings > Pages** and choose **GitHub Actions** as the source.
2. Under **Settings > Secrets and variables > Actions > Variables**, add:
   - `VITE_BASE_PATH`: `/`.
   - `VITE_API_URL`: the browser-reachable HTTPS URL for the local API.
3. Set the Pages custom domain to `io.tradelens.space` and add a DNS CNAME from `io` to `BryceJensenius.github.io`.
4. Add `https://io.tradelens.space` to `CORS_ORIGINS` in the root `.env`, then restart the API.

## Publish the local API securely

`localhost` always means the device running the browser. On an iPhone, `http://localhost:8000` points to the iPhone, not the computer. Also, GitHub Pages is HTTPS and browsers generally block requests from it to a plain HTTP API.

Do not port-forward port 8000 on the router. The Compose file keeps it on `127.0.0.1` and provides an opt-in Cloudflare Tunnel that makes an outbound encrypted connection instead:

1. Add a domain to Cloudflare, then open **Networking > Tunnels** and create a remotely managed tunnel.
2. Add a published application route for `https://api.tradelens.space` with service URL `http://api:8000`.
3. Put the tunnel token in the root `.env` as `TUNNEL_TOKEN`. It is a backend secret and must never be added to GitHub or a `VITE_*` variable.
4. Set `CORS_ORIGINS=http://localhost:5173,https://io.tradelens.space` in `.env`. CORS values are frontend origins, not the API hostname.
5. Start the tunnel and API:

   ```powershell
   docker compose --profile public up -d --build
   ```

6. Set the GitHub Actions variable `VITE_API_URL` to `https://api.tradelens.space` and redeploy the frontend.

The public hostname exposes signup and login by design. Passwords are Argon2-hashed, JWTs expire after 30 days, login is limited to 10 requests per minute per client address, signup to 5 per hour, AI analysis to 20 per hour, and other API traffic to 120 requests per minute. All item and image reads/writes require a JWT and match the JWT user ID in MongoDB. Use a unique random `JWT_SECRET` of at least 32 characters and keep Docker Desktop, MongoDB, the API image, and `cloudflared` updated.

Cloudflare Tunnel prevents inbound port exposure, but it does not make a public service risk-free. Enable Cloudflare managed WAF rules and review tunnel/API logs. Public signup allows strangers to create accounts and consume disk space; add email verification or invite-only registration before sharing the URL broadly if that is not desired.

For private use across your own devices, a private VPN such as Tailscale is safer than a public hostname, but a GitHub Pages frontend cannot call a private API unless the viewing device is connected to that VPN.

Geolocation and camera access require a secure context on mobile. The browser asks for permission when **Add my current location** or the camera picker is used. If browser coordinates are unavailable, the API attempts to read GPS metadata from the uploaded image. Many iPhone sharing settings remove that metadata.

## API overview

- `POST /auth/register` and `POST /auth/login` issue 30-day JWTs.
- `GET /items?search=...` searches item names, descriptions, keywords, and location descriptions for the signed-in user only.
- `POST /items` stores optional fields and an optional image.
- `GET /items/{id}/image` returns an image only when the JWT owns that item.
- `PUT /items/{id}` updates an item only when the JWT owns it.
- `POST /items/analyze` returns structured AI-generated fields and image GPS metadata when available.
- `GET /health` verifies API and database connectivity.

The database is not exposed on a host port. The API is the only service reachable from outside Docker Compose.