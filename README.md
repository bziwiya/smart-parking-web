# Smart Parking Web (dashboard + API)

This is a small **fully runnable** web application that demonstrates the core notions of the “Smart Parking : Optimisation intelligente du stationnement urbain” project:
- **Place detection** (spots occupied/free)
- **Real‑time information** (live updates via WebSocket)
- **Access automation** (gate/barrier open/close logic)
- **Visual indicators** (Libre/Occupé + “Complet”)
- **Roadmap features** (reservation stub, cloud/mobile-ready API)

## Tech
- Node.js + Express (API + static site)
- SQLite (persistence)
- Socket.IO (real-time updates)
- Vanilla HTML/CSS/JS (no build step)

## Run locally
1. Install Node.js (>= 18).
2. In this folder:
   ```bash
   npm install
   npm start
   ```
3. Open:
   - Landing page: http://localhost:3000/
   - Live dashboard: http://localhost:3000/dashboard.html

## Quick demo actions
- On the dashboard, click a spot to toggle **Occupé/Libre** (simulates IR sensor signal HIGH/LOW).
- Use the **Gate** controls to open/close the barrier, or send a simulated **car entry/exit** event.

## API (examples)
- `GET /api/spots`
- `POST /api/sensor`  body: `{ "spotId": 3, "occupied": true }`
- `POST /api/gate/open` / `POST /api/gate/close`
- `POST /api/gate/car-entry` / `POST /api/gate/car-exit`
- `GET /api/stats`

## Notes for your real ESP32 prototype
Replace the demo calls with your ESP32 requests:
- Each IR sensor event can call `/api/sensor`.
- If you publish via MQTT, you can bridge MQTT → these endpoints (not included here to stay lightweight).
