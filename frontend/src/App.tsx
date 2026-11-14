import { useEffect, useMemo, useState } from 'react'
import ExerciseCoach from './ExerciseCoach'
import WellnessCheck from './WellnessCheck'
import ProfilePicker from './ProfilePicker'
import CrewCommand from './CrewCommand'
import SettingsPanel from './SettingsPanel'
import { profiles, type CrewProfile } from './profiles'
import { apiFetch } from './api'
import { levelInfo, type Baseline, type SignalBaseline, type Vitals } from './health'

type Sample = {
  astronaut_id: string; source: 'simulation' | 'hardware'; received_at: string; ecg_raw: number; leads_off: boolean;
  resp_raw: number | null; respiration_rate_bpm: number | null;
  heart_rate_bpm: number | null; ax: number | null; ay: number | null; az: number | null; gx: number | null; gy: number | null; gz: number | null;
  pos_x_m: number | null; pos_y_m: number | null; area_m2: number | null; steps: number | null; battery_pct: number | null;
}

const navIcons: Record<string, string> = { Dashboard: '⌁', Monitoring: '⌇', 'Crew Command': '▦', 'Exercise Coach': '◇', Wellness: '◌', 'Crew Profile': '◉', 'Health Analytics': '↗', Alerts: '△', 'Mission Control': '✦', Settings: '⚙', 'System Settings': '⚙' }

/** Gráfico de línea. `band` dibuja la franja "normal" de la línea base personal. */
function Line({ values, color = '#58e6c2', band }: { values: (number | null)[]; color?: string; band?: { low: number | null; high: number | null } }) {
  const view = useMemo(() => {
    const valid = values.filter((v): v is number => typeof v === 'number')
    if (!valid.length) return null
    const bandValues = band && band.low != null && band.high != null ? [band.low, band.high] : []
    const min = Math.min(...valid, ...bandValues), max = Math.max(...valid, ...bandValues)
    const pad = (max - min) * 0.08 || 1
    const lo = min - pad, span = max + pad - lo
    const y = (v: number) => 40 - ((v - lo) / span) * 36
    // Sin lectura (null) = hueco en la línea, para no inventar un tramo.
    let path = '', pen = false
    values.forEach((v, i) => {
      if (v == null) { pen = false; return }
      path += `${pen ? 'L' : 'M'}${(i / Math.max(1, values.length - 1)) * 100},${y(v)} `; pen = true
    })
    const points = path
    const rect = bandValues.length ? { y: y(bandValues[1]), h: y(bandValues[0]) - y(bandValues[1]) } : null
    return { points, rect }
  }, [values, band?.low, band?.high])
  return <svg className="spark" viewBox="0 0 100 42" preserveAspectRatio="none" aria-label="Gráfico en tiempo real">
    {view?.rect && <rect x="0" width="100" y={view.rect.y} height={view.rect.h} fill={color} opacity="0.12" />}
    {view && <path d={view.points} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />}
  </svg>
}

function Metric({ label, value, unit, note, tone = 'mint', tag }: { label: string; value: string | number; unit?: string; note: string; tone?: string; tag?: string }) {
  return <article className={`metric ${tone}`}><div className="metric-top"><span>{label}</span>{tag ? <em className="metric-tag">{tag}</em> : <i />}</div><strong>{value}<small>{unit}</small></strong><p>{note}</p></article>
}

function signalNote(signal?: SignalBaseline) {
  if (!signal) return 'Calibrando línea base…'
  return signal.message
}

function timeLabel(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function App() {
  const [profile, setProfile] = useState<CrewProfile | null>(null)
  const [active, setActive] = useState('Dashboard')
  const [sample, setSample] = useState<Sample | null>(null)
  const [series, setSeries] = useState<Sample[]>([])
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [vitals, setVitals] = useState<Vitals | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!profile || profile.access === 'nasa') return
    let alive = true
    const astronautId = profile.id
    setBaseline(null)
    const refresh = async () => {
      try {
        const [stateRes, historyRes] = await Promise.all([apiFetch(`/api/state?astronaut_id=${astronautId}`), apiFetch(`/api/history?astronaut_id=${astronautId}&limit=90`)])
        if (!stateRes.ok || !historyRes.ok) throw new Error('API unavailable')
        const state = await stateRes.json(); const history = await historyRes.json()
        if (alive) { setSample(state); setSeries(history.items); setBaseline(history.baseline ?? null); setConnected(true) }
      } catch { if (alive) setConnected(false) }
    }
    refresh(); const timer = window.setInterval(refresh, 900)
    return () => { alive = false; window.clearInterval(timer) }
  }, [profile?.id, profile?.access])

  // Presión y temperatura cambian cada 30 min: basta consultar cada 20 s (y al volver de Wellness).
  useEffect(() => {
    if (!profile || profile.access === 'nasa') return
    let alive = true
    const load = async () => {
      try { const res = await apiFetch(`/api/vitals?astronaut_id=${profile.id}`); if (res.ok && alive) setVitals(await res.json()) } catch { /* sin cambios */ }
    }
    load(); const timer = window.setInterval(load, 20000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [profile?.id, profile?.access, active])

  const hrBase = baseline?.signals?.heart_rate_bpm
  const rrBase = baseline?.signals?.respiration_rate_bpm
  const hr = sample?.heart_rate_bpm ?? null
  const respirationRate = sample?.respiration_rate_bpm ?? null
  const ecg = series.map(s => s.ecg_raw)
  const respiration = series.map(s => s.resp_raw)
  const hrSeries = series.map(s => s.leads_off ? null : s.heart_rate_bpm)
  const rrSeries = series.map(s => s.leads_off ? null : s.respiration_rate_bpm)
  const hasImu = sample?.az != null
  const movement = series.map(s => s.ax == null || s.ay == null || s.az == null ? null : Math.sqrt(s.ax ** 2 + s.ay ** 2 + s.az ** 2))
  const overall = levelInfo(baseline?.level)
  const bp = vitals?.latest_bp, temp = vitals?.latest_temp
  const sourceTag = (source?: string) => source === 'manual' ? 'MANUAL' : 'SIMULADO'
  const issues = [hrBase, rrBase].filter(s => s && ['observe', 'alert', 'unreliable'].includes(s.level)) as SignalBaseline[]

  if (!profile) return <ProfilePicker profiles={profiles} onSelect={selected => { setProfile(selected); setActive(selected.access === 'nasa' ? 'System Settings' : 'Dashboard') }} />

  const crew = profiles.filter(item => item.access !== 'nasa')
  const nav = profile.access === 'nasa' ? ['System Settings'] : ['Dashboard', 'Monitoring', ...(profile.access === 'captain' ? ['Crew Command'] : []), 'Exercise Coach', 'Wellness', 'Crew Profile', 'Health Analytics', 'Alerts', 'Mission Control', 'Settings']

  return <div className="app-shell">
    <aside>
      <div className="brand"><div className="mark">S</div><div><b>STELLAR</b><span>HEALTH SYSTEM</span></div></div>
      <nav>{nav.map(item => <button className={active === item ? 'active' : ''} onClick={() => setActive(item)} key={item}><span>{navIcons[item]}</span>{item}</button>)}</nav>
      <div className="mission-card"><span>NASA SPACE APPS 2026</span><b>LONG-DURATION CREW 01</b><div><i /> Onboard systems nominal</div></div>
      <button className="switch-profile" onClick={() => setProfile(null)}>{profile.photo ? <img src={profile.photo} alt="" /> : <span>{profile.initials}</span>}<div><b>{profile.shortName}</b><small>Switch profile</small></div><i>↗</i></button>
      <p className="version">STELLAR LAB · Prototype v0.3 · No es un dispositivo médico</p>
    </aside>

    <main>
      <header><div><p>{profile.access === 'nasa' ? 'MISSION SYSTEMS' : 'CREW HEALTH'} / {active.toUpperCase()}</p><h1>{active}</h1></div><div className="header-actions"><span className={`access-badge access-${profile.access}`}>{profile.access === 'captain' ? 'COMMANDER ACCESS' : profile.access === 'nasa' ? 'NASA TECH' : 'PERSONAL VIEW'}</span><span className={`status ${connected ? '' : 'offline'}`}><i />{connected ? (sample?.source === 'hardware' ? 'ESP32 conectado' : 'Simulación local') : 'API desconectada'}</span><button aria-label="Notificaciones">⌁</button><button className="avatar" onClick={() => setProfile(null)} aria-label="Cambiar perfil">{profile.initials}</button></div></header>

      {active === 'Crew Command' && profile.access === 'captain' ? <CrewCommand crew={crew} /> : active === 'Exercise Coach' ? <ExerciseCoach sample={sample} /> : active === 'Wellness' ? <WellnessCheck astronautId={profile.id} /> : active === 'Settings' || active === 'System Settings' ? <SettingsPanel profile={profile} /> : active !== 'Dashboard' && active !== 'Monitoring' ? <section className="placeholder">
        <span>{navIcons[active]}</span><p>STELLAR HEALTH</p><h2>{active}</h2><div className="rule" />
        <p>Este módulo forma parte de la arquitectura prevista. En el siguiente ciclo conectaremos sus datos, reglas y flujos específicos.</p>
        <button onClick={() => setActive('Dashboard')}>Volver al Dashboard</button>
      </section> : <>
        <section className="challenge-strip"><span>RECOPILAR</span><i/> <span>EVALUAR</span><i/> <span>ACTUAR</span><p>Reto NASA Space Apps 2026 · Health Monitoring Software · Prototipo educativo, no es un dispositivo médico</p></section>
        <section className="intro"><div><span>{profile.name.toUpperCase()} · {profile.role.toUpperCase()} · MISSION DAY 042</span><h2>My health and movement</h2><p>Heart, respiration and movement compared with your personal baseline.</p></div><div className={`risk level-${baseline?.level ?? 'calibrating'}`}><i /> Estado actual <strong>{overall.label.toUpperCase()}</strong></div></section>

        <section className="metrics six">
          <Metric label="Frecuencia cardiaca" value={hr ?? '—'} unit=" bpm" note={signalNote(hrBase)} tone={levelInfo(hrBase?.level).tone} tag={levelInfo(hrBase?.level).short} />
          <Metric label="Frecuencia respiratoria" value={respirationRate?.toFixed(1) ?? '—'} unit=" rpm" note={signalNote(rrBase)} tone={levelInfo(rrBase?.level).tone} tag={levelInfo(rrBase?.level).short} />
          <Metric label="Presión arterial" value={bp ? `${bp.systolic_mmhg}/${bp.diastolic_mmhg ?? '—'}` : '—'} unit=" mmHg" note={bp ? `${bp.bp_label ?? ''} · ${sourceTag(bp.source).toLowerCase()} ${timeLabel(bp.ts)}` : 'Sin medición'} tone={bp?.bp_label === 'normal' ? 'mint' : 'amber'} tag={bp ? sourceTag(bp.source) : undefined} />
          <Metric label="Temperatura" value={temp?.temperature_c?.toFixed(1) ?? '—'} unit=" °C" note={temp ? `${temp.temp_label ?? ''} · ${sourceTag(temp.source).toLowerCase()} ${timeLabel(temp.ts)}` : 'Sin medición'} tone={temp?.temp_label === 'normal' ? 'cyan' : 'amber'} tag={temp ? sourceTag(temp.source) : undefined} />
          <Metric label="Señal ECG" value={sample?.leads_off ? 'OFF' : (sample?.ecg_raw ?? '—')} unit=" raw" note={sample?.leads_off ? 'Lectura poco confiable: revisa los electrodos' : 'Electrodos detectados'} tone={sample?.leads_off ? 'gray' : 'blue'} />
          <Metric label="Batería Node" value={sample?.battery_pct ?? '—'} unit={sample?.battery_pct == null ? '' : ' %'} note={sample?.battery_pct == null ? 'Sin sensor de batería' : sample.source === 'hardware' ? 'Reportada por el ESP32' : 'Simulada'} tone="violet" />
        </section>

        <section className="data-grid">
          <article className="panel trend-panel"><div className="panel-head"><div><span>PULSO · TU LÍNEA BASE</span><h3>Pulso vs. tu normal</h3></div><b className={`level-pill level-${hrBase?.level ?? 'calibrating'}`}>{levelInfo(hrBase?.level).label}</b></div><Line values={hrSeries} band={hrBase ?? undefined} color="#58e6c2" /><div className="chart-meta"><span>VENTANA · 90 s</span><span>{hrBase?.center != null ? `BASE ${hrBase.center} ± ${(2 * (hrBase.sd ?? 0)).toFixed(0)} lpm` : 'CALIBRANDO'}</span><span>{hrBase?.z != null ? `z = ${hrBase.z}` : '—'}</span></div></article>
          <article className="panel trend-panel"><div className="panel-head"><div><span>RESPIRACIÓN · TU LÍNEA BASE</span><h3>Respiración vs. tu normal</h3></div><b className={`level-pill level-${rrBase?.level ?? 'calibrating'}`}>{levelInfo(rrBase?.level).label}</b></div><Line values={rrSeries} band={rrBase ?? undefined} color="#56d9ef" /><div className="chart-meta"><span>VENTANA · 90 s</span><span>{rrBase?.center != null ? `BASE ${rrBase.center} ± ${(2 * (rrBase.sd ?? 0)).toFixed(1)} rpm` : 'CALIBRANDO'}</span><span>{rrBase?.z != null ? `z = ${rrBase.z}` : '—'}</span></div></article>
          <article className="panel ecg-panel"><div className="panel-head"><div><span>ECG / AD8232</span><h3>Actividad cardiaca</h3></div><b className="live"><i /> LIVE</b></div><Line values={ecg} /><div className="chart-meta"><span>VENTANA · 90 s</span><span>ADC · 12 bit</span><span>{sample?.leads_off ? 'ELECTRODOS SUELTOS' : 'SEÑAL ACTIVA'}</span></div></article>
          <article className="panel respiration-panel"><div className="panel-head"><div><span>RESPIRACIÓN · DERIVADA DEL ECG</span><h3>Ciclo de respiración</h3></div><b>{respirationRate?.toFixed(1) ?? '—'} rpm</b></div><Line values={respiration} color="#56d9ef" /><div className="chart-meta"><span>ESTIMADA DESDE EL ECG (EDR)</span><span>{sample?.source === 'hardware' ? 'ESP32' : 'SIMULACIÓN'}</span><span>{levelInfo(rrBase?.level).label.toUpperCase()}</span></div></article>
          <article className="panel footprint"><div className="panel-head"><div><span>IMU / MPU6050</span><h3>Zona de movimiento</h3></div><b>{sample?.area_m2?.toFixed(2) ?? '0.00'} m²</b></div><div className="map"><div className="orbit one"/><div className="orbit two"/><div className="trail"/><div className="dot" style={{left: `${50 + Math.min(38, Math.max(-38, (sample?.pos_x_m ?? 0) * 15))}%`, top: `${50 + Math.min(35, Math.max(-35, (sample?.pos_y_m ?? 0) * 18))}%`}}><i/></div><span className="axis x">X</span><span className="axis y">Y</span></div><p>Estimación 2D con corrección de reposo. La deriva del IMU se reinicia desde Arduino IDE.</p></article>
          <article className="panel motion"><div className="panel-head"><div><span>MOVIMIENTO</span><h3>Aceleración del pie</h3></div><b>{hasImu && sample ? Math.sqrt((sample.ax ?? 0) ** 2 + (sample.ay ?? 0) ** 2 + (sample.az ?? 0) ** 2).toFixed(2) : '—'} m/s²</b></div><Line values={movement} color="#ffb55c" /><div className="vectors"><span>AX <b>{sample?.ax?.toFixed(2) ?? '—'}</b></span><span>AY <b>{sample?.ay?.toFixed(2) ?? '—'}</b></span><span>AZ <b>{sample?.az?.toFixed(2) ?? '—'}</b></span></div></article>
          <article className={`panel insight level-${baseline?.level ?? 'calibrating'}`}><span>STELLAR AI · EVALUAR Y ACTUAR</span><h3>{overall.title}</h3>
            {issues.length ? <ul className="insight-reasons">{issues.map(s => <li key={s.label}>{s.message}</li>)}</ul> : <p>{baseline?.level === 'calibrating' ? 'Reuniendo tus primeras lecturas para conocer tu normal. Tarda menos de un minuto.' : 'Tus señales están dentro de tu propia línea base (no de un promedio general).'}</p>}
            <p className="insight-method">Cómo se calcula: {baseline?.method ?? 'mediana de tus últimos 10 min ± 2 desviaciones'}.</p>
            <button onClick={() => setActive(issues.length ? 'Wellness' : 'Exercise Coach')}>{issues.length ? 'Registrar cómo me siento' : 'Abrir rutina recomendada'}</button><div><i /> Revisión automática en curso</div></article>
        </section>
      </>}
    </main>
  </div>
}
