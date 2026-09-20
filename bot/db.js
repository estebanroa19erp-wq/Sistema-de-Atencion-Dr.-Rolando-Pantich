const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'rolo-turnos.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS turnos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  nombre TEXT,
  telefono TEXT,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL,
  tipo TEXT NOT NULL,
  p1 TEXT,
  p2 TEXT,
  p2_extra TEXT,
  derivado INTEGER DEFAULT 0,
  nombre_colega TEXT,
  estado TEXT DEFAULT 'pendiente',
  es_urgencia INTEGER DEFAULT 0,
  gcal_event_id TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS slots_bloqueados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL,
  motivo TEXT,
  UNIQUE(fecha, hora)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

const defaults = {
  dias_atencion: '[2,4]',
  hora_inicio: '17',
  hora_fin: '22',
  turnos_por_dia: '5',
  cupos_urgencia: '2',
  google_refresh_token: '',
  google_calendar_id: 'primary'
};
const insertDefault = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insertDefault.run(k, v);

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function getSession(chatId) {
  const row = db.prepare('SELECT state FROM sessions WHERE chat_id = ?').get(String(chatId));
  return row ? JSON.parse(row.state) : null;
}

function saveSession(chatId, state) {
  db.prepare('INSERT OR REPLACE INTO sessions (chat_id, state, updated_at) VALUES (?, ?, datetime("now","localtime"))').run(String(chatId), JSON.stringify(state));
}

function deleteSession(chatId) {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(String(chatId));
}

function saveTurno(data) {
  return db.prepare(`
    INSERT INTO turnos (chat_id, nombre, telefono, fecha, hora, tipo, p1, p2, p2_extra, derivado, nombre_colega, es_urgencia)
    VALUES (@chat_id, @nombre, @telefono, @fecha, @hora, @tipo, @p1, @p2, @p2_extra, @derivado, @nombre_colega, @es_urgencia)
  `).run(data);
}

function setTurnoGcalId(id, eventId) {
  db.prepare('UPDATE turnos SET gcal_event_id = ? WHERE id = ?').run(eventId, id);
}

function getTurnosByFecha(fecha) {
  return db.prepare("SELECT * FROM turnos WHERE fecha = ? AND estado != 'cancelado' ORDER BY hora").all(fecha);
}

function getTurnosByChatId(chatId) {
  return db.prepare(`
    SELECT * FROM turnos WHERE chat_id = ? AND estado = 'pendiente'
    AND fecha >= date('now','localtime') ORDER BY fecha, hora
  `).all(String(chatId));
}

function cancelarTurno(id) {
  db.prepare("UPDATE turnos SET estado = 'cancelado' WHERE id = ?").run(id);
}

function getTurnoById(id) {
  return db.prepare('SELECT * FROM turnos WHERE id = ?').get(id);
}

function getProximosTurnos(dias) {
  return db.prepare(`
    SELECT * FROM turnos
    WHERE fecha >= date('now','localtime')
    AND fecha <= date('now','localtime','+'||?||' days')
    AND estado != 'cancelado'
    ORDER BY fecha, hora
  `).all(dias || 7);
}

function getTurnosHoy() {
  return db.prepare(`
    SELECT * FROM turnos WHERE fecha = date('now','localtime') AND estado != 'cancelado' ORDER BY hora
  `).all();
}

function isSlotBloqueado(fecha, hora) {
  return !!db.prepare('SELECT 1 FROM slots_bloqueados WHERE fecha = ? AND hora = ?').get(fecha, hora);
}

function bloquearSlot(fecha, hora, motivo) {
  db.prepare('INSERT OR IGNORE INTO slots_bloqueados (fecha, hora, motivo) VALUES (?, ?, ?)').run(fecha, hora, motivo || '');
}

function desbloquearSlot(fecha, hora) {
  db.prepare('DELETE FROM slots_bloqueados WHERE fecha = ? AND hora = ?').run(fecha, hora);
}

function getTurnosCountByFecha(fecha) {
  const row = db.prepare("SELECT COUNT(*) as c FROM turnos WHERE fecha = ? AND estado != 'cancelado' AND es_urgencia = 0").get(fecha);
  return row ? row.c : 0;
}

function getUrgenciasCountHoy(fecha) {
  const row = db.prepare("SELECT COUNT(*) as c FROM turnos WHERE fecha = ? AND estado != 'cancelado' AND es_urgencia = 1").get(fecha);
  return row ? row.c : 0;
}

module.exports = {
  db, getConfig, setConfig,
  getSession, saveSession, deleteSession,
  saveTurno, setTurnoGcalId,
  getTurnosByFecha, getTurnosByChatId,
  cancelarTurno, getTurnoById,
  getProximosTurnos, getTurnosHoy,
  isSlotBloqueado, bloquearSlot, desbloquearSlot,
  getTurnosCountByFecha, getUrgenciasCountHoy
};
