import { useEffect, useMemo, useState } from 'react'
import ExerciseCoach from './ExerciseCoach'
import WellnessCheck from './WellnessCheck'
import ProfilePicker from './ProfilePicker'
import CrewCommand from './CrewCommand'
import SettingsPanel from './SettingsPanel'
import { profiles, type CrewProfile } from './profiles'
import { apiFetch } from './api'
import { levelInfo, type Alert, type Baseline, type SignalBaseline, type Vitals } from './health'
import Icon, { type IconName } from './Icon'
import Alerts from './Alerts'
import MissionControl from './MissionControl'

type Sample = {
  astronaut_id: string; source: 'simulation' | 'hardware'; received_at: string; ecg_raw: number; leads_off: boolean;
  resp_raw: number | null; respiration_rate_bpm: number | null;
  heart_rate_bpm: number | null; ax: number | null; ay: number | null; az: number | null; gx: number | null; gy: number | null; gz: number | null;
  pos_x_m: number | null; pos_y_m: number | null; area_m2: number | null; steps: number | null; battery_pct: number | null;
}

// Pantallas: la clave interna sigue en inglés; el texto visible sigue el diseño de Choy (español).
const SCREENS: Record<string, { label: string; icon: IconName; subtitle: string }> = {
  Dashboard: { label: 'Panel principal', icon: 'inicio', subtitle: 'Tu salud frente a tu propia línea base' },
  Monitoring: { label: 'Monitorización', icon: 'monitorizacion', subtitle: 'Tus signos vitales en tiempo real' },
  Wellness: { label: 'Bienestar', icon: 'bienestar', subtitle: 'Tu equilibrio en la misión: chequeo diario y recuperación' },
  'Exercise Coach': { label: 'Entrenamiento', icon: 'entrenamiento', subtitle: 'Rutinas guiadas contra la pérdida de músculo y hueso' },
  'Crew Profile': { label: 'Mi perfil', icon: 'perfil', subtitle: 'Datos del tripulante' },
  'Health Analytics': { label: 'Análisis de salud', icon: 'analisis', subtitle: 'Tendencias a largo plazo' },
  Alerts: { label: 'Alertas', icon: 'alertas', subtitle: 'Qué cambió, por qué y qué hacer' },
  Settings: { label: 'Configuración', icon: 'configuracion', subtitle: 'Preferencias del perfil' },
  'Crew Command': { label: 'Gestión de tripulación', icon: 'tripulacion', subtitle: 'Estado de toda la tripulación (solo lectura)' },
  'Mission Control': { label: 'Control de misión', icon: 'control-mision', subtitle: 'Reportes automáticos para los médicos en Tierra' },
  'System Settings': { label: 'Configuración del sistema', icon: 'chip', subtitle: 'Parámetros técnicos' },
}
const screen = (key: string) => SCREENS[key] ?? { label: key, icon: 'destello-ia' as IconName, subtitle: '' }

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

function Metric({ label, value, unit, note, tone = 'mint', tag, icon }: { label: string; value: string | number; unit?: string; note: string; tone?: string; tag?: string; icon?: IconName }) {
  return <article className={`metric ${tone}`}><div className="metric-top"><span>{icon && <Icon name={icon} size={18} />}{label}</span>{tag ? <em className="metric-tag">{tag}</em> : <i />}</div><strong>{value}<small>{unit}</small></strong><p>{note}</p></article>
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
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => { const t = window.setInterval(() => setClock(new Date()), 1000); return () => window.clearInterval(t) }, [])

  // Alertas: cada 5 s (combinan línea base, vitales y chequeo diario).
  useEffect(() => {
    if (!profile || profile.access === 'nasa') { setAlerts([]); return }
    let alive = true
    const load = async () => {
      try { const res = await apiFetch(`/api/alerts?astronaut_id=${profile.id}`); if (res.ok && alive) setAlerts((await res.json()).items) } catch { /* sin cambios */ }
    }
    load(); const timer = window.setInterval(load, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [profile?.id, profile?.access, active])

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

  if (!profile) return <ProfilePicker profiles={profiles} onSelect={selected => { setProfile(selected); setActive(selected.access === 'nasa' ? 'Mission Control' : 'Dashboard') }} />

  const crew = profiles.filter(item => item.access !== 'nasa')
  const nav = profile.access === 'nasa' ? [] : ['Dashboard', 'Monitoring', 'Wellness', 'Exercise Coach', 'Crew Profile', 'Health Analytics', 'Alerts', 'Settings']
  const authorized = profile.access === 'nasa' ? ['Mission Control', 'System Settings'] : profile.access === 'captain' ? ['Crew Command', 'Mission Control'] : []
  const activeAlerts = alerts.filter(a => a.level >= 1)
  const maxLevel = Math.max(0, ...alerts.map(a => a.level))
  const lastSync = sample ? Math.max(0, Math.round((clock.getTime() - Date.parse(sample.received_at)) / 1000)) : null
  const navButton = (item: string) => <button className={active === item ? 'active' : ''} onClick={() => setActive(item)} key={item}>
    <Icon name={screen(item).icon} size={20} />{screen(item).label}
    {item === 'Alerts' && activeAlerts.length > 0 && <span className={`nav-badge ${maxLevel >= 3 ? 'crit' : ''}`}>{activeAlerts.length}</span>}
  </button>
  const topAlert = activeAlerts[0]

  return <div className="app-shell">
    <aside>
      <div className="brand"><img src="/brand/logo-cian.svg" alt="" /><b>STELLAR<em>Health</em></b></div>
      <nav>{nav.map(navButton)}</nav>
      {authorized.length > 0 && <><p className="nav-section">PERSONAL AUTORIZADO</p><nav>{authorized.map(navButton)}</nav></>}
      <div className="sync-card"><div><b className={connected ? '' : 'off'}><i />{connected ? (sample?.source === 'hardware' ? 'ESP32 conectado' : 'Conectado · simulación') : profile.access === 'nasa' ? 'Estación de Tierra' : 'Sin conexión'}</b>{lastSync != null && <span>Última lectura: hace {lastSync} s</span>}</div><Icon name="senal" size={22} /></div>
      <p className="version">STELLAR LAB · v0.4 · No es un dispositivo médico</p>
    </aside>

    <main>
      <div className="topbar">
        <div className="mission"><Icon name="cohete" size={26} /><div><b>Misión STELLAR-01</b><small>Tripulación de larga duración</small></div></div>
        <span className="divider" />
        <span className={`sys ${!connected && profile.access !== 'nasa' ? 'off' : sample?.source === 'hardware' ? '' : 'sim'}`}><i />{profile.access === 'nasa' ? 'Enlace con el hábitat' : !connected ? 'API desconectada' : sample?.source === 'hardware' ? 'Sistema en línea · ESP32' : 'Sistema en línea · simulación'}</span>
        <span className="divider" />
        <span className="clock"><Icon name="reloj" size={18} />{clock.toISOString().slice(11, 16)} UTC</span>
        <span className="spacer" />
        {profile.access !== 'nasa' && <button className="bell" aria-label="Alertas" onClick={() => setActive('Alerts')}><Icon name="alertas" size={18} />{activeAlerts.length > 0 && <em className={maxLevel >= 3 ? 'crit' : ''}>{activeAlerts.length}</em>}</button>}
        <button className="who" onClick={() => setProfile(null)} aria-label="Cambiar perfil">{profile.photo ? <img src={profile.photo} alt="" /> : <span className="ini">{profile.initials}</span>}<div><b>{profile.name}</b><small>{profile.role} · cambiar perfil</small></div><Icon name="chevron-abajo" size={14} /></button>
      </div>
      <div className="page-title"><Icon name={screen(active).icon} size={40} /><div><h1>{screen(active).label}</h1><p>{screen(active).subtitle}</p></div><span className={`access-badge access-${profile.access}`}>{profile.access === 'captain' ? 'ACCESO COMANDANTE' : profile.access === 'nasa' ? 'EQUIPO MÉDICO · TIERRA' : 'VISTA PERSONAL'}</span></div>

      {active === 'Crew Command' && profile.access === 'captain' ? <CrewCommand crew={crew} /> : active === 'Mission Control' && profile.access !== 'crew' ? <MissionControl crew={crew} /> : active === 'Alerts' ? <Alerts alerts={alerts} onOpen={setActive} /> : active === 'Exercise Coach' ? <ExerciseCoach sample={sample} /> : active === 'Wellness' ? <WellnessCheck astronautId={profile.id} /> : active === 'Settings' || active === 'System Settings' ? <SettingsPanel profile={profile} /> : active !== 'Dashboard' && active !== 'Monitoring' ? <section className="placeholder">
        <span><Icon name={screen(active).icon} size={34} /></span><p>STELLAR HEALTH</p><h2>{screen(active).label}</h2><div className="rule" />
        <p>Este módulo forma parte de la arquitectura prevista. En el siguiente ciclo conectaremos sus datos, reglas y flujos específicos.</p>
        <button onClick={() => setActive('Dashboard')}>Volver al panel principal</button>
      </section> : <>
        <section className="challenge-strip"><span>RECOPILAR</span><i/> <span>EVALUAR</span><i/> <span>ACTUAR</span><p>Reto NASA Space Apps 2026 · Health Monitoring Software · Prototipo educativo, no es un dispositivo médico</p></section>
        <section className="intro"><div><span>{profile.name.toUpperCase()} · {profile.role.toUpperCase()} · DÍA DE MISIÓN 042</span><h2>Hola, {profile.shortName}</h2><p>Pulso, respiración y movimiento comparados con tu propia línea base.</p></div><div className={`risk level-${maxLevel >= 3 ? 'alert' : maxLevel === 2 ? 'observe' : baseline?.level ?? 'calibrating'}`}><i /> Estado actual <strong>{maxLevel >= 3 ? 'CRÍTICO · NIVEL 3' : maxLevel === 2 ? 'ATENCIÓN · NIVEL 2' : overall.label.toUpperCase()}</strong></div></section>

        <section className="metrics six">
          <Metric icon="corazon" label="Frecuencia cardiaca" value={hr ?? '—'} unit=" bpm" note={signalNote(hrBase)} tone={levelInfo(hrBase?.level).tone} tag={levelInfo(hrBase?.level).short} />
          <Metric icon="pulmones" label="Frecuencia respiratoria" value={respirationRate?.toFixed(1) ?? '—'} unit=" rpm" note={signalNote(rrBase)} tone={levelInfo(rrBase?.level).tone} tag={levelInfo(rrBase?.level).short} />
          <Metric icon="gota" label="Presión arterial" value={bp ? `${bp.systolic_mmhg}/${bp.diastolic_mmhg ?? '—'}` : '—'} unit=" mmHg" note={bp ? `${bp.bp_label ?? ''} · ${sourceTag(bp.source).toLowerCase()} ${timeLabel(bp.ts)}` : 'Sin medición'} tone={bp?.bp_label === 'normal' ? 'mint' : 'amber'} tag={bp ? sourceTag(bp.source) : undefined} />
          <Metric icon="termometro" label="Temperatura" value={temp?.temperature_c?.toFixed(1) ?? '—'} unit=" °C" note={temp ? `${temp.temp_label ?? ''} · ${sourceTag(temp.source).toLowerCase()} ${timeLabel(temp.ts)}` : 'Sin medición'} tone={temp?.temp_label === 'normal' ? 'cyan' : 'amber'} tag={temp ? sourceTag(temp.source) : undefined} />
          <Metric icon="senal" label="Señal ECG" value={sample?.leads_off ? 'OFF' : (sample?.ecg_raw ?? '—')} unit=" raw" note={sample?.leads_off ? 'Lectura poco confiable: revisa los electrodos' : 'Electrodos detectados'} tone={sample?.leads_off ? 'gray' : 'blue'} />
          <Metric icon="chip" label="Batería Node" value={sample?.battery_pct ?? '—'} unit={sample?.battery_pct == null ? '' : ' %'} note={sample?.battery_pct == null ? 'Sin sensor de batería' : sample.source === 'hardware' ? 'Reportada por el ESP32' : 'Simulada'} tone="violet" />
        </section>

        <section className="data-grid">
          <article className="panel trend-panel"><div className="panel-head"><div><span>PULSO · TU LÍNEA BASE</span><h3>Pulso vs. tu normal</h3></div><b className={`level-pill level-${hrBase?.level ?? 'calibrating'}`}>{levelInfo(hrBase?.level).label}</b></div><Line values={hrSeries} band={hrBase ?? undefined} color="#58e6c2" /><div className="chart-meta"><span>VENTANA · 90 s</span><span>{hrBase?.center != null ? `BASE ${hrBase.center} ± ${(2 * (hrBase.sd ?? 0)).toFixed(0)} lpm` : 'CALIBRANDO'}</span><span>{hrBase?.z != null ? `z = ${hrBase.z}` : '—'}</span></div></article>
          <article className="panel trend-panel"><div className="panel-head"><div><span>RESPIRACIÓN · TU LÍNEA BASE</span><h3>Respiración vs. tu normal</h3></div><b className={`level-pill level-${rrBase?.level ?? 'calibrating'}`}>{levelInfo(rrBase?.level).label}</b></div><Line values={rrSeries} band={rrBase ?? undefined} color="#56d9ef" /><div className="chart-meta"><span>VENTANA · 90 s</span><span>{rrBase?.center != null ? `BASE ${rrBase.center} ± ${(2 * (rrBase.sd ?? 0)).toFixed(1)} rpm` : 'CALIBRANDO'}</span><span>{rrBase?.z != null ? `z = ${rrBase.z}` : '—'}</span></div></article>
          <article className="panel ecg-panel"><div className="panel-head"><div><span>ECG / AD8232</span><h3>Actividad cardiaca</h3></div><b className="live"><i /> LIVE</b></div><Line values={ecg} /><div className="chart-meta"><span>VENTANA · 90 s</span><span>ADC · 12 bit</span><span>{sample?.leads_off ? 'ELECTRODOS SUELTOS' : 'SEÑAL ACTIVA'}</span></div></article>
          <article className="panel respiration-panel"><div className="panel-head"><div><span>RESPIRACIÓN · DERIVADA DEL ECG</span><h3>Ciclo de respiración</h3></div><b>{respirationRate?.toFixed(1) ?? '—'} rpm</b></div><Line values={respiration} color="#56d9ef" /><div className="chart-meta"><span>ESTIMADA DESDE EL ECG (EDR)</span><span>{sample?.source === 'hardware' ? 'ESP32' : 'SIMULACIÓN'}</span><span>{levelInfo(rrBase?.level).label.toUpperCase()}</span></div></article>
          <article className="panel footprint"><div className="panel-head"><div><span>IMU / MPU6050</span><h3>Zona de movimiento</h3></div><b>{sample?.area_m2?.toFixed(2) ?? '0.00'} m²</b></div><div className="map"><div className="orbit one"/><div className="orbit two"/><div className="trail"/><div className="dot" style={{left: `${50 + Math.min(38, Math.max(-38, (sample?.pos_x_m ?? 0) * 15))}%`, top: `${50 + Math.min(35, Math.max(-35, (sample?.pos_y_m ?? 0) * 18))}%`}}><i/></div><span className="axis x">X</span><span className="axis y">Y</span></div><p>Estimación 2D con corrección de reposo. La deriva del IMU se reinicia desde Arduino IDE.</p></article>
          <article className="panel motion"><div className="panel-head"><div><span>MOVIMIENTO</span><h3>Aceleración del pie</h3></div><b>{hasImu && sample ? Math.sqrt((sample.ax ?? 0) ** 2 + (sample.ay ?? 0) ** 2 + (sample.az ?? 0) ** 2).toFixed(2) : '—'} m/s²</b></div><Line values={movement} color="#ffb55c" /><div className="vectors"><span>AX <b>{sample?.ax?.toFixed(2) ?? '—'}</b></span><span>AY <b>{sample?.ay?.toFixed(2) ?? '—'}</b></span><span>AZ <b>{sample?.az?.toFixed(2) ?? '—'}</b></span></div></article>
          <article className={`panel insight level-${topAlert ? (topAlert.level >= 3 ? 'alert' : topAlert.level === 2 ? 'observe' : baseline?.level ?? 'normal') : baseline?.level ?? 'calibrating'}`}><span>STELLAR AI · EVALUAR Y ACTUAR</span>
            <h3>{topAlert ? `${topAlert.level_title}: ${topAlert.title}` : overall.title}</h3>
            {topAlert ? <><p>{topAlert.reason}</p><p><b>Qué hacer:</b> {topAlert.actions[0]}</p></>
              : issues.length ? <ul className="insight-reasons">{issues.map(s => <li key={s.label}>{s.message}</li>)}</ul>
              : <p>{baseline?.level === 'calibrating' ? 'Reuniendo tus primeras lecturas para conocer tu normal. Tarda menos de un minuto.' : 'Tus señales están dentro de tu propia línea base (no de un promedio general).'}</p>}
            <p className="insight-method">Cómo se calcula: {baseline?.method ?? 'mediana de tus últimos 10 min ± 2 desviaciones'}.</p>
            <button onClick={() => setActive(activeAlerts.length ? 'Alerts' : 'Exercise Coach')}>{activeAlerts.length ? `Ver ${activeAlerts.length} alerta${activeAlerts.length > 1 ? 's' : ''} y qué hacer` : 'Abrir rutina recomendada'}</button><div><i /> Revisión automática cada 5 s</div></article>
        </section>
      </>}
    </main>
  </div>
}
