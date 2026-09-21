const { google } = require('googleapis');
const { getConfig, setConfig } = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getRedirectUri() {
  const base = process.env.TUNNEL_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:9876';
  const clean = base.replace(/\/$/, '');
  // Si hay OAUTH_PATH definido, usarlo; si no, usar raíz (para clientes tipo "web" sin path)
  const oauthPath = process.env.OAUTH_PATH || '/oauth2callback';
  return clean + oauthPath;
}

function getClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
  const token = getConfig('google_refresh_token') || process.env.GOOGLE_REFRESH_TOKEN || '';
  if (token) client.setCredentials({ refresh_token: token });
  return client;
}

function getAuthUrl() {
  return getClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

let _pendingResolve = null;
let _pendingReject = null;
let _pendingTimer = null;

function waitForCode(timeoutMs) {
  return new Promise((resolve, reject) => {
    _pendingResolve = resolve;
    _pendingReject = reject;
    _pendingTimer = setTimeout(() => {
      _pendingResolve = _pendingReject = _pendingTimer = null;
      reject(new Error('Timeout OAuth'));
    }, timeoutMs || 300000);
  });
}

function resolveOAuthCode(code) {
  if (_pendingResolve) {
    clearTimeout(_pendingTimer);
    const fn = _pendingResolve;
    _pendingResolve = _pendingReject = _pendingTimer = null;
    fn(code);
    return true;
  }
  return false;
}

async function exchangeCode(code) {
  const client = getClient();
  const { tokens } = await client.getToken(code);
  const token = tokens.refresh_token || tokens.access_token;
  setConfig('google_refresh_token', token);
  return tokens;
}

async function crearEvento(turno) {
  const token = getConfig('google_refresh_token') || process.env.GOOGLE_REFRESH_TOKEN || '';
  if (!token) throw new Error('sin_token');
  const auth = getClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const hora = turno.hora;
  const [hh, mm] = hora.split(':');
  const endMin = parseInt(hh) * 60 + parseInt(mm || '0') + 60;
  const endH = Math.floor(endMin / 60) % 24;
  const endM = endMin % 60;
  const endDate = endH < parseInt(hh) ? new Date(turno.fecha + 'T00:00:00') : null;
  if (endDate) endDate.setDate(endDate.getDate() + 1);
  const endDateStr = endDate ? endDate.toISOString().slice(0,10) : turno.fecha;
  const endHH = String(endH).padStart(2, '0');
  const endMM = String(endM).padStart(2, '0');
  const tz = 'America/Argentina/Corrientes';

  const tipoLabel = turno.tipo === 'CONTROL_MARCAPASOS' ? 'Control Marcapasos' : 'Consulta Cardiología';
  const derivadoInfo = turno.derivado ? `\nDerivado por: ${turno.nombre_colega}` : '';
  const origenMap = { CORRIENTES_CAPITAL: 'Corrientes Capital', INTERIOR_PROVINCIA: turno.p2_extra, OTRA_PROVINCIA_PAIS: turno.p2_extra };
  const origen = origenMap[turno.p2] || turno.p2;

  const resource = {
    summary: `${tipoLabel} — ${turno.nombre || 'Paciente'}`,
    description: [
      `Paciente: ${turno.nombre || 'No informado'}`,
      `Tel: ${turno.telefono || 'No informado'}`,
      `1era vez: ${turno.p1 === 'SI_PRIMERA_VEZ' ? 'Sí' : 'No'}`,
      `Origen: ${origen}`,
      `Motivo: ${tipoLabel}${derivadoInfo}`,
      `ID Turno: #${turno.id}`,
      `Vía: Bot Telegram`
    ].join('\n'),
    start: { dateTime: `${turno.fecha}T${hora}:00-03:00`, timeZone: tz },
    end: { dateTime: `${endDateStr}T${endHH}:${endMM}:00-03:00`, timeZone: tz },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 15 }]
    }
  };

  const calId = getConfig('google_calendar_id') || 'primary';
  const resp = await calendar.events.insert({ calendarId: calId, resource });
  return resp.data;
}

async function eliminarEvento(eventId) {
  const auth = getClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const calId = getConfig('google_calendar_id') || 'primary';
  await calendar.events.delete({ calendarId: calId, eventId }).catch(() => {});
}

async function listarEventos(desde, hasta) {
  const token = getConfig('google_refresh_token') || process.env.GOOGLE_REFRESH_TOKEN || '';
  if (!token) return [];
  const auth = getClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const calId = getConfig('google_calendar_id') || 'primary';
  const resp = await calendar.events.list({
    calendarId: calId,
    timeMin: `${desde}T00:00:00-03:00`,
    timeMax: `${hasta}T23:59:59-03:00`,
    singleEvents: true,
    orderBy: 'startTime'
  });
  return resp.data.items || [];
}

module.exports = { getAuthUrl, waitForCode, resolveOAuthCode, exchangeCode, crearEvento, eliminarEvento, listarEventos };
