const $ = (id) => document.getElementById(id);

const ui = {
  wsBadge: $("wsBadge"),
  kTotal: $("kTotal"),
  kFree: $("kFree"),
  kOcc: $("kOcc"),
  kRate: $("kRate"),
  kRateLabel: $("kRateLabel"),
  kDisplay: $("kDisplay"),
  occupancyBar: $("occupancyBar"),
  spots: $("spots"),
  gateStatus: $("gateStatus"),
  gateUpdated: $("gateUpdated"),
  gateHint: $("gateHint"),
  events: $("events"),
  btnOpen: $("btnOpen"),
  btnClose: $("btnClose"),
  btnEntry: $("btnEntry"),
  btnExit: $("btnExit"),
  btnRefreshLog: $("btnRefreshLog"),
};

async function api(url, opts) {
  const response = await fetch(url, opts);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function fmtTime(isoValue) {
  if (!isoValue) return "-";
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return isoValue;
  return d.toLocaleString();
}

function setSocketBadge(isConnected) {
  ui.wsBadge.classList.toggle("online", isConnected);
  ui.wsBadge.classList.toggle("offline", !isConnected);
  ui.wsBadge.textContent = isConnected
    ? "Temps reel : connecte"
    : "Temps reel : reconnexion...";
}

function guidanceFromStats(stats) {
  const free = Number(stats.free || 0);
  const occupied = Number(stats.occupied || 0);
  const total = Number(stats.total || 0);
  const rate = Number(stats.occupancyRate || 0);

  if (total === 0) return { text: "Aucune place", tone: "warn" };
  if (free === 0) return { text: "Complet", tone: "danger" };
  if (rate >= 85) return { text: "Presque complet", tone: "warn" };
  if (occupied === 0) return { text: "Tout est libre", tone: "good" };
  return { text: "Disponible", tone: "good" };
}

function gateStatusFr(status) {
  if (status === "OPEN") return "OUVERTE";
  if (status === "CLOSED") return "FERMEE";
  return status || "-";
}

function eventTypeFr(type) {
  const map = {
    SYSTEM: "SYSTEME",
    SENSOR: "CAPTEUR",
    GATE: "BARRIERE",
    ACCESS: "ACCES",
  };
  return map[type] || type || "-";
}

function eventMessageFr(message) {
  if (!message) return "-";

  if (message === "Server started") return "Serveur demarre";
  if (message === "Gate set to OPEN") return "Barriere definie sur OUVERTE";
  if (message === "Gate set to CLOSED") return "Barriere definie sur FERMEE";
  if (message === "Car entry blocked: parking full") return "Entree refusee : parking complet";
  if (message === "Car entry accepted: gate opened") return "Entree autorisee : barriere ouverte";
  if (message === "Car exit: gate opened") return "Sortie : barriere ouverte";
  if (message === "Car exit blocked: no occupied spot") return "Sortie refusee : aucune place occupee";

  const entrySpotMatch = message.match(/^Car entry accepted: spot\s+([A-Za-z0-9_-]+)\s+assigned$/);
  if (entrySpotMatch) {
    return `Entree acceptee : place ${entrySpotMatch[1]} attribuee`;
  }

  const exitSpotMatch = message.match(/^Car exit processed: spot\s+([A-Za-z0-9_-]+)\s+released$/);
  if (exitSpotMatch) {
    return `Sortie traitee : place ${exitSpotMatch[1]} liberee`;
  }

  const spotMatch = message.match(/^Spot\s+(\d+)\s+->\s+(OCCUPIED|FREE)$/);
  if (spotMatch) {
    const id = spotMatch[1];
    const state = spotMatch[2] === "OCCUPIED" ? "occupee" : "libre";
    return `Place ${id} -> ${state}`;
  }

  return message;
}

function createSpotButton(spot) {
  const isOccupied = Boolean(spot.isOccupied);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `parking-slot ${isOccupied ? "is-occupied" : "is-free"}`;
  button.title = "Basculer l'etat du capteur";

  const label = document.createElement("span");
  label.className = "slot-label";
  label.textContent = spot.label;

  const vehicle = document.createElement("span");
  vehicle.className = "slot-vehicle";
  vehicle.textContent = isOccupied ? "🚗" : "";

  const status = document.createElement("span");
  status.className = "slot-status";
  status.textContent = isOccupied ? "Occupee" : "Libre";

  button.append(label, vehicle, status);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api("/api/sensor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spotId: spot.id, occupied: !isOccupied }),
      });
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });

  return button;
}

function renderSpots(spots) {
  ui.spots.innerHTML = "";
  const ordered = [...(spots || [])].sort((a, b) => a.id - b.id);

  if (!ordered.length) {
    const empty = document.createElement("div");
    empty.className = "event-empty";
    empty.textContent = "Aucune place de parking disponible.";
    ui.spots.appendChild(empty);
    return;
  }

  const splitIndex = Math.ceil(ordered.length / 2);
  const northRow = ordered.slice(0, splitIndex);
  const southRow = ordered.slice(splitIndex).reverse();

  const shell = document.createElement("div");
  shell.className = "map-shell";

  const topRow = document.createElement("div");
  topRow.className = "slot-row";
  northRow.forEach((spot) => topRow.appendChild(createSpotButton(spot)));
  shell.appendChild(topRow);

  const lane = document.createElement("div");
  lane.className = "drive-lane";
  lane.textContent = "Voie de circulation";
  shell.appendChild(lane);

  if (southRow.length) {
    const bottomRow = document.createElement("div");
    bottomRow.className = "slot-row";
    southRow.forEach((spot) => bottomRow.appendChild(createSpotButton(spot)));
    shell.appendChild(bottomRow);
  }

  ui.spots.appendChild(shell);
}

function renderGate(gate) {
  if (!gate) return;
  const status = gate.status || "-";
  ui.gateStatus.textContent = gateStatusFr(status);
  ui.gateStatus.dataset.state = status;
  ui.gateUpdated.textContent = fmtTime(gate.lastUpdated);
}

function renderStats(stats) {
  if (!stats) return;
  const total = Number(stats.total || 0);
  const free = Number(stats.free || 0);
  const occupied = Number(stats.occupied || 0);
  const rate = Math.max(0, Math.min(100, Number(stats.occupancyRate || 0)));
  const guidance = guidanceFromStats(stats);

  ui.kTotal.textContent = String(total);
  ui.kFree.textContent = String(free);
  ui.kOcc.textContent = String(occupied);
  ui.kRate.textContent = `${rate}%`;
  ui.kRateLabel.textContent = `${rate}%`;
  ui.kDisplay.textContent = guidance.text;
  ui.kDisplay.dataset.tone = guidance.tone;
  ui.occupancyBar.style.width = `${rate}%`;
  ui.occupancyBar.dataset.tone = guidance.tone;

  if (free === 0) {
    ui.gateHint.textContent = "Aucune place libre. Gardez la barriere fermee pour les arrivees.";
  } else if (rate >= 85) {
    ui.gateHint.textContent = "Parking presque complet. Ouvrir seulement pour une arrivee confirmee.";
  } else {
    ui.gateHint.textContent = `${free} place${free === 1 ? "" : "s"} libre${free === 1 ? "" : "s"}. Entree autorisee.`;
  }
}

function renderEvents(events) {
  ui.events.innerHTML = "";
  if (!events || events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event-empty";
    empty.textContent = "Aucun evenement pour le moment.";
    ui.events.appendChild(empty);
    return;
  }

  for (const event of events) {
    const item = document.createElement("article");
    item.className = "event-item";

    const head = document.createElement("div");
    head.className = "event-item-head";

    const type = document.createElement("span");
    type.className = "event-type";
    type.textContent = eventTypeFr(event.type);

    const time = document.createElement("span");
    time.className = "event-time mono";
    time.textContent = fmtTime(event.createdAt);

    head.append(type, time);

    const message = document.createElement("p");
    message.className = "event-message";
    message.textContent = eventMessageFr(event.message);

    item.append(head, message);
    ui.events.appendChild(item);
  }
}

async function refreshLog() {
  const { events } = await api("/api/events?limit=30");
  renderEvents(events || []);
}

async function fetchSnapshotData() {
  const [spotsData, statsData, gateData] = await Promise.all([
    api("/api/spots"),
    api("/api/stats"),
    api("/api/gate"),
  ]);
  return {
    spots: spotsData.spots || [],
    stats: statsData || {},
    gate: gateData.gate,
  };
}

async function refreshSnapshot() {
  const snapshot = await fetchSnapshotData();
  renderSpots(snapshot.spots);
  renderStats(snapshot.stats);
  renderGate(snapshot.gate);
  return snapshot;
}

function bindPostAction(button, url) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(url, { method: "POST" });
      await refreshSnapshot();
      await refreshLog();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

bindPostAction(ui.btnOpen, "/api/gate/open");
bindPostAction(ui.btnClose, "/api/gate/close");

async function forceSensorUpdate(targetOccupied) {
  const { spots } = await fetchSnapshotData();
  const candidate = spots.find((spot) =>
    targetOccupied ? !Boolean(spot.isOccupied) : Boolean(spot.isOccupied)
  );
  if (!candidate) return false;

  await api("/api/sensor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spotId: candidate.id, occupied: targetOccupied }),
  });
  return true;
}

async function handleSimulatedFlow(button, routeUrl, mode) {
  button.disabled = true;
  try {
    const before = await api("/api/stats");
    await api(routeUrl, { method: "POST" });
    const after = await api("/api/stats");

    const beforeOcc = Number(before.occupied || 0);
    const afterOcc = Number(after.occupied || 0);
    const changedByRoute =
      mode === "entry" ? afterOcc > beforeOcc : afterOcc < beforeOcc;

    if (!changedByRoute) {
      const forced = await forceSensorUpdate(mode === "entry");
      if (!forced) {
        alert(
          mode === "entry"
            ? "Aucune place libre disponible."
            : "Aucune place occupee a liberer."
        );
      }
    }

    await refreshSnapshot();
    await refreshLog();
  } catch (error) {
    await refreshSnapshot().catch(() => {});
    await refreshLog().catch(() => {});
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

ui.btnEntry.addEventListener("click", () =>
  handleSimulatedFlow(ui.btnEntry, "/api/gate/car-entry", "entry")
);
ui.btnExit.addEventListener("click", () =>
  handleSimulatedFlow(ui.btnExit, "/api/gate/car-exit", "exit")
);

ui.btnRefreshLog.addEventListener("click", () => {
  refreshLog().catch(() => {});
});

const socket = io();

socket.on("connect", () => setSocketBadge(true));
socket.on("disconnect", () => setSocketBadge(false));
socket.on("state", (payload = {}) => {
  renderSpots(payload.spots || []);
  renderStats(payload.stats || {});
  renderGate(payload.gate);
  renderEvents(payload.events || []);
});

setSocketBadge(false);
refreshSnapshot().catch(() => {});
refreshLog().catch(() => {});

setInterval(() => {
  if (!socket.connected) refreshSnapshot().catch(() => {});
  refreshLog().catch(() => {});
}, 20000);
