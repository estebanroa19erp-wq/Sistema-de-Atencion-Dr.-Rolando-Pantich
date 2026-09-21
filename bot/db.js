const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const TURNOS_FILE = path.join(DATA_DIR, 'turnos.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let _turnosId = 0;
let _turnos = readJSON(TURNOS_FILE, []);
if (_turnos.length) _turnosId = Math.max(..._turnos.map(t => t.id));

let _slots = [];
let _sessions = {};

const _configDefaults = {
  dias_atencion: '[2,4]',
  hora_inicio: '17',
  hora_fin: '22',
  turnos_por_dia: '5',
  cupos_urgencia: '2',
  google_refresh_token: '',
  google_calendar_id: 'primary'
};
let _config = Object.assign({}, _configDefaults, readJSON(CONFIG_FILE, {}));

function syncDB() { return Promise.resolve(); }

function getConfig(key) { return _config[key] ?? null; }
function setConfig(key, value) {
  _config[key] = String(value);
  writeJSON(CONFIG_FILE, _config);
}

function getSession(chatId) { return _sessions[String(chatId)] || null; }
function saveSession(chatId, state) { _sessions[String(chatId)] = state; }
function deleteSession(chatId) { delete _sessions[String(chatId)]; }

function saveTurno(data) {
  const turno = {
    id: ++_turnosId,
    chat_id: data.chat_id,
    nombre: data.nombre || null,
    telefono: data.telefono || null,
    fecha: data.fecha,
    hora: data.hora,
    tipo: data.tipo,
    p1: data.p1 || null,
    p2: data.p2 || null,
    p2_extra: data.p2_extra || null,
    derivado: data.derivado || 0,
    nombre_colega: data.nombre_colega || null,
    es_urgencia: data.es_urgencia || 0,
    estado: 'pendiente_confirmacion',
    gcal_event_id: null,
    created_at: new Date().toLocaleString('sv').replace(' ', 'T')
  };
  _turnos.push(turno);
  writeJSON(TURNOS_FILE, _turnos);
  return { lastInsertRowid: turno.id };
}

function updateTurnoEstado(id, estado) {
  const t = _turnos.find(t => t.id === id);
  if (t) { t.estado = estado; writeJSON(TURNOS_FILE, _turnos); }
}

function reprogramarTurno(id, fecha, hora) {
  const t = _turnos.find(t => t.id === id);
  if (t) { t.fecha = fecha; t.hora = hora; t.estado = 'confirmado'; writeJSON(TURNOS_FILE, _turnos); }
}

function setTurnoGcalId(id, eventId) {
  const t = _turnos.find(t => t.id === id);
  if (t) { t.gcal_event_id = eventId; writeJSON(TURNOS_FILE, _turnos); }
}

function getTurnoById(id) { return _turnos.find(t => t.id === id) || null; }

function getTurnosByFecha(fecha) {
  return _turnos.filter(t => t.fecha === fecha && t.estado !== 'cancelado').sort((a,b) => a.hora.localeCompare(b.hora));
}

function getTurnosByChatId(chatId) {
  const hoy = new Date().toISOString().slice(0,10);
  return _turnos.filter(t => t.chat_id === String(chatId) && t.estado === 'pendiente' && t.fecha >= hoy).sort((a,b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora));
}

function cancelarTurno(id) { updateTurnoEstado(id, 'cancelado'); }

function getProximosTurnos(dias) {
  const hoy = new Date().toISOString().slice(0,10);
  const limite = new Date(Date.now() + (dias||7)*864e5).toISOString().slice(0,10);
  return _turnos.filter(t => t.fecha >= hoy && t.fecha <= limite && t.estado !== 'cancelado').sort((a,b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora));
}

function getTurnosHoy() {
  const hoy = new Date().toLocaleString('sv').slice(0,10);
  return _turnos.filter(t => t.fecha === hoy && t.estado !== 'cancelado').sort((a,b) => a.hora.localeCompare(b.hora));
}

function getTurnosPendientes() {
  return _turnos.filter(t => t.estado === 'pendiente_confirmacion').sort((a,b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora));
}

function getHorasOcupadas(fecha) {
  return _turnos.filter(t => t.fecha === fecha && t.estado !== 'cancelado' && !t.es_urgencia).map(t => t.hora);
}

function getTurnosCountByFecha(fecha) {
  return _turnos.filter(t => t.fecha === fecha && t.estado !== 'cancelado' && !t.es_urgencia).length;
}

function getUrgenciasCountHoy(fecha) {
  return _turnos.filter(t => t.fecha === fecha && t.estado !== 'cancelado' && t.es_urgencia).length;
}

function isSlotBloqueado(fecha, hora) {
  return _slots.some(s => s.fecha === fecha && s.hora === hora);
}

function bloquearSlot(fecha, hora, motivo) {
  if (!isSlotBloqueado(fecha, hora)) _slots.push({ fecha, hora, motivo: motivo || '' });
}

function desbloquearSlot(fecha, hora) {
  _slots = _slots.filter(s => !(s.fecha === fecha && s.hora === hora));
}

function importarDesdeCalendar(eventos) {
  for (const ev of eventos) {
    const desc = ev.description || '';
    if (!desc.includes('Vía: Bot Telegram')) continue;
    const idMatch = desc.match(/ID Turno: #(\d+)/);
    const start = ev.start?.dateTime;
    if (!start || !idMatch) continue;
    const id = parseInt(idMatch[1]);
    if (_turnos.find(t => t.id === id)) continue;
    const fecha = start.slice(0, 10);
    const hora = start.slice(11, 16);
    const nombreMatch = desc.match(/Paciente: ([^\n]+)/);
    const telMatch = desc.match(/Tel: ([^\n]+)/);
    _turnos.push({ id, chat_id: 'GCAL', nombre: nombreMatch?.[1] || '', telefono: telMatch?.[1] || '', fecha, hora, tipo: 'CONSULTA_CARDIOLOGIA', p1: '', p2: '', p2_extra: '', derivado: 0, nombre_colega: '', es_urgencia: 0, estado: 'confirmado', gcal_event_id: ev.id || null, created_at: new Date().toISOString() });
    if (id >= _turnosId) _turnosId = id + 1;
  }
}

module.exports = {
  db: null, syncDB, getConfig, setConfig,
  getSession, saveSession, deleteSession,
  saveTurno, setTurnoGcalId, updateTurnoEstado, reprogramarTurno,
  getTurnosPendientes,
  getTurnosByFecha, getTurnosByChatId,
  cancelarTurno, getTurnoById,
  getProximosTurnos, getTurnosHoy,
  isSlotBloqueado, bloquearSlot, desbloquearSlot,
  getHorasOcupadas, getTurnosCountByFecha, getUrgenciasCountHoy,
  importarDesdeCalendar
};
