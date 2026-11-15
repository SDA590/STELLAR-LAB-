"""Motor de alertas de STELLAR (punto 3) y reporte para los médicos en Tierra (punto 4).

Reglas simples y explicables (sin IA que decida). Cada alerta dice:
  * QUÉ cambió y POR QUÉ se dispara (con los números),
  * QUÉ HACER (pasos concretos),
  * QUIÉN actúa, según el nivel:
      Nivel 1 · Lo resuelves tú (descanso, hidratación, respiración, ejercicio).
      Nivel 2 · Avisa al oficial médico de la tripulación.
      Nivel 3 · Consulta con los médicos en Tierra (se incluye en el reporte prioritario).
  * qué peligro del vuelo espacial de NASA está relacionado.

Los rangos de presión, temperatura y glucosa son referencias generales.
Prototipo educativo: NO es un dispositivo médico ni da diagnósticos.
"""

from __future__ import annotations

import json
import time

from .analysis import duration_text

WHO = {1: "Tú mismo", 2: "Oficial médico de la tripulación", 3: "Médicos en Tierra"}
LEVEL_TITLE = {
    0: "Recordatorio",
    1: "Nivel 1 · Lo resuelves tú",
    2: "Nivel 2 · Avisa al oficial médico",
    3: "Nivel 3 · Consulta con Tierra",
}
HAZARDS = {
    "gravity": "Campos de gravedad: el corazón y la circulación se adaptan a la microgravedad",
    "closed": "Ambiente cerrado y hostil: CO₂, microbios y calidad del aire de la cabina",
    "isolation": "Aislamiento y confinamiento: sueño, ánimo y carga de trabajo",
    "distance": "Distancia a la Tierra: la ayuda médica tarda en llegar",
    "radiation": "Radiación espacial",
}


def _alert(id_: str, level: int, title: str, reason: str, actions: list[str], hazard: str,
           link: str | None = None, evidence: list[str] | None = None) -> dict:
    return {
        "id": id_, "level": level, "level_title": LEVEL_TITLE[level], "who": WHO.get(level, "Tú mismo"),
        "title": title, "reason": reason, "actions": actions, "hazard": HAZARDS[hazard],
        "link": link, "evidence": evidence or [],
    }


def _hours_since(iso: str | None, now: float) -> float:
    from .supabase_store import parse_ts
    if not iso:
        return 1e9
    try:
        return (now - parse_ts(iso)) / 3600
    except (TypeError, ValueError):
        return 1e9


def evaluate(base: dict, sample: dict, vitals: dict, checkins: list[dict], now: float | None = None) -> list[dict]:
    """Devuelve las alertas activas, de la más grave a la más leve."""
    now = now or time.time()
    out: list[dict] = []
    hr = base.get("signals", {}).get("heart_rate_bpm", {}) or {}
    rr = base.get("signals", {}).get("respiration_rate_bpm", {}) or {}
    hr_up = hr.get("level") in ("observe", "alert") and (hr.get("delta") or 0) > 0
    rr_up = rr.get("level") in ("observe", "alert") and (rr.get("delta") or 0) > 0

    # --- Calidad de señal -------------------------------------------------
    if sample.get("leads_off") or base.get("level") == "unreliable":
        out.append(_alert("signal", 1, "Lectura poco confiable",
                          "El ECG indica electrodos sueltos: el pulso y la respiración de este momento no son fiables.",
                          ["Revisa que los 3 electrodos estén bien pegados.", "Quédate quieto 30 s y vuelve a mirar el panel."],
                          "closed", None, ["leads_off = verdadero"]))

    # --- Pulso y respiración frente a la línea base ------------------------
    if hr_up and rr_up and "alert" in (hr.get("level"), rr.get("level")):
        out.append(_alert("hr-rr", 2, "Pulso y respiración elevados a la vez",
                          f"{hr['message']} {rr['message']} Que suban juntos sin ejercicio puede indicar esfuerzo, estrés o mala calidad del aire.",
                          ["Detén la actividad y siéntate.", "Revisa el CO₂ de la cabina en el panel de soporte vital.",
                           "Avisa al oficial médico si no baja en 10 min."], "closed", "Wellness",
                          [f"z pulso = {hr.get('z')}", f"z respiración = {rr.get('z')}"]))
    else:
        for sig, key, hazard in ((hr, "hr", "gravity"), (rr, "rr", "closed")):
            if sig.get("level") not in ("observe", "alert"):
                continue
            up = (sig.get("delta") or 0) > 0
            serious = sig["level"] == "alert" and (sig.get("duration_s") or 0) >= 60
            level = 2 if serious else 1
            name = sig["label"].lower()
            actions = (["Haz una pausa de 5 min sentado.", "Respira lento (ejercicio 4·6 en Bienestar).", "Bebe agua y vuelve a mirar en 10 min."]
                       if up else ["Comprueba que el sensor esté bien colocado.", "Levántate despacio y observa si hay mareo."])
            if level == 2:
                actions.append("Si sigue igual, avisa al oficial médico.")
            out.append(_alert(key, level, f"{sig['label']} {'por encima' if up else 'por debajo'} de tu base", sig["message"],
                              actions, hazard, "Wellness", [f"z = {sig.get('z')}", f"base {sig.get('center')} {sig.get('unit')}",
                                                            f"fuera de rango {duration_text(sig.get('duration_s') or 0)}"]))

    # --- Temperatura y presión (medición automática simulada o manual) -----
    temp = (vitals.get("latest_temp") or {}).get("temperature_c")
    if temp is not None:
        if temp >= 38 and hr_up:
            out.append(_alert("fever-hr", 3, "Fiebre con pulso elevado",
                              f"Temperatura {temp} °C y {hr['message'].lower()} Juntas pueden indicar una infección.",
                              ["Descansa y aíslate de la tripulación por precaución.", "Avisa al oficial médico ahora.",
                               "Se envía un reporte prioritario a los médicos en Tierra."], "distance", "Wellness",
                              [f"temperatura {temp} °C", f"z pulso = {hr.get('z')}"]))
        elif temp >= 38:
            out.append(_alert("fever", 2, "Fiebre", f"Temperatura {temp} °C (referencia: fiebre desde 38 °C).",
                              ["Descansa e hidrátate.", "Avisa al oficial médico.", "Vuelve a medir en 1 hora."], "closed", "Wellness",
                              [f"temperatura {temp} °C"]))
        elif temp >= 37.3:
            out.append(_alert("temp", 1, "Temperatura algo elevada", f"Temperatura {temp} °C (normal 36–37,2 °C).",
                              ["Hidrátate y evita el ejercicio intenso.", "Vuelve a medir en 1 hora."], "closed", "Wellness",
                              [f"temperatura {temp} °C"]))

    bp = vitals.get("latest_bp") or {}
    sys_, dia = bp.get("systolic_mmhg"), bp.get("diastolic_mmhg")
    if sys_ is not None and dia is not None:
        reading = f"{sys_:.0f}/{dia:.0f} mmHg"
        if sys_ >= 180 or dia >= 120:
            out.append(_alert("bp-crisis", 3, "Presión muy alta", f"Presión {reading} (muy alta: ≥ 180/120).",
                              ["Siéntate y repite la medición en 5 min.", "Avisa al oficial médico ahora.",
                               "Se envía un reporte prioritario a Tierra."], "gravity", None, [reading]))
        elif sys_ >= 140 or dia >= 90:
            out.append(_alert("bp-high", 2, "Presión alta", f"Presión {reading} (alta: ≥ 140/90).",
                              ["Descansa 10 min y vuelve a medir.", "Reduce la sal y la cafeína hoy.", "Avisa al oficial médico si se repite."],
                              "gravity", "Wellness", [reading]))
        elif sys_ < 90 or dia < 60:
            level = 2 if hr_up else 1
            out.append(_alert("bp-low", level, "Presión baja" + (" con pulso elevado" if hr_up else ""),
                              f"Presión {reading} (baja: < 90/60)." + (" Con el pulso alto puede indicar deshidratación." if hr_up else ""),
                              ["Bebe agua o una solución con sales.", "Levántate despacio.", "Vuelve a medir en 30 min."],
                              "gravity", "Wellness", [reading]))
        elif sys_ >= 130 or dia >= 80:
            out.append(_alert("bp-elev", 1, "Presión elevada", f"Presión {reading} (elevada: ≥ 130/80).",
                              ["Haz 5 min de respiración lenta.", "Vuelve a medir más tarde."], "gravity", "Wellness", [reading]))

    # --- Chequeo diario (manual) -----------------------------------------
    today = [c for c in checkins if _hours_since(c.get("created_at"), now) <= 24]
    last = today[0] if today else None
    glucose = next((c["glucose_mg_dl"] for c in today if c.get("glucose_mg_dl") is not None), None)
    if glucose is not None:
        if glucose < 54 or glucose > 250:
            out.append(_alert("glucose-crit", 3, "Glucosa fuera de rango seguro", f"Glucosa {glucose:.0f} mg/dL (referencia segura 54–250).",
                              ["Si es baja: toma 15 g de azúcar rápida y vuelve a medir en 15 min.", "Avisa al oficial médico ahora.",
                               "Se envía un reporte prioritario a Tierra."], "distance", "Wellness", [f"glucosa {glucose:.0f} mg/dL"]))
        elif glucose < 70 or glucose > 180:
            out.append(_alert("glucose", 2, "Glucosa " + ("baja" if glucose < 70 else "alta"), f"Glucosa {glucose:.0f} mg/dL (referencia 70–140).",
                              ["Si es baja: come algo con azúcar y vuelve a medir.", "Si es alta: revisa cuándo comiste y vuelve a medir en 2 h.",
                               "Avisa al oficial médico."], "distance", "Wellness", [f"glucosa {glucose:.0f} mg/dL"]))
        elif glucose > 140:
            out.append(_alert("glucose-elev", 1, "Glucosa algo alta", f"Glucosa {glucose:.0f} mg/dL (referencia 70–140).",
                              ["Anota cuándo comiste.", "Vuelve a medir antes de la próxima comida."], "distance", "Wellness"))

    if last:
        sleep, mood, stress = last.get("sleep_hours"), last.get("mood"), last.get("stress")
        low_sleep = sleep is not None and sleep < 6
        low_mood = (mood is not None and mood <= 2) or (stress is not None and stress >= 4)
        if low_sleep and low_mood:
            out.append(_alert("isolation", 2, "Poco sueño y ánimo bajo",
                              f"Dormiste {sleep} h y registraste ánimo {mood}/5, tensión {stress}/5. Juntos son una señal típica del aislamiento.",
                              ["Habla con el oficial médico o con un compañero de confianza.", "Programa una pausa sin pantallas antes de dormir.",
                               "Haz la respiración guiada 4·6."], "isolation", "Wellness", [f"sueño {sleep} h", f"ánimo {mood}/5", f"tensión {stress}/5"]))
        elif low_sleep and hr_up:
            out.append(_alert("fatigue", 1, "Fatiga probable", f"Dormiste {sleep} h y {hr['message'].lower()}",
                              ["Evita el ejercicio intenso hoy.", "Toma una siesta corta (20 min) si la agenda lo permite."], "isolation", "Exercise Coach",
                              [f"sueño {sleep} h", f"z pulso = {hr.get('z')}"]))
        elif low_sleep:
            out.append(_alert("sleep", 1, "Poco sueño", f"Dormiste {sleep} h (lo recomendado es 7–9 h).",
                              ["Reduce la luz y las pantallas antes de dormir.", "Mantén el mismo horario de sueño."], "isolation", "Wellness"))
        elif low_mood:
            out.append(_alert("mood", 1, "Ánimo bajo o tensión alta", f"Registraste ánimo {mood}/5 y tensión {stress}/5.",
                              ["Haz la respiración guiada 4·6.", "Comparte cómo te sientes con la tripulación."], "isolation", "Wellness"))
    else:
        out.append({**_alert("checkin", 1, "Falta tu chequeo diario", "Hoy no registraste sueño, ánimo ni glucosa.",
                             ["Completa el chequeo diario en Bienestar (1 minuto)."], "isolation", "Wellness"), "level": 0,
                    "level_title": LEVEL_TITLE[0], "who": "Tú mismo"})

    out.sort(key=lambda a: -a["level"])
    return out


# --------------------------------------------------------------------------- #
# Reporte para los médicos en Tierra
# --------------------------------------------------------------------------- #
REPORT_EVERY_S = 6 * 3600


def build_report(astronaut_id: str, base: dict, sample: dict, vitals: dict, checkins: list[dict],
                 alerts: list[dict], raw_samples: list[dict], now: float | None = None) -> dict:
    now = now or time.time()
    max_level = max((a["level"] for a in alerts), default=0)
    if max_level >= 2:
        trigger, generated = f"Automático por alerta de nivel {max_level}", now
    else:
        trigger, generated = "Programado (cada 6 h)", (now // REPORT_EVERY_S) * REPORT_EVERY_S
    signals = base.get("signals", {})
    last_checkin = next(iter(checkins), None)
    report = {
        "astronaut_id": astronaut_id,
        "generated_ts": generated,
        "trigger": trigger,
        "priority": "Prioritario" if max_level >= 3 else "Atención" if max_level == 2 else "Rutina",
        "max_level": max_level,
        "data_source": {"ecg": sample.get("source"), "vitals": (vitals.get("latest_bp") or {}).get("source"),
                        "checkin": "manual" if last_checkin else None},
        "summary": {
            key: {"base": s.get("center"), "now": s.get("current") if s.get("current") is not None else sample.get(key),
                  "level": s.get("level"), "z": s.get("z")}
            for key, s in signals.items()
        },
        "vitals": {"bp": vitals.get("latest_bp"), "temp": vitals.get("latest_temp")},
        "checkin": last_checkin,
        "alerts": [{"level": a["level"], "title": a["title"], "reason": a["reason"]} for a in alerts if a["level"] >= 1],
        "recommendation": alerts[0]["actions"][0] if alerts and alerts[0]["level"] >= 1 else "Sin cambios relevantes: mantener rutina.",
    }
    # Con conectividad limitada se envía el resumen, no todos los datos crudos.
    report["size_bytes"] = len(json.dumps(report, ensure_ascii=False).encode())
    report["raw_bytes"] = len(json.dumps(raw_samples).encode())
    return report
