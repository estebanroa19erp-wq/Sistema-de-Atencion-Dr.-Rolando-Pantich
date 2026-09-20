const http = require('http');
const {
  getConfig, setConfig,
  saveTurno, setTurnoGcalId, updateTurnoEstado,
  isSlotBloqueado, getTurnosCountByFecha
} = require('./db');
const { crearEvento } = require('./calendar');

const PORT = parseInt(process.env.HTTP_PORT || '3850');

function json(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Bot-Secret'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function getProximosDias(n, bot) {
  const dias = JSON.parse(getConfig('dias_atencion') || '[2,4]');
  const result = [];
  const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+1);
  while (result.length < n) {
    if (dias.includes(d.getDay())) {
      const fecha = d.toISOString().split('T')[0];
      const count = getTurnosCountByFecha(fecha);
      const max = parseInt(getConfig('turnos_por_dia') || '5');
      const horaInicio = parseInt(getConfig('hora_inicio') || '17');
      const horaFin = parseInt(getConfig('hora_fin') || '22');
      const totalSlots = horaFin - horaInicio;
      const libres = Math.max(0, totalSlots - count);
      result.push({
        fecha,
        nombre: d.toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' }),
        diaSemana: ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d.getDay()],
        cupos: libres
      });
    }
    d.setDate(d.getDate()+1);
  }
  return result;
}

function getSlotsLibres(fecha) {
  const horaInicio = parseInt(getConfig('hora_inicio') || '17');
  const horaFin = parseInt(getConfig('hora_fin') || '22');
  const { db } = require('./db');
  const ocupadas = db.prepare("SELECT hora FROM turnos WHERE fecha=? AND estado NOT IN ('cancelado','rechazado')").all(fecha).map(r => r.hora);
  const slots = [];
  for (let h = horaInicio; h < horaFin; h++) {
    const hora = `${String(h).padStart(2,'0')}:00`;
    if (!ocupadas.includes(hora) && !isSlotBloqueado(fecha, hora)) slots.push(hora);
  }
  return slots;
}

function startHttpServer(bot, ADMIN_IDS) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'OPTIONS') { json(res, {}, 200); return; }

    // GET /api/dias
    if (req.method === 'GET' && url.pathname === '/api/dias') {
      const dias = getProximosDias(6, bot);
      json(res, { ok: true, dias }); return;
    }

    // GET /api/slots?fecha=YYYY-MM-DD
    if (req.method === 'GET' && url.pathname === '/api/slots') {
      const fecha = url.searchParams.get('fecha');
      if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { json(res, { error: 'fecha inválida' }, 400); return; }
      const slots = getSlotsLibres(fecha);
      json(res, { ok: true, slots }); return;
    }

    // POST /api/turno
    if (req.method === 'POST' && url.pathname === '/api/turno') {
      const body = await parseBody(req);
      const { nombre, telefono, fecha, hora, tipo, p1, p2, p2Extra, derivado, nombreColega } = body;
      if (!nombre || !telefono || !fecha || !hora || !tipo) { json(res, { error: 'campos requeridos' }, 400); return; }
      const slots = getSlotsLibres(fecha);
      if (!slots.includes(hora)) { json(res, { error: 'slot_ocupado', slots }, 409); return; }
      const res2 = saveTurno({
        chat_id: 'WEB', nombre, telefono, fecha, hora, tipo: tipo || 'CONSULTA_SIMPLE',
        p1: p1||'', p2: p2||'', p2_extra: p2Extra||'', derivado: derivado?1:0,
        nombre_colega: nombreColega||'', es_urgencia: 0
      });
      const turnoId = res2.lastInsertRowid;
      const fechaLabel = new Date(fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
      const tipoLabel = tipo==='CONTROL_MARCAPASOS'?'Control Marcapasos':'Consulta Cardiológica';
      const msg = `🌐 Nuevo turno WEB #${turnoId}\n\n${tipoLabel}\n📅 ${fechaLabel}\n🕐 ${hora}hs\n👤 ${nombre}\n📱 ${telefono}\n📍 ${p2==='CORRIENTES_CAPITAL'?'Corrientes Capital':p2Extra||p2||''}\n\nEsperando confirmación`;
      const adminKb = {
        inline_keyboard: [
          [{text:'✅ Confirmar', callback_data:`WEB_OK:${turnoId}`},{text:'❌ Rechazar', callback_data:`WEB_REJ:${turnoId}`}],
          [{text:'🔄 Reprogramar', callback_data:`WEB_REP:${turnoId}`}]
        ]
      };
      for (const adminId of ADMIN_IDS) {
        bot.sendMessage(adminId, msg, { reply_markup: adminKb }).catch(()=>{});
      }
      crearEvento({ id:turnoId, nombre, telefono, fecha, hora, tipo, p2_extra:p2Extra||'' })
        .then(ev => { if (ev&&ev.id) setTurnoGcalId(turnoId, ev.id); }).catch(()=>{});
      json(res, { ok: true, turnoId }); return;
    }

    // POST /api/urgencia
    if (req.method === 'POST' && url.pathname === '/api/urgencia') {
      const body = await parseBody(req);
      const { nombre, apellido, dni, telefono, motivo } = body;
      if (!nombre || !telefono || !motivo) { json(res, { error: 'campos requeridos' }, 400); return; }
      const msg = `🚨 URGENCIA WEB\n\n👤 ${nombre} ${apellido||''}\n🪪 DNI: ${dni||'—'}\n📱 ${telefono}\n📝 ${motivo}\n\nContactar en 30 min`;
      for (const adminId of ADMIN_IDS) {
        bot.sendMessage(adminId, msg).catch(()=>{});
      }
      json(res, { ok: true }); return;
    }

    // PUT /api/register (Cloudflare Worker llama acá? No, bot llama Worker)
    json(res, { error: 'not found' }, 404);
  });

  const HOST = process.env.FLY_APP_NAME ? '0.0.0.0' : '127.0.0.1';
  server.listen(PORT, HOST, () => {
    console.log(`HTTP API: http://${HOST}:${PORT}`);
  });

  return server;
}

module.exports = { startHttpServer };
