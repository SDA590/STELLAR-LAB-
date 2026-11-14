import { useEffect, useState } from 'react'
import Icon from './Icon'
import { apiFetch } from './api'
import { levelInfo, type Report } from './health'
import type { CrewProfile } from './profiles'

// Retraso de la señal (solo ida) según dónde esté la tripulación.
const ENVIRONMENTS = [
  { id: 'iss', label: 'Órbita terrestre (estación)', delay_s: 1 },
  { id: 'moon', label: 'Base en la Luna', delay_s: 1.3 },
  { id: 'mars-near', label: 'Marte · distancia mínima', delay_s: 3 * 60 },
  { id: 'mars-avg', label: 'Marte · distancia media', delay_s: 12.5 * 60 },
  { id: 'mars-far', label: 'Marte · distancia máxima', delay_s: 22 * 60 },
]

const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16) + ' UTC'
const delayText = (s: number) => s < 60 ? `${s.toLocaleString('es')} s` : `${Math.round(s / 60)} min`
const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`

function reportText(r: Report, who: CrewProfile | undefined, env: typeof ENVIRONMENTS[number]) {
  const hr = r.summary.heart_rate_bpm, rr = r.summary.respiration_rate_bpm
  const lines = [
    'STELLAR HEALTH · REPORTE PARA MÉDICOS EN TIERRA',
    `Tripulante: ${who?.name ?? r.astronaut_id} (${who?.role ?? ''})`,
    `Generado: ${new Date(r.generated_ts * 1000).toISOString()} · ${r.trigger} · Prioridad: ${r.priority}`,
    `Entorno: ${env.label} · retraso de señal ${delayText(env.delay_s)}`,
    '',
    `Pulso: ${hr?.now ?? '—'} lpm (base ${hr?.base ?? '—'}, z ${hr?.z ?? '—'})`,
    `Respiración: ${rr?.now ?? '—'} rpm (base ${rr?.base ?? '—'}, z ${rr?.z ?? '—'})`,
    `Presión: ${r.vitals.bp ? `${r.vitals.bp.systolic_mmhg}/${r.vitals.bp.diastolic_mmhg} mmHg (${r.vitals.bp.source})` : '—'}`,
    `Temperatura: ${r.vitals.temp ? `${r.vitals.temp.temperature_c} °C (${r.vitals.temp.source})` : '—'}`,
    `Chequeo: ${r.checkin ? `sueño ${r.checkin.sleep_hours ?? '—'} h, ánimo ${r.checkin.mood ?? '—'}/5, tensión ${r.checkin.stress ?? '—'}/5, glucosa ${r.checkin.glucose_mg_dl ?? '—'} mg/dL` : 'sin chequeo en 24 h'}`,
    '',
    'Alertas:',
    ...(r.alerts.length ? r.alerts.map(a => `  - Nivel ${a.level}: ${a.title}. ${a.reason}`) : ['  - Ninguna']),
    '',
    `Recomendación a bordo: ${r.recommendation}`,
    `Fuentes: ECG ${r.data_source.ecg ?? '—'} · vitales ${r.data_source.vitals ?? '—'} · chequeo ${r.data_source.checkin ?? '—'}`,
    '',
    'Prototipo educativo (NASA Space Apps 2026). No es un dispositivo médico. Datos compartidos con consentimiento del tripulante.',
  ]
  return lines.join('\n')
}

export default function MissionControl({ crew }: { crew: CrewProfile[] }) {
  const [reports, setReports] = useState<Report[]>([])
  const [selected, setSelected] = useState(crew[0]?.id)
  const [envId, setEnvId] = useState('mars-avg')
  const [offline, setOffline] = useState(false)
  const env = ENVIRONMENTS.find(e => e.id === envId) ?? ENVIRONMENTS[0]

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await apiFetch('/api/mission-report')
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json(); if (alive) { setReports(data.items); setOffline(false) }
      } catch { if (alive) setOffline(true) }
    }
    load(); const timer = window.setInterval(load, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  const byId = Object.fromEntries(reports.map(r => [r.astronaut_id, r]))
  const report = selected ? byId[selected] : undefined
  const who = crew.find(c => c.id === selected)
  const hr = report?.summary.heart_rate_bpm, rr = report?.summary.respiration_rate_bpm

  const download = () => {
    if (!report) return
    const blob = new Blob([reportText(report, who, env)], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `reporte-${report.astronaut_id}-${new Date(report.generated_ts * 1000).toISOString().slice(0, 16).replace(':', '')}.txt`
    a.click(); URL.revokeObjectURL(a.href)
  }

  return <section className="mc-page">
    <div className="mc-bar">
      <Icon name="control-mision" size={22} className="accent" />
      <label>Ubicación de la tripulación
        <select value={envId} onChange={e => setEnvId(e.target.value)}>{ENVIRONMENTS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
      </label>
      <span className="delay">Retraso de la señal: <b>{delayText(env.delay_s)}</b> por trayecto{offline && ' · sin conexión con el hábitat'}</span>
    </div>

    <div className="mc-crew">{crew.map(c => {
      const r = byId[c.id]
      return <button key={c.id} className={selected === c.id ? 'sel' : ''} onClick={() => setSelected(c.id)}>
        {c.photo ? <img src={c.photo} alt="" /> : <span className="ini">{c.initials}</span>}
        <div><b>{c.name}</b><small>{r ? r.priority : 'Esperando reporte…'}</small><small>{r?.alerts[0]?.title ?? (r ? 'Sin alertas' : '')}</small></div>
        {r && <span className={`lv l${r.max_level}`}>{r.max_level || '✓'}</span>}
      </button>
    })}</div>

    {report && <article className="mc-report">
      <div className="mc-head">
        <Icon name="analisis" size={26} />
        <div><h2>Reporte de {who?.name ?? report.astronaut_id}</h2><p>{report.trigger} · generado {utc(report.generated_ts)} · llega a Tierra ≈ {utc(report.generated_ts + env.delay_s)}</p></div>
        <span className={`prio p${report.max_level}`}>{report.priority.toUpperCase()}</span>
      </div>

      <div className="mc-grid">
        <div><span>Pulso · ahora / base</span><b>{hr?.now ?? '—'} <small>/ {hr?.base ?? '—'} lpm</small></b><small>{levelInfo(hr?.level).label}{hr?.z != null && ` · z ${hr.z}`}</small></div>
        <div><span>Respiración · ahora / base</span><b>{rr?.now ?? '—'} <small>/ {rr?.base ?? '—'} rpm</small></b><small>{levelInfo(rr?.level).label}{rr?.z != null && ` · z ${rr.z}`}</small></div>
        <div><span>Presión arterial</span><b>{report.vitals.bp ? `${report.vitals.bp.systolic_mmhg}/${report.vitals.bp.diastolic_mmhg}` : '—'} <small>mmHg</small></b><small>{report.vitals.bp ? `${report.vitals.bp.bp_label} · ${report.vitals.bp.source === 'manual' ? 'manual' : 'simulada'}` : ''}</small></div>
        <div><span>Temperatura</span><b>{report.vitals.temp?.temperature_c ?? '—'} <small>°C</small></b><small>{report.vitals.temp ? `${report.vitals.temp.temp_label} · ${report.vitals.temp.source === 'manual' ? 'manual' : 'simulada'}` : ''}</small></div>
      </div>

      <div>
        <p className="mc-section-title">CHEQUEO DIARIO (MANUAL)</p>
        <p className="mc-list" style={{ paddingLeft: 0 }}>{report.checkin ? `Sueño ${report.checkin.sleep_hours ?? '—'} h · ánimo ${report.checkin.mood ?? '—'}/5 · tensión ${report.checkin.stress ?? '—'}/5 · glucosa ${report.checkin.glucose_mg_dl ?? '—'} mg/dL` : 'Sin chequeo en las últimas 24 h.'}</p>
      </div>

      <div>
        <p className="mc-section-title">ALERTAS Y MOTIVO</p>
        {report.alerts.length ? <ul className="mc-list">{report.alerts.map(a => <li key={a.title}><span className={`lv l${a.level}`} style={{ minWidth: 20, height: 20, fontSize: 11, marginRight: 8 }}>{a.level}</span><b>{a.title}.</b> {a.reason}</li>)}</ul> : <p className="mc-list" style={{ paddingLeft: 0 }}>Sin alertas: el tripulante está dentro de su línea base.</p>}
      </div>

      <div>
        <p className="mc-section-title">ACCIÓN YA INDICADA A BORDO</p>
        <p className="mc-list" style={{ paddingLeft: 0 }}>{report.recommendation}</p>
      </div>

      <div className="mc-tx">
        <span>Se envía un <b>resumen de {kb(report.size_bytes)}</b> en lugar de {kb(report.raw_bytes)} de datos crudos ({Math.max(1, Math.round(report.raw_bytes / report.size_bytes))}× menos), útil con conectividad limitada.</span>
        <span>Fuentes: ECG <b>{report.data_source.ecg === 'hardware' ? 'ESP32' : 'simulado'}</b> · vitales <b>{report.data_source.vitals === 'manual' ? 'manual' : report.data_source.vitals ? 'simulados' : '—'}</b> · chequeo <b>{report.data_source.checkin ?? '—'}</b></span>
        <button className="link-btn" onClick={download}>Descargar reporte (.txt)<Icon name="flecha-derecha" size={14} /></button>
      </div>
    </article>}

    <p className="disclaimer">Vista de solo lectura para el equipo médico. Los datos se comparten con consentimiento del tripulante. Prototipo educativo: no es un dispositivo médico.</p>
  </section>
}
