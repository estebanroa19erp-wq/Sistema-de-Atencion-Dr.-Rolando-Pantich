const { google } = require('googleapis');
const http = require('http');
const { getConfig, setConfig } = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_PORT = process.env.OAUTH_PORT || 9876;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

function getClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
  const token = getConfig('google_refresh_token');
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

function waitForCode(timeoutMs) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2 style="font-family:sans-serif;color:green">✅ Autorización completada. Podés cerrar esta pestaña.</h2>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end('Código no recibido');
        server.close();
        reject(new Error('No code in callback'));
      }
    });
    server.listen(REDIRECT_PORT, '127.0.0.1');
    setTimeout(() => { server.close(); reject(new Error('Timeout OAuth')); }, timeoutMs || 300000);
  });
}

async function exchangeCode(code) {
  const client = getClient();
  const { tokens } = await client.getToken(code);
  const token = tokens.refresh_token || tokens.access_token;
  setConfig('google_refresh_token', token);
  return tokens;
}

async function crearEvento(turno) {
  const token = getConfig('google_refresh_token');
  if (!token) throw new Error('sin_token');
  const auth = getClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const hora = turno.hora;
  const [hh, mm] = hora.split(':');
  const endHH = String(parseInt(hh) + 1).padStart(2, '0');
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
    end: { dateTime: `${turno.fecha}T${endHH}:${mm}:00-03:00`, timeZone: tz },
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
  const token = getConfig('google_refresh_token');
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

module.exports = { getAuthUrl, waitForCode, exchangeCode, crearEvento, eliminarEvento, listarEventos };
