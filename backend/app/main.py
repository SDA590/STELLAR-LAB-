from __future__ import annotations

import hashlib
import hmac
import os
import time
from collections import deque
from datetime import datetime, timezone
from math import floor, pi, sin, sqrt
from typing import Literal

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import alerts, analysis, ctx, supabase_store

supabase_store.load_env_file()

AstronautId = Literal["bresnik", "parmitano", "douglas", "rubio"]
ASTRONAUTS: dict[str, dict[str, float]] = {
    "bresnik": {"heart": 71, "respiration": 15.4, "movement": 82, "phase": 0.0},
    "parmitano": {"heart": 68, "respiration": 14.8, "movement": 91, "phase": 1.2},
    "douglas": {"heart": 76, "respiration": 17.2, "movement": 74, "phase": 2.4},
    "rubio": {"heart": 70, "respiration": 15.9, "movement": 86, "phase": 3.6},
}

# Si un astronauta no envía datos reales en este tiempo, su ficha pasa a simulación.
# (10 s: el ESP32 hoy envía cada ~4 s; con 5 s el panel parpadeaba entre ESP32 y SIM.)
LIVE_WINDOW_S = 10
MAX_HISTORY = 240
# Ventana de filas que se piden a Supabase para un astronauta (línea base de 10 min + margen).
ASTRONAUT_WINDOW_S = analysis.BASELINE_WINDOW_S + LIVE_WINDOW_S + 5

SESSION_COOKIE = "stellar_session"
SESSION_DAYS = 7
# Rutas de /api que no necesitan contraseña.
PUBLIC_API = {"/api/login", "/api/logout", "/api/session", "/api/health"}


class TelemetryIn(BaseModel):
    astronaut_id: AstronautId = "bresnik"
    device_id: str = "stellar-node-01"
    ecg_raw: int = Field(ge=0, le=4095)
    heart_rate_bpm: float | None = Field(default=None, ge=25, le=240)
    leads_off: bool = False
    resp_raw: int = Field(default=0, ge=0, le=4095)
    respiration_rate_bpm: float | None = Field(default=None, ge=0, le=60)
    ax: float = 0
    ay: float = 0
    az: float = 0
    gx: float = 0
    gy: float = 0
    gz: float = 0
    pos_x_m: float = 0
    pos_y_m: float = 0
    pos_z_m: float | None = None
    # Temperatura y presión que el ESP32 envía (hoy las fija Ricardo desde la página local del ESP32).
    temperature_c: float | None = Field(default=None, ge=30, le=45)
    blood_pressure_systolic_mmhg: float | None = Field(default=None, ge=60, le=250)
    blood_pressure_diastolic_mmhg: float | None = Field(default=None, ge=30, le=150)
    area_m2: float = Field(default=0, ge=0)
    steps: int = Field(default=0, ge=0)
    battery_pct: int = Field(default=100, ge=0, le=100)
    timestamp_ms: int | None = None


class DemoIn(BaseModel):
    """Activa (o quita, con scenario=None) un escenario de demo. Sin astronauta = quitar todos."""
    astronaut_id: AstronautId | None = None
    scenario: Literal["fatigue", "stress", "fever", "leads_off", "drift"] | None = None


class LoginIn(BaseModel):
    password: str


class CheckinIn(BaseModel):
    """Chequeo diario manual. Todos los campos son opcionales salvo el astronauta."""
    astronaut_id: AstronautId
    sleep_hours: float | None = Field(default=None, ge=0, le=24)
    mood: int | None = Field(default=None, ge=1, le=5)
    stress: int | None = Field(default=None, ge=1, le=5)
    glucose_mg_dl: float | None = Field(default=None, ge=20, le=600)
    systolic_mmhg: float | None = Field(default=None, ge=60, le=250)
    diastolic_mmhg: float | None = Field(default=None, ge=30, le=150)
    temperature_c: float | None = Field(default=None, ge=30, le=45)
    notes: str | None = Field(default=None, max_length=500)


app = FastAPI(title="STELLAR Health API", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paquetes recibidos por POST /api/telemetry (ruta local directa al backend).
# Solo vive en memoria: en Vercel no se comparte entre instancias, por eso allí
# el ESP32 debe enviar a Supabase.
local_packets: dict[str, deque[dict]] = {key: deque(maxlen=analysis.BASELINE_WINDOW_S + 30) for key in ASTRONAUTS}
# Respaldo de chequeos si la tabla `checkins` de Supabase no existe o falla.
local_checkins: dict[str, deque[dict]] = {key: deque(maxlen=200) for key in ASTRONAUTS}


# --------------------------------------------------------------------------- #
# Contraseña de acceso (opcional)
# --------------------------------------------------------------------------- #
def app_password() -> str:
    return os.environ.get("APP_PASSWORD", "")


def _signature(expires: int) -> str:
    return hmac.new(app_password().encode(), f"stellar-session:{expires}".encode(), hashlib.sha256).hexdigest()


def session_valid(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    expires_text, signature = token.split(".", 1)
    if not expires_text.isdigit() or int(expires_text) < time.time():
        return False
    return hmac.compare_digest(signature, _signature(int(expires_text)))


def is_authenticated(request: Request) -> bool:
    return not app_password() or session_valid(request.cookies.get(SESSION_COOKIE))


@app.middleware("http")
async def require_password(request: Request, call_next):
    path = request.url.path
    # Idioma de los textos del backend y escenarios de demo de este navegador.
    ctx.LANG.set(ctx.parse_lang(request.headers.get("x-stellar-lang")))
    ctx.SCENARIOS.set(ctx.parse_scenarios(request.cookies.get(ctx.DEMO_COOKIE)))
    if path.startswith("/api") and path not in PUBLIC_API and not is_authenticated(request):
        return JSONResponse({"detail": ctx.tr("Se requiere contraseña", "Password required")}, status_code=401)
    return await call_next(request)


@app.get("/api/session")
def session(request: Request) -> dict:
    return {"required": bool(app_password()), "authenticated": is_authenticated(request)}


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response) -> dict:
    password = app_password()
    if not password:
        return {"authenticated": True}
    if not hmac.compare_digest(body.password.encode(), password.encode()):
        time.sleep(1)  # frena intentos repetidos
        response.status_code = 401
        return {"authenticated": False, "detail": "Contraseña incorrecta"}
    expires = int(time.time()) + SESSION_DAYS * 86400
    https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(
        SESSION_COOKIE,
        f"{expires}.{_signature(expires)}",
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        secure=https,
        samesite="lax",
        path="/",
    )
    return {"authenticated": True}


@app.post("/api/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"authenticated": False}


# --------------------------------------------------------------------------- #
# Datos: simulación calculada al momento + filas reales
# --------------------------------------------------------------------------- #
def _noise(t: float, seed: float, amplitude: float) -> float:
    """Ruido pseudoaleatorio pero fijo para cada instante (el gráfico no 'tiembla')."""
    x = sin(t * 12.9898 + seed * 78.233) * 43758.5453
    return (x - floor(x) - 0.5) * 2 * amplitude


# Escenarios de demo: cuánto sube cada señal SIMULADA con el escenario al 100 %.
# (El cambio aparece poco a poco en 30 s; nunca toca las filas reales del ESP32.)
SCENARIO_EFFECTS = {
    "fatigue": {"heart": 18, "respiration": 0.6},
    "stress": {"heart": 30, "respiration": 9},
    "fever": {"heart": 28, "respiration": 2},
    "drift": {"heart": 0, "respiration": 0},
    "leads_off": {"heart": 0, "respiration": 0},
}
# Chequeo "virtual" que acompaña a algunos escenarios (como si el astronauta lo hubiera llenado).
SCENARIO_CHECKINS = {
    "fatigue": {"sleep_hours": 4.5, "mood": 3, "stress": 2},
    "stress": {"sleep_hours": 5.5, "mood": 2, "stress": 5},
}
DRIFT_TARGET = (1.45, 0.5, 0.25)  # escenario "posición desviada": la estimación se sale de la cabina


def sim_position(astronaut_id: str, ts: float) -> tuple[float, float, float]:
    """Movimiento simulado en la cabina; con el escenario `drift` la estimación se va fuera de la pared."""
    x, y, z = analysis.eva_position(ASTRONAUTS[astronaut_id]["phase"], ts)
    name, _, k = ctx.scenario(astronaut_id, ts)
    if name == "drift" and k > 0:
        tx, ty, tz = DRIFT_TARGET
        x, y, z = round(x + k * (tx - x), 2), round(y + k * (ty - y), 2), round(z + k * (tz - z), 2)
    return x, y, z


def simulated_sample(astronaut_id: str, ts: float) -> dict:
    """Muestra simulada para el instante `ts` (segundos Unix). Siempre da lo mismo para el mismo ts."""
    sample = _base_simulated_sample(astronaut_id, ts)
    name, _, k = ctx.scenario(astronaut_id, ts)
    if not name or k <= 0:
        return sample
    effect = SCENARIO_EFFECTS[name]
    sample["scenario"] = name
    sample["heart_rate_bpm"] = round(sample["heart_rate_bpm"] + k * effect["heart"], 1)
    sample["respiration_rate_bpm"] = round(sample["respiration_rate_bpm"] + k * effect["respiration"], 1)
    if name == "leads_off":
        # Electrodo suelto: el AD8232 marca LO y la señal queda plana y sin pulso calculable.
        sample.update(leads_off=True, heart_rate_bpm=None, respiration_rate_bpm=None,
                      ecg_raw=int(4000 + _noise(ts % 86400, 7, 40)))
    return sample


def _base_simulated_sample(astronaut_id: str, ts: float) -> dict:
    config = ASTRONAUTS[astronaut_id]
    t = ts % 86400
    phase = config["phase"]
    beat = sin(2 * pi * (config["heart"] / 60) * t + phase)
    qrs = max(0.0, beat) ** 18
    respiratory_wave = sin(2 * pi * (config["respiration"] / 60) * t + phase)
    x, y, z = sim_position(astronaut_id, ts)
    return {
        "astronaut_id": astronaut_id,
        "device_id": f"sim-{astronaut_id}",
        "source": "simulation",
        "received_at": datetime.fromtimestamp(ts, timezone.utc).isoformat(),
        "ecg_raw": int(1900 + 110 * beat + 720 * qrs + _noise(t, phase + 1, 18)),
        "leads_off": False,
        "heart_rate_bpm": round(config["heart"] + 2 * sin(t / 9 + phase), 1),
        "resp_raw": int(2050 + 520 * respiratory_wave + _noise(t, phase + 2, 12)),
        "respiration_rate_bpm": round(config["respiration"] + 0.5 * sin(t / 18 + phase), 1),
        "ax": round(0.18 * sin(t * 2.2 + phase), 3),
        "ay": round(0.14 * sin(t * 1.8 + 1 + phase), 3),
        "az": round(9.81 + 0.12 * sin(t * 2.7 + phase), 3),
        "gx": round(8 * sin(t * 1.2 + phase), 2),
        "gy": round(5 * sin(t * 1.4 + phase), 2),
        "gz": round(3 * sin(t + phase), 2),
        "pos_x_m": round(x, 2),
        "pos_y_m": round(y, 2),
        "pos_z_m": round(z, 2),
        "area_m2": round(4 * 1.25 * 0.85, 2),
        "steps": int(t / 9) + int(config["movement"]),
        "battery_pct": 86,
    }


def real_rows(astronaut_id: str | None, window_s: float) -> list[dict]:
    """Filas reales (Supabase + POST local) de los últimos `window_s` s, ordenadas por tiempo."""
    since = time.time() - window_s
    rows = [r for r in supabase_store.recent_rows(astronaut_id, window_s) if r["_ts"] >= since]
    for key, packets in local_packets.items():
        if astronaut_id in (None, key):
            rows.extend(p for p in packets if p["_ts"] >= since)
    rows.sort(key=lambda r: r["_ts"])
    return rows


def public(row: dict) -> dict:
    return {k: v for k, v in row.items() if not k.startswith("_")}


def current_sample(astronaut_id: str) -> dict:
    rows = real_rows(astronaut_id, ASTRONAUT_WINDOW_S)
    now = time.time()
    if rows and now - rows[-1]["_ts"] < LIVE_WINDOW_S:
        return public(rows[-1])
    return simulated_sample(astronaut_id, now)


def timeline(astronaut_id: str, limit: int) -> list[dict]:
    """Una muestra por segundo de los últimos `limit` segundos.

    En cada segundo se usa la última fila real si el hardware estaba 'vivo' en ese
    momento (llegó algo en los LIVE_WINDOW_S previos); si no, la simulación de ese segundo.
    """
    rows = real_rows(astronaut_id, ASTRONAUT_WINDOW_S)
    end = floor(time.time())
    items: list[dict] = []
    index = -1
    for second in range(end - limit + 1, end + 1):
        while index + 1 < len(rows) and rows[index + 1]["_ts"] < second + 1:
            index += 1
        if index >= 0 and second + 1 - rows[index]["_ts"] <= LIVE_WINDOW_S:
            items.append(public(rows[index]))
        else:
            items.append(simulated_sample(astronaut_id, second))
    return items


def safe_baseline(samples: list[dict]) -> dict:
    """La línea base nunca debe tumbar la API: si algo falla, queda 'calibrando'."""
    try:
        return analysis.baseline(samples)
    except Exception:  # noqa: BLE001
        return {"source": None, "window_s": analysis.BASELINE_WINDOW_S, "level": "calibrating", "signals": {}}


def crew_summary(sample: dict, base: dict) -> dict:
    heart = sample.get("heart_rate_bpm")
    respiration = sample.get("respiration_rate_bpm")
    movement = min(100, max(0, int((sample.get("steps") or 0) % 101)))
    if sample["source"] == "simulation":
        movement = int(ASTRONAUTS[sample["astronaut_id"]]["movement"])
    signals = list(base.get("signals", {}).values())
    observe = base.get("level") in ("observe", "alert", "unreliable")
    z_total = sum(abs(s["z"]) for s in signals if s.get("z") is not None)
    recovery = max(45, min(98, round(96 - 8 * z_total)))
    return {
        "astronaut_id": sample["astronaut_id"],
        "source": sample["source"],
        "heart_rate_bpm": heart,
        "respiration_rate_bpm": respiration,
        "movement_score": movement,
        "recovery_score": recovery,
        "status": "Observe" if observe else "Stable",
        "level": base.get("level"),
        "reasons": [s["message"] for s in signals if s.get("level") in ("observe", "alert", "unreliable")],
        "received_at": sample["received_at"],
    }


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    if supabase_store.configured():
        supabase_store.recent_rows(None, LIVE_WINDOW_S)  # comprueba la conexión
    return {
        "status": "ok",
        "service": "stellar-health-api",
        "crew_nodes": len(ASTRONAUTS),
        "password_required": bool(app_password()),
        "live_window_s": LIVE_WINDOW_S,
        **supabase_store.status,
    }


@app.get("/api/state")
def state(astronaut_id: AstronautId = "bresnik") -> dict:
    return current_sample(astronaut_id)


@app.get("/api/history")
def get_history(astronaut_id: AstronautId = "bresnik", limit: int = 120) -> dict:
    limit = max(1, min(limit, MAX_HISTORY))
    samples = timeline(astronaut_id, analysis.BASELINE_WINDOW_S)
    return {"astronaut_id": astronaut_id, "items": samples[-limit:], "baseline": safe_baseline(samples)}


@app.get("/api/baseline")
def get_baseline(astronaut_id: AstronautId = "bresnik") -> dict:
    return safe_baseline(timeline(astronaut_id, analysis.BASELINE_WINDOW_S))


@app.get("/api/crew")
def get_crew() -> dict:
    items = []
    for astronaut_id in ASTRONAUTS:
        samples = timeline(astronaut_id, analysis.BASELINE_WINDOW_S)
        items.append(crew_summary(samples[-1], safe_baseline(samples)))
    return {"items": items}


# --------------------------------------------------------------------------- #
# Chequeo diario manual y signos vitales periódicos
# --------------------------------------------------------------------------- #
def checkins_for(astronaut_id: str, days: float) -> tuple[list[dict], str]:
    """Chequeos de los últimos `days` días (más nuevo primero) y dónde están guardados."""
    since = time.time() - days * 86400
    rows = supabase_store.list_checkins(astronaut_id, since)
    if rows is not None:
        return rows, "supabase"
    local = [r for r in local_checkins[astronaut_id] if supabase_store.parse_ts(r["created_at"]) >= since]
    return sorted(local, key=lambda r: r["created_at"], reverse=True), "memory"


@app.post("/api/checkin")
def post_checkin(body: CheckinIn) -> dict:
    row = body.model_dump()
    if body.notes is not None:
        row["notes"] = body.notes.strip() or None
    saved = supabase_store.insert_checkin(row)
    if saved is not None:
        return {"saved": True, "storage": "supabase", "item": saved}
    row["created_at"] = datetime.now(timezone.utc).isoformat()
    local_checkins[body.astronaut_id].append(row)
    return {"saved": True, "storage": "memory", "item": row}


@app.get("/api/checkins")
def get_checkins(astronaut_id: AstronautId = "bresnik", days: float = 7) -> dict:
    items, storage = checkins_for(astronaut_id, max(0.1, min(days, 60)))
    return {"astronaut_id": astronaut_id, "storage": storage, "items": items}


@app.get("/api/vitals")
def get_vitals(astronaut_id: AstronautId = "bresnik") -> dict:
    """Presión y temperatura: del ESP32 si las envía; si no, simuladas cada 30 min. Más lo anotado a mano."""
    simulated = current_sample(astronaut_id)["source"] == "simulation"
    return vitals_for(astronaut_id, checkins_for(astronaut_id, 1)[0], simulated)


def vitals_for(astronaut_id: str, manual: list[dict], simulated: bool = True) -> dict:
    now = time.time()
    items = analysis.simulated_vitals(astronaut_id, now)
    since = items[0]["ts"]
    name, started, k = ctx.scenario(astronaut_id, now)
    if simulated and name == "fever" and k > 0:
        # Escenario fiebre: la medición automática de control marca la temperatura alta.
        base = analysis.VITALS_BASE[astronaut_id]
        items.append(analysis.vitals_item(max(started, now - 5), "simulation", base["sys"] + round(6 * k),
                                          base["dia"] + round(3 * k), round(base["temp"] + 2.0 * k, 1)))
    for row in manual:
        if row.get("systolic_mmhg") is None and row.get("temperature_c") is None:
            continue
        ts = supabase_store.parse_ts(row["created_at"])
        if ts >= since:
            items.append(analysis.vitals_item(ts, "manual", row.get("systolic_mmhg"), row.get("diastolic_mmhg"), row.get("temperature_c")))
    items.extend(hardware_vitals(astronaut_id))
    items.sort(key=lambda r: r["ts"])
    latest_bp = next((r for r in reversed(items) if r["systolic_mmhg"] is not None), None)
    latest_temp = next((r for r in reversed(items) if r["temperature_c"] is not None), None)
    return {
        "astronaut_id": astronaut_id,
        "interval_min": analysis.VITALS_INTERVAL_S // 60,
        "next_ts": (int(now // analysis.VITALS_INTERVAL_S) + 1) * analysis.VITALS_INTERVAL_S,
        "latest_bp": latest_bp,
        "latest_temp": latest_temp,
        "items": items,
    }


HARDWARE_VITALS_STEP_S = 60  # en el gráfico, una lectura del ESP32 por minuto


def hardware_vitals(astronaut_id: str) -> list[dict]:
    """Temperatura y presión que llegaron del ESP32 en los últimos ~10 min (una por minuto + la última).

    Si el ESP32 deja de enviarlas, al pasar esa ventana se vuelve a la medición simulada.
    """
    rows = [r for r in real_rows(astronaut_id, ASTRONAUT_WINDOW_S)
            if r.get("temperature_c") is not None or r.get("blood_pressure_systolic_mmhg") is not None]
    picked: dict[int, dict] = {}
    for row in rows:  # de la más antigua a la más nueva: queda la última de cada minuto
        picked[int(row["_ts"] // HARDWARE_VITALS_STEP_S)] = row
    out = []
    for row in picked.values():
        sys_, dia = row.get("blood_pressure_systolic_mmhg"), row.get("blood_pressure_diastolic_mmhg")
        temp = row.get("temperature_c")
        out.append(analysis.vitals_item(row["_ts"], "hardware",
                                        round(float(sys_)) if sys_ is not None else None,
                                        round(float(dia)) if dia is not None else None,
                                        round(float(temp), 1) if temp is not None else None))
    return out


# --------------------------------------------------------------------------- #
# Alertas (nivel 1/2/3) y reportes para los médicos en Tierra
# --------------------------------------------------------------------------- #
def assess(astronaut_id: str) -> dict:
    """Junta todo lo de un astronauta: línea base, vitales, chequeos, alertas y reporte."""
    samples = timeline(astronaut_id, analysis.BASELINE_WINDOW_S)
    base = safe_baseline(samples)
    checkins, _ = checkins_for(astronaut_id, 1)
    simulated = samples[-1].get("source") == "simulation"
    name, started, _ = ctx.scenario(astronaut_id)
    if simulated and name in SCENARIO_CHECKINS:
        virtual = {"astronaut_id": astronaut_id, "created_at": datetime.fromtimestamp(started, timezone.utc).isoformat(),
                   "source": "demo", **SCENARIO_CHECKINS[name]}
        checkins = [virtual, *checkins]
    vitals = vitals_for(astronaut_id, checkins, simulated)
    try:
        items = alerts.evaluate(base, samples[-1], vitals, checkins)
    except Exception:  # noqa: BLE001  (una regla rota no debe tumbar el panel)
        items = []
    report = alerts.build_report(astronaut_id, base, samples[-1], vitals, checkins, items, samples)
    return {"alerts": items, "report": report, "sample": samples[-1]}


@app.get("/api/alerts")
def get_alerts(astronaut_id: AstronautId = "bresnik") -> dict:
    items = assess(astronaut_id)["alerts"]
    return {"astronaut_id": astronaut_id, "max_level": max((a["level"] for a in items), default=0), "items": items}


@app.get("/api/report")
def get_report(astronaut_id: AstronautId = "bresnik") -> dict:
    return assess(astronaut_id)["report"]


@app.get("/api/mission-report")
def get_mission_report() -> dict:
    return {"generated_ts": time.time(), "items": [assess(a)["report"] for a in ASTRONAUTS]}


@app.post("/api/telemetry")
def telemetry(packet: TelemetryIn) -> dict:
    astronaut_id = packet.astronaut_id
    now = time.time()
    payload = packet.model_dump()
    payload.update(source="hardware", received_at=datetime.fromtimestamp(now, timezone.utc).isoformat(), _ts=now)
    local_packets[astronaut_id].append(payload)
    return {"accepted": True, "astronaut_id": astronaut_id, "samples": len(local_packets[astronaut_id])}


@app.get("/api/position")
def get_position(astronaut_id: AstronautId = "bresnik", limit: int = 120, demo: bool = False) -> dict:
    """Posición XYZ (m) respecto a la estación, distancia y estela para la vista 3D."""
    limit = max(10, min(limit, MAX_HISTORY))
    samples = timeline(astronaut_id, limit)
    track = analysis.position_track(samples, ASTRONAUTS[astronaut_id]["phase"], demo,
                                    lambda ts: sim_position(astronaut_id, ts))
    return {"astronaut_id": astronaut_id, "demo": demo, **track}


# --------------------------------------------------------------------------- #
# Escenarios de demostración (solo afectan a la SIMULACIÓN)
# --------------------------------------------------------------------------- #
def demo_state(items: dict[str, tuple[str, float]]) -> dict:
    now = time.time()
    out = []
    for astronaut_id, (name, started) in items.items():
        if astronaut_id not in ASTRONAUTS:
            continue
        live = current_sample(astronaut_id)["source"] == "hardware"
        out.append({"astronaut_id": astronaut_id, "scenario": name, "started": started,
                    "intensity": round(min(1.0, max(0.0, (now - started) / ctx.RAMP_S)), 2), "live_hardware": live})
    return {"items": out, "available": list(ctx.SCENARIO_IDS), "ramp_s": ctx.RAMP_S}


@app.get("/api/demo")
def get_demo() -> dict:
    return demo_state(ctx.SCENARIOS.get())


@app.post("/api/demo")
def post_demo(body: DemoIn, request: Request, response: Response) -> dict:
    items = dict(ctx.SCENARIOS.get())
    if body.astronaut_id is None:
        items = {}
    elif body.scenario is None:
        items.pop(body.astronaut_id, None)
    else:
        items[body.astronaut_id] = (body.scenario, time.time())
    https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    if items:
        response.set_cookie(ctx.DEMO_COOKIE, ctx.dump_scenarios(items), max_age=ctx.SCENARIO_MAX_AGE_S,
                            httponly=True, secure=https, samesite="lax", path="/")
    else:
        response.delete_cookie(ctx.DEMO_COOKIE, path="/")
    ctx.SCENARIOS.set(items)
    return demo_state(items)
