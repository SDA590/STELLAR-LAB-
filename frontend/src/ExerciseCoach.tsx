import { useEffect, useMemo, useRef, useState } from 'react'

type MotionSample = {
  source?: string; received_at?: string; ax: number | null; ay: number | null; az: number | null
  gx: number | null; gy: number | null; gz: number | null; respiration_rate_bpm: number | null; heart_rate_bpm: number | null
}

// goal = ángulo objetivo (grados) respecto a la postura neutra calibrada.
const routines = [
  { id: 'knee', name: 'Elevación de rodilla', duration: '06:00', target: 'Cadera y piernas', sensor: 'MPU6050 en el muslo', goal: 70, cue: 'Eleva la rodilla de forma controlada y conserva el tronco estable.', why: 'Mantiene fuerza en cadera y piernas, que pierden masa muscular en microgravedad.' },
  { id: 'hip', name: 'Movilidad de cadera', duration: '05:00', target: 'Cadera y equilibrio', sensor: 'MPU6050 en el muslo', goal: 35, cue: 'Abre la pierna hacia un lado sin inclinar el torso.', why: 'Conserva la movilidad de la cadera y el equilibrio al volver a la gravedad.' },
  { id: 'shoulder', name: 'Elevación de brazo', duration: '04:00', target: 'Hombros y espalda', sensor: 'MPU6050 en el brazo', goal: 90, cue: 'Sube el brazo hacia el lado hasta la altura del hombro y baja despacio.', why: 'Previene rigidez de hombros y espalda por posturas fijas en la nave.' },
  { id: 'breath', name: 'Respiración de recuperación', duration: '03:00', target: 'Estrés y recuperación', sensor: 'ECG (respiración estimada)', goal: 0, cue: 'Inhala cuatro segundos y exhala seis segundos sin forzar.', why: 'Baja el pulso y la tensión después del ejercicio o de una alerta.' },
]

type Rep = { peak: number; seconds: number; full: boolean }
type Vec = [number, number, number]

const norm = (v: Vec) => Math.hypot(...v)
function angleBetween(a: Vec, b: Vec) {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b))
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
}

function Figure({ pose, phase, view, live = false, liveAngle = null }: { pose: string; phase: number; view: number; live?: boolean; liveAngle?: number | null }) {
  const swing = phase % 2 === 0 ? 1 : -1
  const vars = useMemo(() => {
    let la = -12, ra = 12, ll = 3, rl = -3, torso = 0
    if (pose === 'knee') { ll = swing > 0 ? -48 : 5; rl = swing < 0 ? 48 : -5; la = swing * 22; ra = swing * 18 }
    if (pose === 'hip') { ll = swing > 0 ? -42 : 5; rl = swing < 0 ? 42 : -5; la = -32; ra = 32 }
    if (pose === 'shoulder') { la = -68 + swing * 20; ra = 68 - swing * 20; torso = swing * 3 }
    if (pose === 'breath') { la = -28 - phase * 3; ra = 28 + phase * 3; torso = phase % 2 ? 2 : -2 }
    if (live && liveAngle != null) {
      // La figura "tu movimiento" copia el ángulo medido por el sensor.
      if (pose === 'knee' || pose === 'hip') { ll = 3 - liveAngle * 0.7; rl = -3; la = -12; ra = 12 }
      if (pose === 'shoulder') { la = -12 - liveAngle * 0.85; ra = 12; torso = 0 }
    }
    return { '--view': `${view}deg`, '--la': `${la}deg`, '--ra': `${ra}deg`, '--ll': `${ll}deg`, '--rl': `${rl}deg`, '--torso': `${torso}deg` } as React.CSSProperties
  }, [pose, phase, view, live, liveAngle, swing])

  return <div className={`figure-wrap ${live ? 'live-figure' : 'guide-figure'}`}>
    <span>{live ? 'TU MOVIMIENTO' : 'MOVIMIENTO GUÍA'}</span>
    <div className="figure3d" style={vars} aria-label={live ? 'Movimiento medido por el sensor' : 'Movimiento recomendado'}>
      <div className="body-part head">
        <i className="hair"/><i className="ear ear-left"/><i className="ear ear-right"/>
        <i className="eyebrow brow-left"/><i className="eyebrow brow-right"/><i className="eye eye-left"/><i className="eye eye-right"/>
        <i className="nose"/><i className="mouth"/>
      </div>
      <i className="body-part neck"/>
      <div className="body-part torso"><i className="suit-collar"/><i className="zipper"/><i className="mission-patch">S</i><i className="name-patch">CREW 01</i><i className="utility-pocket"/></div>
      <div className="body-part arm left"><i className="sleeve-patch">01</i></div><div className="body-part arm right"><i className="sleeve-stripe"/></div>
      <div className="body-part leg left"><i className="knee-pad"/></div><div className="body-part leg right"><i className="knee-pad"/></div>
      <i className="body-part joint shoulder-l"/><i className="body-part joint shoulder-r"/><i className="body-part joint hip-l"/><i className="body-part joint hip-r"/>
    </div>
  </div>
}

export default function ExerciseCoach({ sample, astronautId = 'crew' }: { sample: MotionSample | null; astronautId?: string }) {
  const [selected, setSelected] = useState(0)
  const [phase, setPhase] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [view, setView] = useState(-12)
  const [elapsed, setElapsed] = useState(0)
  const [reps, setReps] = useState<Rep[]>([])
  const [angle, setAngle] = useState<number | null>(null)
  const [neutral, setNeutral] = useState<Vec | null>(() => {
    try { const raw = localStorage.getItem(`stellar-neutral-${astronautId}`); return raw ? JSON.parse(raw) : null } catch { return null }
  })
  const [demoChoice, setDemoChoice] = useState<boolean | null>(null)
  const repState = useRef<{ up: boolean; peak: number; start: number }>({ up: false, peak: 0, start: 0 })
  const lastSeen = useRef<string>('')
  const playingRef = useRef(playing)
  playingRef.current = playing

  const routine = routines[selected]
  const usesSensor = routine.goal > 0
  const accel: Vec | null = sample && sample.ax != null && sample.ay != null && sample.az != null ? [sample.ax, sample.ay, sample.az] : null
  const imuLive = sample?.source === 'hardware' && accel != null && norm(accel) > 2 // en reposo el acelerómetro mide ~9,8 m/s² (gravedad)
  const imuZeros = sample?.source === 'hardware' && (accel == null || norm(accel) <= 2)
  const demo = demoChoice ?? !imuLive

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => { setPhase(p => (p + 1) % 4); setElapsed(s => s + 1) }, 1000)
    return () => window.clearInterval(timer)
  }, [playing])

  const registerAngle = (value: number, now: number, goal: number) => {
    setAngle(value)
    if (!playingRef.current || goal <= 0) return
    const st = repState.current
    if (!st.up && value >= goal * 0.5) { st.up = true; st.peak = value; st.start = now }
    else if (st.up) {
      st.peak = Math.max(st.peak, value)
      if (value <= goal * 0.25) {
        const rep = { peak: Math.round(st.peak), seconds: Math.max(1, Math.round((now - st.start) / 1000)), full: st.peak >= goal * 0.85 }
        setReps(r => [...r, rep]); st.up = false; st.peak = 0
      }
    }
  }

  // Ángulo REAL: cada lectura nueva del ESP32 (se ignoran las repetidas)
  useEffect(() => {
    if (demo || !imuLive || !accel) return
    const key = sample?.received_at ?? ''
    if (key === lastSeen.current) return
    lastSeen.current = key
    registerAngle(neutral ? angleBetween(accel, neutral) : 0, Date.now(), routine.goal)
  }, [sample?.received_at, demo, imuLive, neutral, routine.goal])

  // Ángulo SIMULADO para la demo: sigue la guía con pequeñas imperfecciones
  useEffect(() => {
    if (!demo || !usesSensor) return
    const t0 = Date.now()
    const timer = window.setInterval(() => {
      const t = (Date.now() - t0) / 1000, cycle = Math.floor(t / 4)
      const reach = cycle % 4 === 3 ? 0.7 : 0.95 // una de cada cuatro queda corta, para mostrar la corrección
      registerAngle(Math.max(0, routine.goal * reach * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 4)) + Math.sin(t * 7) * 2), Date.now(), routine.goal)
    }, 250)
    return () => window.clearInterval(timer)
  }, [demo, usesSensor, routine.goal])

  const resetSession = () => { setReps([]); setElapsed(0); setPhase(0); repState.current = { up: false, peak: 0, start: 0 } }
  const calibrate = () => {
    if (!accel) return
    setNeutral(accel)
    try { localStorage.setItem(`stellar-neutral-${astronautId}`, JSON.stringify(accel)) } catch { /* sin almacenamiento */ }
  }

  const full = reps.filter(r => r.full).length
  const fast = reps.filter(r => r.seconds < 2).length
  const score = reps.length ? Math.round((full / reps.length) * 100) : null
  const lastRep = reps[reps.length - 1]
  const breathing = sample?.respiration_rate_bpm ?? null
  const progress = usesSensor && angle != null ? Math.min(100, (angle / routine.goal) * 100) : 0
  const advice = !usesSensor ? 'Sigue el ritmo de la respiración guiada.'
    : !playing ? 'Pulsa "Iniciar rutina" para empezar a contar repeticiones.'
    : !lastRep ? `Sube hasta unos ${routine.goal}° y vuelve a la posición inicial.`
    : !lastRep.full ? `Última repetición: ${lastRep.peak}° de ${routine.goal}°. Intenta subir un poco más.`
    : lastRep.seconds < 2 ? 'Buen rango, pero muy rápido: hazlo más lento y controlado.'
    : 'Repetición completa y controlada. ¡Sigue así!'

  return <section className="coach-page">
    <div className="coach-heading"><div><span>STELLAR MOTION COACH</span><h2>Entrenamiento guiado</h2><p>Un sensor MPU6050 mide el ángulo de tu pierna o brazo frente a tu postura neutra y cuenta las repeticiones.</p></div><div className="session-health"><b>{sample?.heart_rate_bpm != null ? Math.round(sample.heart_rate_bpm) : '—'} bpm</b><span>FC durante ejercicio</span><b>{breathing?.toFixed(1) ?? '—'} rpm</b><span>Respiración</span></div></div>

    <div className={`imu-strip ${imuLive && !demo ? 'real' : ''}`}>
      <b>{demo ? 'MODO DEMOSTRACIÓN · movimiento simulado' : 'SENSOR REAL · MPU6050 vía ESP32'}</b>
      <span>{imuLive ? (neutral ? 'Postura neutra calibrada.' : 'Ponte en la postura inicial y pulsa "Calibrar postura neutra".') : imuZeros ? 'El ESP32 está conectado pero no envía datos del acelerómetro (llegan en 0): falta activar el MPU6050 en el firmware.' : 'No llegan datos del acelerómetro; se usa el modo demostración.'}</span>
      <div>
        {imuLive && <button onClick={calibrate}>Calibrar postura neutra</button>}
        <label><input type="checkbox" checked={demo} onChange={e => setDemoChoice(e.target.checked)} disabled={!imuLive} /> Demostración</label>
      </div>
    </div>

    <div className="coach-layout">
      <aside className="routine-list" aria-label="Rutinas disponibles">
        <span>RUTINA DE HOY · 18 MIN</span>
        {routines.map((item, index) => <button key={item.id} className={selected === index ? 'selected' : ''} onClick={() => { setSelected(index); resetSession(); setPlaying(false) }}><i>{String(index + 1).padStart(2, '0')}</i><div><b>{item.name}</b><small>{item.target} · {item.duration}</small></div></button>)}
      </aside>

      <article className="pose-panel">
        <div className="pose-toolbar"><div><span>EJERCICIO {selected + 1} DE {routines.length} · {routine.sensor.toUpperCase()}</span><h3>{routine.name}</h3></div><div className="match"><b>{usesSensor && angle != null ? `${Math.round(angle)}°` : '—'}</b><span>{usesSensor ? `ángulo actual · meta ${routine.goal}°` : 'sin sensor de movimiento'}</span></div></div>
        <div className="pose-stage">
          <div className="deck-grid"/><Figure pose={routine.id} phase={phase} view={view}/><div className="pose-divider"/><Figure pose={routine.id} phase={phase} view={view} live liveAngle={usesSensor ? angle : null}/>
          <div className="orientation"><span>VISTA</span><input aria-label="Rotar vista 3D" type="range" min="-45" max="45" value={view} onChange={e => setView(Number(e.target.value))}/><b>{view}°</b></div>
        </div>
        {usesSensor && <div className="angle-meter"><i style={{ width: `${progress}%` }} /><em /><span>0°</span><span>meta {routine.goal}°</span></div>}
        <div className="coach-cue"><span>PASO {phase + 1}</span><p>{routine.cue}</p><div className="session-controls"><button className="primary-action" onClick={() => { if (!playing) resetSession(); setPlaying(p => !p) }}>{playing ? 'Pausar rutina' : 'Iniciar rutina'}</button><button onClick={resetSession}>Reiniciar conteo</button><b>{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</b></div></div>
      </article>

      <aside className="coach-feedback">
        <span>RETROALIMENTACIÓN</span><h3>{advice}</h3>
        <div className="alignment-ring" style={{'--score': `${(score ?? 0) * 3.6}deg`} as React.CSSProperties}><b>{reps.length}</b><small>repeticiones</small></div>
        <ul>
          <li><i className={score == null || score >= 80 ? 'ok' : 'watch'}/>Rango completo: {usesSensor ? `${full} de ${reps.length}` : '—'}</li>
          <li><i className={fast === 0 ? 'ok' : 'watch'}/>{fast === 0 ? 'Ritmo controlado' : `${fast} repetición(es) muy rápidas`}</li>
          <li><i className={(breathing ?? 0) > 20 ? 'watch' : 'ok'}/>{(breathing ?? 0) > 20 ? 'Respiración alta: reduce la intensidad' : 'Respiración uniforme'}</li>
        </ul>
        <div className="safety-note"><b>Por qué en el espacio</b><p>{routine.why}</p></div>
        <div className="safety-note"><b>Seguridad</b><p>Detén la rutina si aparece dolor, mareo o dificultad respiratoria. En microgravedad el ángulo se calcularía con el giroscopio; en la Tierra usamos la gravedad como referencia.</p></div>
      </aside>
    </div>
  </section>
}
