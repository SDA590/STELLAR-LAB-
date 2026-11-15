import Icon from './Icon'
import type { Alert } from './health'
import { t } from './i18n'

const legend = () => [
  { level: 1, title: t('Nivel 1 · Lo resuelves tú', 'Level 1 · Self-care'), text: t('Descanso, hidratación, respiración o ajustar el ejercicio. Vuelve a medir.', 'Rest, hydration, breathing or adjusting exercise. Measure again.') },
  { level: 2, title: t('Nivel 2 · Avisa al oficial médico', 'Level 2 · Tell the medical officer'), text: t('El cambio es mayor o se combinan varias señales. Lo revisa la tripulación.', 'The change is larger or several signals combine. The crew reviews it.') },
  { level: 3, title: t('Nivel 3 · Consulta con Tierra', 'Level 3 · Consult Earth'), text: t('Se genera un reporte prioritario para los médicos en Tierra.', 'A priority report is generated for the flight surgeons on Earth.') },
]
const linkLabel = (link: string) => link === 'Wellness' ? t('Ir a Bienestar', 'Go to Wellness') : link === 'EVA' ? t('Ver posición en cabina', 'View cabin position') : t('Ir a Entrenamiento', 'Go to Training')

export default function Alerts({ alerts, onOpen }: { alerts: Alert[]; onOpen: (screen: string) => void }) {
  const active = alerts.filter(a => a.level >= 1)
  const reminders = alerts.filter(a => a.level === 0)
  return <section className="alerts-page">
    <div className="level-legend">{legend().map(l => <div key={l.level}><b><span className={`lv l${l.level}`}>{l.level}</span>{l.title}</b><p>{l.text}</p></div>)}</div>

    {active.length === 0 && <div className="empty-ok"><Icon name="check-circulo" size={40} /><h3>{t('Sin alertas activas', 'No active alerts')}</h3><p>{t('Tus señales están dentro de tu propia línea base y tu chequeo no muestra señales de alerta.', 'Your signals are within your own baseline and your check-in shows no warning signs.')}</p></div>}

    {[...active, ...reminders].map(a => <article key={a.id} className={`alert-card l${a.level}`}>
      <div>
        <div className="meta">{a.level_title.toUpperCase()}</div>
        <h3><span className={`lv l${a.level}`}>{a.level || '•'}</span>{a.title}</h3>
        <p className="reason">{a.reason}</p>
        <div className="hazard"><Icon name="cohete" size={14} />{t('Relación con el espacio', 'Spaceflight link')}: {a.hazard}</div>
        {a.evidence.length > 0 && <div className="evidence">{a.evidence.map(e => <span key={e}>{e}</span>)}</div>}
      </div>
      <div className="todo">
        <b>{t('QUÉ HACER', 'WHAT TO DO')}</b>
        <ol>{a.actions.map(step => <li key={step}>{step}</li>)}</ol>
        <div className="who-acts">{t('Actúa', 'Who acts')}: <em>{a.who}</em></div>
        {a.link && <button className="link-btn" onClick={() => onOpen(a.link!)}>{linkLabel(a.link)}<Icon name="flecha-derecha" size={14} /></button>}
      </div>
    </article>)}

    <p className="disclaimer">{t('Reglas simples y transparentes con rangos de referencia generales. Prototipo educativo: no es un dispositivo médico ni da diagnósticos.', 'Simple, transparent rules with general reference ranges. Educational prototype: not a medical device and gives no diagnoses.')}</p>
  </section>
}
