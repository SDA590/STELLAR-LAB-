import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import type { Checkin } from './health'

// Rangos de referencia GENERALES para explicar cada dato. No son un diagnóstico.
function sleepNote(h: number) { return h < 6 ? { tone: 'watch', text: 'Poco sueño · lo recomendado es 7–9 h' } : h > 10 ? { tone: 'watch', text: 'Sueño muy largo · observa si hay fatiga' } : { tone: '', text: 'Dentro de lo recomendado (7–9 h)' } }
function glucoseNote(g: number) { return g < 70 ? { tone: 'alert', text: 'Baja (< 70 mg/dL): come algo con azúcar y vuelve a medir' } : g > 180 ? { tone: 'alert', text: 'Alta (> 180 mg/dL): informa al oficial médico' } : g > 140 ? { tone: 'watch', text: 'Algo alta (> 140 mg/dL): revisa cuándo comiste' } : { tone: '', text: 'Dentro del rango de referencia (70–140 mg/dL)' } }
function bpNote(s: number, d: number) { return s >= 140 || d >= 90 ? { tone: 'alert', text: 'Alta (≥ 140/90)' } : s >= 130 || d >= 80 ? { tone: 'watch', text: 'Elevada (≥ 130/80)' } : s < 90 || d < 60 ? { tone: 'watch', text: 'Baja (< 90/60)' } : { tone: '', text: 'Normal (< 130/80)' } }
function tempNote(t: number) { return t >= 38 ? { tone: 'alert', text: 'Fiebre (≥ 38 °C)' } : t >= 37.3 ? { tone: 'watch', text: 'Algo elevada (≥ 37,3 °C)' } : t < 35.5 ? { tone: 'watch', text: 'Baja (< 35,5 °C)' } : { tone: '', text: 'Normal (36–37,2 °C)' } }

const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()
const num = (v: string) => v.trim() === '' ? null : Number(v.replace(',', '.'))
const ok = (v: number | null): v is number => v != null && !Number.isNaN(v)

export default function WellnessCheck({ astronautId }: { astronautId: string }) {
  const [sleep, setSleep] = useState(7.5)
  const [mood, setMood] = useState(3)
  const [stress, setStress] = useState(2)
  const [glucose, setGlucose] = useState('')
  const [sys, setSys] = useState('')
  const [dia, setDia] = useState('')
  const [temp, setTemp] = useState('')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [storage, setStorage] = useState<string>('')
  const [history, setHistory] = useState<Checkin[]>([])

  const load = async () => {
    try {
      const res = await apiFetch(`/api/checkins?astronaut_id=${astronautId}&days=7`)
      if (res.ok) { const data = await res.json(); setHistory(data.items); setStorage(data.storage) }
    } catch { /* sin conexión: se mantiene lo último */ }
  }
  useEffect(() => { load() }, [astronautId])

  const touch = () => { if (status !== 'idle') setStatus('idle') }
  const glucoseValue = num(glucose), sysValue = num(sys), diaValue = num(dia), tempValue = num(temp)

  const save = async () => {
    setStatus('saving')
    try {
      const res = await apiFetch('/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        astronaut_id: astronautId, sleep_hours: sleep, mood, stress,
        glucose_mg_dl: ok(glucoseValue) ? glucoseValue : null, systolic_mmhg: ok(sysValue) ? sysValue : null,
        diastolic_mmhg: ok(diaValue) ? diaValue : null, temperature_c: ok(tempValue) ? tempValue : null, notes: notes.trim() || null,
      }) })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json(); setStorage(data.storage); setStatus('saved'); setGlucose(''); setSys(''); setDia(''); setTemp(''); setNotes('')
      load()
    } catch { setStatus('error') }
  }

  const today = history.filter(c => isToday(c.created_at))
  const reminders = [
    !today.length && 'Completa tu chequeo diario (sueño y ánimo).',
    !today.some(c => c.glucose_mg_dl != null) && 'Mídete la glucosa y anótala aquí.',
    !today.some(c => c.systolic_mmhg != null) && 'Opcional: anota tu presión si tienes el tensiómetro a mano (si no, se usa la medición automática).',
  ].filter(Boolean) as string[]

  const concern = stress >= 4 || mood <= 2 || sleep < 6 || (ok(glucoseValue) && (glucoseValue < 70 || glucoseValue > 180)) || (ok(tempValue) && tempValue >= 38)
  const recent = [...history].reverse().slice(-7)

  return <section className="wellness-page">
    <div className="wellness-heading"><span>BEHAVIORAL HEALTH · CHEQUEO DIARIO</span><h2>Bienestar de la tripulación</h2><p>Un registro breve cada día ayuda a reconocer cambios por aislamiento, carga de trabajo, sueño y recuperación. Los rangos son de referencia general, no un diagnóstico.</p></div>

    {reminders.length > 0 && <div className="reminder-strip"><b>◷ RECORDATORIOS DE HOY</b>{reminders.map(r => <span key={r}>{r}</span>)}</div>}

    <div className="wellness-grid">
      <article className="checkin-panel"><span>REGISTRO DIARIO · MANUAL</span><h3>¿Cómo te sientes hoy?</h3>
        <label>Horas de sueño <b>{sleep.toFixed(1)} h</b><input type="range" min="0" max="12" step="0.5" value={sleep} onChange={e => { setSleep(Number(e.target.value)); touch() }}/></label><p className={`field-note ${sleepNote(sleep).tone}`}>{sleepNote(sleep).text}</p>
        <label>Estado de ánimo <b>{mood}/5</b><input type="range" min="1" max="5" value={mood} onChange={e => { setMood(Number(e.target.value)); touch() }}/></label><div className="scale"><span>Muy bajo</span><span>Estable</span><span>Muy bien</span></div>
        <label>Nivel de tensión <b>{stress}/5</b><input type="range" min="1" max="5" value={stress} onChange={e => { setStress(Number(e.target.value)); touch() }}/></label><div className="scale"><span>Bajo</span><span>Moderado</span><span>Alto</span></div>

        <div className="manual-grid">
          <label className="num-field">Glucosa <small>mg/dL</small><input inputMode="decimal" placeholder="ej. 95" value={glucose} onChange={e => { setGlucose(e.target.value); touch() }}/></label>
          <label className="num-field">Presión <small>sistólica</small><input inputMode="numeric" placeholder="ej. 118" value={sys} onChange={e => { setSys(e.target.value); touch() }}/></label>
          <label className="num-field">Presión <small>diastólica</small><input inputMode="numeric" placeholder="ej. 76" value={dia} onChange={e => { setDia(e.target.value); touch() }}/></label>
          <label className="num-field">Temperatura <small>°C</small><input inputMode="decimal" placeholder="ej. 36.6" value={temp} onChange={e => { setTemp(e.target.value); touch() }}/></label>
        </div>
        {ok(glucoseValue) && <p className={`field-note ${glucoseNote(glucoseValue).tone}`}>Glucosa: {glucoseNote(glucoseValue).text}</p>}
        {ok(sysValue) && ok(diaValue) && <p className={`field-note ${bpNote(sysValue, diaValue).tone}`}>Presión: {bpNote(sysValue, diaValue).text}</p>}
        {ok(tempValue) && <p className={`field-note ${tempNote(tempValue).tone}`}>Temperatura: {tempNote(tempValue).text}</p>}
        <label className="notes-field">Notas (opcional)<textarea maxLength={500} rows={2} value={notes} onChange={e => { setNotes(e.target.value); touch() }} placeholder="¿Algo que quieras registrar?"/></label>

        <button className="primary-action" disabled={status === 'saving'} onClick={save}>{status === 'saving' ? 'Guardando…' : status === 'saved' ? 'Chequeo guardado ✓' : 'Guardar chequeo'}</button>
        {status === 'error' && <p className="field-note alert">No se pudo guardar. Revisa los valores (por ejemplo, glucosa entre 20 y 600) y la conexión.</p>}
        <p className="privacy-copy">{storage === 'supabase' ? 'Se guarda en la base de datos de la misión (Supabase); solo el backend puede leerla.' : 'Guardado temporal en el servidor: falta crear la tabla de chequeos en Supabase.'}</p>
      </article>

      <article className="breathing-panel"><span>RECUPERACIÓN GUIADA</span><h3>Respiración 4 · 6</h3><div className="breath-orb"><div/><b>INHALA</b><small>4 segundos</small></div><p>Realiza cinco ciclos lentos. La guía no sustituye una evaluación psicológica o médica.</p></article>
      <article className="wellness-action"><span>ACCIÓN RECOMENDADA</span><h3>{concern ? 'Solicita apoyo de la tripulación' : 'Mantén tu rutina de recuperación'}</h3><p>{concern ? 'Registra cómo te sientes, informa al responsable médico y realiza una pausa segura.' : 'Completa la rutina breve, hidrátate y vuelve a evaluar tu estado después del ejercicio.'}</p><div><i/>Recomendación explicable, no diagnóstico</div></article>

      <article className="checkin-history"><span>TUS ÚLTIMOS 7 DÍAS</span><h3>Tendencia de sueño y ánimo</h3>
        {recent.length ? <><div className="mini-bars">{recent.map(c => <div key={c.created_at} title={new Date(c.created_at).toLocaleString()}>
          <i className="sleep" style={{ height: `${Math.min(100, ((c.sleep_hours ?? 0) / 10) * 100)}%` }} /><i className="mood" style={{ height: `${((c.mood ?? 0) / 5) * 100}%` }} />
          <small>{new Date(c.created_at).toLocaleDateString([], { day: '2-digit', month: '2-digit' })}</small></div>)}</div>
          <div className="legend"><span><i className="sleep" />Sueño (h)</span><span><i className="mood" />Ánimo (1–5)</span></div>
          <ul className="checkin-list">{history.slice(0, 4).map(c => <li key={c.created_at}><b>{new Date(c.created_at).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b> sueño {c.sleep_hours ?? '—'} h · ánimo {c.mood ?? '—'}/5 · tensión {c.stress ?? '—'}/5{c.glucose_mg_dl != null && ` · glucosa ${c.glucose_mg_dl}`}{c.systolic_mmhg != null && ` · PA ${c.systolic_mmhg}/${c.diastolic_mmhg ?? '—'}`}{c.temperature_c != null && ` · ${c.temperature_c} °C`}</li>)}</ul></>
          : <p className="privacy-copy">Aún no hay chequeos. Guarda el primero para ver tu tendencia.</p>}
      </article>
    </div>
  </section>
}
