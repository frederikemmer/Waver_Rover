"use strict";

const cameraFeed = document.getElementById("camera-feed");
const cameraViewport = document.querySelector(".camera-viewport");
const cameraResolution = document.getElementById("camera-resolution");
const cameraPlaceholder = document.getElementById("camera-placeholder");
const cameraStatus = document.getElementById("camera-status");
const cameraLiveLabel = document.getElementById("camera-live-label");
const driveStatus = document.getElementById("drive-status");
const batteryReadout = document.getElementById("battery-readout");
const batteryPercent = document.getElementById("battery-percent");
const batteryVoltage = document.getElementById("battery-voltage");
const apiSearch = document.getElementById("api-search");
const apiEntries = Array.from(document.querySelectorAll("[data-api-entry]"));
const apiSearchResults = document.getElementById("api-search-results");
const apiNoResults = document.getElementById("api-no-results");
const apiGuide = document.getElementById("api-guide");
const apiDiscoveryLink = document.getElementById("api-discovery-link");
const workspace = document.querySelector(".workspace");
const controlCard = document.querySelector(".control-card");
const workspaceSplitter = document.querySelector(".workspace-splitter");
const speedInput = document.getElementById("speed");
const speedNumber = document.getElementById("speed-number");
const speedMaximumLabel = document.getElementById("speed-maximum-label");
const directionButtons = Array.from(document.querySelectorAll("[data-direction]"));

const pointerDirections = new Map();
const keyboardDirections = new Map();
let power = Number(speedInput.value) / 100;
let maxPower = 1;
let inFlight = false;
let pendingSend = false;
let resolutionPending = false;
let lastCameraPreset = cameraResolution.value;
let splitterPointerId = null;
let splitterStartX = 0;
let splitterStartWidth = 0;

function setStatus(element, state, label) {
  element.classList.remove("status-ready", "status-warning", "status-waiting");
  element.classList.add(
    state === "ready" ? "status-ready" : state === "warning" ? "status-warning" : "status-waiting"
  );
  element.querySelector("span:last-child").textContent = label;
}

function updateBattery(battery) {
  const state = battery.state || "waiting";
  const voltage = Number(battery.voltage_v);
  batteryReadout.dataset.state = state;

  const estimate = battery.charge_percent_estimate;
  if (Number.isFinite(estimate)) {
    batteryPercent.textContent = `~${Math.round(estimate)} %`;
    batteryPercent.title = "Grobe Schätzung aus der Spannung; unter Last kann sie abweichen.";
  } else {
    batteryPercent.textContent = state === "disabled" ? "Nicht verfügbar" : "Warte auf Messwert …";
  }

  if (Number.isFinite(voltage) && voltage > 0) {
    batteryVoltage.textContent = `${new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(voltage)} V`;
    const age = battery.updated_age_s;
    const freshness = state === "stale"
      ? (age == null ? "Akkumesswert ist veraltet" : `Akkumesswert ist veraltet, zuletzt vor ${age} s`)
      : age == null ? "Batteriespannung vom Rover" : `Letzter Messwert vor ${age} s`;
    batteryReadout.title = `${freshness}. Die Prozentangabe ist eine grobe 3S-Li-Ion-Spannungsschätzung und kann unter Motorlast abweichen.`;
  } else {
    batteryVoltage.textContent = state === "disabled" ? "Nicht verfügbar" : "Warte auf Messwert …";
    batteryPercent.textContent = state === "disabled" ? "Nicht verfügbar" : "Warte auf Messwert …";
    batteryReadout.title = "Der Rover meldet noch keine Batteriespannung";
  }
}

function filterApiEntries() {
  const query = apiSearch.value.trim().toLocaleLowerCase("de-DE");
  let visibleCount = 0;
  for (const entry of apiEntries) {
    const matches = entry.textContent.toLocaleLowerCase("de-DE").includes(query);
    entry.hidden = !matches;
    visibleCount += matches ? 1 : 0;
  }
  apiSearchResults.textContent = query
    ? `${visibleCount} von ${apiEntries.length} Endpunkten`
    : `${apiEntries.length} Endpunkte`;
  apiNoResults.hidden = visibleCount !== 0;
}

apiSearch.addEventListener("input", filterApiEntries);
apiDiscoveryLink.addEventListener("click", () => {
  apiGuide.open = true;
});
filterApiEntries();

const CONTROL_WIDTH_MIN = 340;
const CONTROL_WIDTH_MAX = 540;
const CONTROL_WIDTH_STEP = 20;
const CAMERA_WIDTH_MIN = 320;
const SPLITTER_AND_GAPS_WIDTH = 56;

function getControlWidth() {
  return Number(workspace.dataset.controlWidth) || 380;
}

function getControlWidthMax() {
  const available = workspace.clientWidth - SPLITTER_AND_GAPS_WIDTH - CAMERA_WIDTH_MIN;
  const rounded = Math.floor(available / CONTROL_WIDTH_STEP) * CONTROL_WIDTH_STEP;
  return Math.max(CONTROL_WIDTH_MIN, Math.min(CONTROL_WIDTH_MAX, rounded));
}

function setControlWidth(width) {
  const maximum = getControlWidthMax();
  const bounded = Math.max(
    CONTROL_WIDTH_MIN,
    Math.min(maximum, Math.round(width / CONTROL_WIDTH_STEP) * CONTROL_WIDTH_STEP)
  );
  workspace.dataset.controlWidth = String(bounded);
  workspaceSplitter.setAttribute("aria-valuemax", String(maximum));
  workspaceSplitter.setAttribute("aria-valuenow", String(bounded));
  workspaceSplitter.setAttribute("aria-valuetext", `${bounded} Pixel Steuerungsbereich`);
}

workspaceSplitter.addEventListener("pointerdown", (event) => {
  if (window.matchMedia("(max-width: 900px)").matches || (event.pointerType === "mouse" && event.button !== 0)) {
    return;
  }
  event.preventDefault();
  splitterPointerId = event.pointerId;
  splitterStartX = event.clientX;
  splitterStartWidth = controlCard.getBoundingClientRect().width;
  workspaceSplitter.classList.add("is-dragging");
  workspaceSplitter.setPointerCapture(event.pointerId);
});

workspaceSplitter.addEventListener("pointermove", (event) => {
  if (event.pointerId !== splitterPointerId) {
    return;
  }
  setControlWidth(splitterStartWidth - (event.clientX - splitterStartX));
});

function finishSplitterDrag(event) {
  if (event.pointerId !== splitterPointerId) {
    return;
  }
  splitterPointerId = null;
  workspaceSplitter.classList.remove("is-dragging");
}

workspaceSplitter.addEventListener("pointerup", finishSplitterDrag);
workspaceSplitter.addEventListener("pointercancel", finishSplitterDrag);
workspaceSplitter.addEventListener("lostpointercapture", finishSplitterDrag);

workspaceSplitter.addEventListener("keydown", (event) => {
  const current = getControlWidth();
  const change = event.key === "ArrowLeft"
    ? CONTROL_WIDTH_STEP
    : event.key === "ArrowRight"
      ? -CONTROL_WIDTH_STEP
      : event.key === "Home"
        ? CONTROL_WIDTH_MIN - current
        : event.key === "End"
          ? getControlWidthMax() - current
          : 0;
  if (change === 0) {
    return;
  }
  event.preventDefault();
  setControlWidth(current + change);
});

window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 900px)").matches) {
    setControlWidth(getControlWidth());
  }
});
if (!window.matchMedia("(max-width: 900px)").matches) {
  setControlWidth(getControlWidth());
}

function activeDirections() {
  return new Set([...pointerDirections.values(), ...keyboardDirections.values()]);
}

function calculateWheels() {
  const held = activeDirections();
  const linear = (held.has("forward") ? 1 : 0) - (held.has("backward") ? 1 : 0);
  const turn = (held.has("left") ? 1 : 0) - (held.has("right") ? 1 : 0);
  const left = linear - turn;
  const right = linear + turn;
  const divisor = Math.max(1, Math.abs(left), Math.abs(right));
  const limitedPower = Math.min(power, maxPower) * 0.5;
  return {
    left: Number(((left / divisor) * limitedPower).toFixed(3)),
    right: Number(((right / divisor) * limitedPower).toFixed(3))
  };
}

function transmit() {
  if (inFlight) {
    pendingSend = true;
    return;
  }
  inFlight = true;
  const command = calculateWheels();
  fetch("/api/v1/drive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store"
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Antrieb nicht erreichbar");
      }
    })
    .catch(() => setStatus(driveStatus, "warning", "Befehl nicht bestätigt"))
    .finally(() => {
      inFlight = false;
      if (pendingSend) {
        pendingSend = false;
        transmit();
      }
    });
}

function updateButtonStyles() {
  const held = activeDirections();
  for (const button of directionButtons) {
    button.classList.toggle("is-active", held.has(button.dataset.direction));
  }
}

function pressPointer(event) {
  event.preventDefault();
  const button = event.currentTarget;
  pointerDirections.set(event.pointerId, button.dataset.direction);
  if (button.setPointerCapture) {
    button.setPointerCapture(event.pointerId);
  }
  updateButtonStyles();
  transmit();
}

function releasePointer(event) {
  pointerDirections.delete(event.pointerId);
  updateButtonStyles();
  transmit();
}

for (const button of directionButtons) {
  button.addEventListener("pointerdown", pressPointer);
  button.addEventListener("pointerup", releasePointer);
  button.addEventListener("pointercancel", releasePointer);
  button.addEventListener("lostpointercapture", releasePointer);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

const keyDirections = new Map([
  ["KeyW", "forward"],
  ["ArrowUp", "forward"],
  ["KeyS", "backward"],
  ["ArrowDown", "backward"],
  ["KeyA", "left"],
  ["ArrowLeft", "left"],
  ["KeyD", "right"],
  ["ArrowRight", "right"]
]);

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [role='separator']")) {
    return;
  }
  const direction = keyDirections.get(event.code);
  if (!direction || event.repeat) {
    return;
  }
  event.preventDefault();
  keyboardDirections.set(event.code, direction);
  updateButtonStyles();
  transmit();
});

window.addEventListener("keyup", (event) => {
  const direction = keyDirections.get(event.code);
  if (!direction) {
    return;
  }
  keyboardDirections.delete(event.code);
  updateButtonStyles();
  transmit();
});

function releaseAll() {
  keyboardDirections.clear();
  pointerDirections.clear();
  updateButtonStyles();
  transmit();
}

window.addEventListener("blur", releaseAll);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    releaseAll();
  }
});

function setSpeedPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return;
  }
  const maximum = Math.floor(maxPower * 100);
  const percent = Math.round(Math.max(0, Math.min(maximum, parsed)));
  speedInput.value = String(percent);
  speedNumber.value = String(percent);
  power = percent / 100;
  updateSpeedTrack();
  if (activeDirections().size > 0) {
    transmit();
  }
}

speedInput.addEventListener("input", () => setSpeedPercent(speedInput.value));
speedNumber.addEventListener("input", () => {
  if (speedNumber.value !== "") {
    setSpeedPercent(speedNumber.value);
  }
});
speedNumber.addEventListener("change", () => {
  setSpeedPercent(speedNumber.value === "" ? speedInput.value : speedNumber.value);
});

function updateSpeedTrack() {
  const maximum = Number(speedInput.max);
  const percent = maximum > 0 ? (Number(speedInput.value) / maximum) * 100 : 0;
  speedInput.style.background =
    "linear-gradient(90deg, var(--cyan) 0%, var(--cyan) " + percent +
    "%, #34495d " + percent + "%, #34495d 100%)";
}

function updateCameraResolution(camera) {
  const width = Number(camera.width);
  const height = Number(camera.height);
  if (width > 0 && height > 0) {
    cameraViewport.style.setProperty("--camera-aspect", `${width} / ${height}`);
  }
  if (!resolutionPending && camera.preset && cameraResolution.value !== camera.preset) {
    cameraResolution.value = camera.preset;
  }
  if (camera.preset) {
    lastCameraPreset = camera.preset;
  }
}

cameraResolution.addEventListener("change", async () => {
  const preset = cameraResolution.value;
  resolutionPending = true;
  cameraResolution.disabled = true;
  try {
    const response = await fetch("/api/v1/camera/resolution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset }),
      cache: "no-store"
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) {
      throw new Error(result.error || "Auflösung konnte nicht gewechselt werden");
    }
    updateCameraResolution(result.camera || {});
  } catch (error) {
    cameraResolution.value = lastCameraPreset;
    setStatus(cameraStatus, "warning", "Auflösung nicht verfügbar");
    console.error(error.message);
  } finally {
    resolutionPending = false;
    cameraResolution.disabled = false;
    refreshStatus();
  }
});

cameraFeed.addEventListener("load", () => {
  cameraFeed.classList.add("loaded");
  cameraPlaceholder.hidden = true;
});

cameraFeed.addEventListener("error", () => {
  cameraFeed.classList.remove("loaded");
  cameraPlaceholder.hidden = false;
});

async function refreshStatus() {
  try {
    const response = await fetch("/api/v1/status", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Status unavailable");
    }
    const status = await response.json();
    const drive = status.drive || {};
    updateBattery(status.battery || { state: "waiting" });
    const camera = status.camera || {};

    if (Number.isFinite(Number(drive.max_speed))) {
      maxPower = Math.max(0, Math.min(1, Number(drive.max_speed) / 0.5));
      const maximum = Math.floor(maxPower * 100);
      speedInput.max = String(maximum);
      speedNumber.max = String(maximum);
      speedMaximumLabel.textContent = `${maximum} %`;
      if (Number(speedInput.value) > maximum) {
        setSpeedPercent(maximum);
      }
      updateSpeedTrack();
    }

    updateCameraResolution(camera);

    if (drive.state === "connected") {
      setStatus(driveStatus, "ready", "UART bereit");
    } else if (drive.state === "disabled") {
      setStatus(driveStatus, "warning", "Motorsteuerung aus");
    } else if (drive.state === "offline") {
      setStatus(driveStatus, "warning", "UART nicht erreichbar");
    } else {
      setStatus(driveStatus, "waiting", "Verbinde …");
    }

    if (camera.state === "online") {
      setStatus(cameraStatus, "ready", "Kamera bereit");
      cameraLiveLabel.classList.remove("is-offline");
      cameraLiveLabel.querySelector("span:last-child").textContent = "LIVE";
      cameraFeed.classList.add("loaded");
      cameraPlaceholder.hidden = true;
    } else if (camera.state === "disabled") {
      setStatus(cameraStatus, "warning", "Kamera deaktiviert");
      cameraLiveLabel.classList.add("is-offline");
      cameraLiveLabel.querySelector("span:last-child").textContent = "STANDBY";
      cameraFeed.classList.remove("loaded");
      cameraPlaceholder.hidden = false;
    } else if (camera.state === "offline") {
      setStatus(cameraStatus, "warning", "Kamera offline");
      cameraLiveLabel.classList.add("is-offline");
      cameraLiveLabel.querySelector("span:last-child").textContent = "OFFLINE";
      cameraFeed.classList.remove("loaded");
      cameraPlaceholder.hidden = false;
    } else {
      setStatus(cameraStatus, "waiting", "Verbinde …");
      cameraLiveLabel.classList.add("is-offline");
      cameraLiveLabel.querySelector("span:last-child").textContent = "WARTET";
      cameraFeed.classList.remove("loaded");
      cameraPlaceholder.hidden = false;
    }
  } catch (_error) {
    updateBattery({ state: "stale" });
    setStatus(driveStatus, "warning", "Rover nicht erreichbar");
    setStatus(cameraStatus, "warning", "Verbindung verloren");
    cameraLiveLabel.classList.add("is-offline");
    cameraLiveLabel.querySelector("span:last-child").textContent = "OFFLINE";
  }
}

window.setInterval(() => {
  if (activeDirections().size > 0) {
    transmit();
  }
}, 125);
window.setInterval(refreshStatus, 1500);
window.addEventListener("pagehide", () => {
  const stop = new Blob([JSON.stringify({ left: 0, right: 0 })], {
    type: "application/json"
  });
  navigator.sendBeacon("/api/v1/drive", stop);
});

refreshStatus();
updateSpeedTrack();
