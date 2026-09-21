require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { startHttpServer } = require('./bot-http');
const {
  getConfig, setConfig,
  getSession, saveSession, deleteSession,
  saveTurno, setTurnoGcalId, updateTurnoEstado, reprogramarTurno,
  getTurnosByChatId, cancelarTurno, getTurnoById,
  getProximosTurnos, getTurnosHoy, getTurnosPendientes,
  isSlotBloqueado, bloquearSlot, desbloquearSlot,
  getTurnosCountByFecha, getHorasOcupadas,
  importarDesdeCalendar, syncDB
} = require('./db');
syncDB().catch(() => {});
const { getAuthUrl, waitForCode, exchangeCode, crearEvento, eliminarEvento, listarEventos } = require('./calendar');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('BOT_TOKEN faltante'); process.exit(1); }

const ADMIN_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const bot = new TelegramBot(TOKEN, {
  polling: true,
  request: { family: 4, agentOptions: { family: 4 } }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isAdmin = (id) => ADMIN_IDS.includes(String(id));

function ss(id) { return getSession(id) || {}; }
function ws(id, data) { saveSession(id, { ...ss(id), ...data }); }
function ds(id) { deleteSession(id); }

function kb(rows) { return { reply_markup: { inline_keyboard: rows } }; }
function btn(text, data) { return { text, callback_data: data }; }

async function notify(msg, opts) {
  for (const id of ADMIN_IDS) {
    await bot.sendMessage(id, msg, opts || {}).catch(() => {});
  }
}

function getProximosDias(n) {
  const dias = JSON.parse(getConfig('dias_atencion') || '[2,4]');
  const result = [];
  const d = new Date();
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 1);
  while (result.length < n) {
    if (dias.includes(d.getDay())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      result.push({
        fecha: `${yyyy}-${mm}-${dd}`,
        nombre: d.toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' })
      });
    }
    d.setDate(d.getDate()+1);
  }
  return result;
}

function getSlotsLibres(fecha) {
  const horaInicio = parseInt(getConfig('hora_inicio') || '17');
  const horaFin = parseInt(getConfig('hora_fin') || '22');
  const maxTurnos = parseInt(getConfig('turnos_por_dia') || '5');
  const ocupadas = getHorasOcupadas(fecha);
  const slots = [];
  for (let h = horaInicio; h < horaFin; h++) {
    const hora = `${String(h).padStart(2,'0')}:00`;
    if (!ocupadas.includes(hora) && !isSlotBloqueado(fecha, hora)) slots.push(hora);
  }
  return slots.slice(0, maxTurnos);
}

function formatTurno(t) {
  const tipo = t.tipo === 'CONTROL_MARCAPASOS' ? '💓 Marcapasos' : '🩺 Consulta';
  const fecha = new Date(t.fecha+'T12:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
  return `${tipo}\n📅 ${fecha}\n🕐 ${t.hora}hs\n👤 ${t.nombre||'Sin nombre'}\n📱 ${t.telefono||'—'}`;
}

function mostrarCalendario(chatId) {
  const dias = getProximosDias(6);
  const rows = dias.map(d => {
    const slots = getSlotsLibres(d.fecha);
    const label = slots.length ? `📅 ${d.nombre} (${slots.length})` : `❌ ${d.nombre} — lleno`;
    return [btn(label, slots.length ? `DIA:${d.fecha}` : 'LLENO')];
  });
  bot.sendMessage(chatId, '📅 *Seleccioná un día:*', { parse_mode:'Markdown', ...kb(rows) });
}

// ─── Comandos ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const id = msg.chat.id;
  ds(id);
  ws(id, { step:'P1' });
  bot.sendMessage(id,
    '👋 Bienvenido al sistema de turnos del *Dr\\. Rolando Pantich*\n_Cardiólogo_\n\n📅 Atención: Martes y Jueves de 17 a 22hs\n\n¿Es la *primera vez* que se atiende con el Doctor?',
    { parse_mode:'MarkdownV2', ...kb([
      [btn('✨ Sí, es la primera vez','P1:SI_PRIMERA_VEZ')],
      [btn('📋 No, ya soy paciente','P1:NO_YA_ATENDIDO')]
    ])}
  );
});

bot.onText(/\/mis_turnos/, (msg) => {
  const id = msg.chat.id;
  const turnos = getTurnosByChatId(id);
  if (!turnos.length) return bot.sendMessage(id, 'No tenés turnos pendientes.\n\nUsá /start para agendar uno.');
  const txt = turnos.map(t => formatTurno(t)).join('\n\n─────────────\n\n');
  bot.sendMessage(id, `📋 *Tus turnos:*\n\n${txt}`, { parse_mode:'Markdown' });
});

bot.onText(/\/cancelar/, (msg) => {
  const id = msg.chat.id;
  ds(id);
  const turnos = getTurnosByChatId(id);
  if (!turnos.length) return bot.sendMessage(id, 'No tenés turnos pendientes.');
  const rows = turnos.map(t => {
    const f = new Date(t.fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'short',day:'numeric',month:'short'});
    return [btn(`❌ ${f} ${t.hora}hs`, `CANCELAR:${t.id}`)];
  });
  rows.push([btn('↩️ Volver','CANCELAR:NADA')]);
  bot.sendMessage(id, '¿Cuál turno querés cancelar?', kb(rows));
});

bot.onText(/\/ayuda/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '*Comandos:*\n\n/start — Agendar turno\n/mis\\_turnos — Ver mis turnos\n/cancelar — Cancelar turno\n/ayuda — Este mensaje',
    { parse_mode:'Markdown' }
  );
});

function enviarPanel(chatId) {
  const hoy = getTurnosHoy();
  const pendientes = getTurnosPendientes();
  const hoyCount = hoy.length;
  const pendCount = pendientes.length;
  const txt = `👨‍⚕️ *Panel Dr. Pantich*\n\n📋 Hoy: *${hoyCount}* turno${hoyCount!==1?'s':''}\n⏳ Pendientes de confirmación: *${pendCount}*`;
  return bot.sendMessage(chatId, txt, {
    parse_mode:'Markdown',
    ...kb([
      [btn(`⏳ Pendientes (${pendCount})`, 'ADMIN:PENDIENTES'), btn('📋 Hoy', 'ADMIN:HOY')],
      [btn('📅 Agenda 7 días', 'ADMIN:AGENDA'), btn('🔒 Bloquear slot', 'ADMIN:BLOQUEAR')],
      [btn('⚙️ Config', 'ADMIN:CONFIG'), btn('🔑 Vincular Calendar', 'ADMIN:AUTH')]
    ])
  });
}

bot.onText(/\/admin/, (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id,'⛔ Acceso denegado.');
  enviarPanel(msg.chat.id);
});

bot.onText(/\/hoy/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const turnos = getTurnosHoy();
  if (!turnos.length) return bot.sendMessage(msg.chat.id,'📭 Sin turnos hoy.');
  const txt = turnos.map((t,i) => `${i+1}. ${t.hora}hs — ${t.nombre||'?'} | ${t.tipo==='CONTROL_MARCAPASOS'?'💓':'🩺'} | ${t.telefono||'—'}${t.es_urgencia?' 🚨':''}`).join('\n');
  bot.sendMessage(msg.chat.id, `📋 *Hoy (${new Date().toLocaleDateString('es-AR')}):*\n\n${txt}`, {parse_mode:'Markdown'});
});

bot.onText(/\/agenda/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const dias = parseInt((msg.text||'').split(' ')[1]) || 7;
  const turnos = getProximosTurnos(dias);
  if (!turnos.length) return bot.sendMessage(msg.chat.id,`📭 Sin turnos próximos.`);
  const grupos = {};
  for (const t of turnos) { if (!grupos[t.fecha]) grupos[t.fecha]=[]; grupos[t.fecha].push(t); }
  let txt = '';
  for (const [fecha, ts] of Object.entries(grupos)) {
    const d = new Date(fecha+'T12:00:00');
    txt += `\n*${d.toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'short'})}*\n`;
    txt += ts.map(t=>`  • ${t.hora}hs ${t.tipo==='CONTROL_MARCAPASOS'?'💓':'🩺'} ${t.nombre||'?'} (${t.telefono||'—'})`).join('\n');
  }
  bot.sendMessage(msg.chat.id, `📅 *Agenda ${dias} días:*\n${txt}`, {parse_mode:'Markdown'});
});

bot.onText(/\/config/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const id = msg.chat.id;
  bot.sendMessage(id,
    `⚙️ *Configuración:*\n\n• Horario: ${getConfig('hora_inicio')}:00 — ${getConfig('hora_fin')}:00\n• Turnos/día: ${getConfig('turnos_por_dia')}\n• Urgencias: ${getConfig('cupos_urgencia')}`,
    { parse_mode:'Markdown', ...kb([
      [btn('🕐 Hora inicio','CFG:hora_inicio'), btn('🕐 Hora fin','CFG:hora_fin')],
      [btn('📋 Turnos/día','CFG:turnos_por_dia'), btn('🚨 Urgencias','CFG:cupos_urgencia')]
    ])}
  );
});

bot.onText(/\/auth/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const url = getAuthUrl();
  bot.sendMessage(msg.chat.id, `🔑 *Vincular Google Calendar*\n\nAbrí este link en el navegador del servidor:\n${url}`, {parse_mode:'Markdown'});
  waitForCode(300000)
    .then(async code => { await exchangeCode(code); notify('✅ Google Calendar vinculado.'); })
    .catch(() => {});
});

// ─── Texto libre ─────────────────────────────────────────────────────────────

bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const id = msg.chat.id;
  const text = msg.text.trim();
  const session = ss(id);
  if (!session.step) return;

  if (session.step === 'ADMIN_BLOQUEAR_FECHA' && isAdmin(id)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return bot.sendMessage(id,'Formato inválido. Usá AAAA-MM-DD');
    ws(id, { step:'ADMIN_BLOQUEAR_HORA', bloquearFecha:text });
    return bot.sendMessage(id,`Fecha: ${text}\n¿Qué hora bloqueás? (ej: 18:00)`);
  }
  if (session.step === 'ADMIN_BLOQUEAR_HORA' && isAdmin(id)) {
    if (!/^\d{2}:\d{2}$/.test(text)) return bot.sendMessage(id,'Formato inválido. Usá HH:MM');
    bloquearSlot(session.bloquearFecha, text, 'admin');
    ds(id);
    return bot.sendMessage(id,`✅ Slot ${session.bloquearFecha} ${text}hs bloqueado.`);
  }
  if (session.step === 'ADMIN_REJ_MOTIVO' && isAdmin(id)) {
    const { rejTurnoId, rejPatientId, rejFecha, rejHora } = session;
    const motivo = text.toLowerCase() === 'no' ? '' : text;
    ds(id);
    bot.sendMessage(id, `✅ Paciente notificado del rechazo.`);
    const motivoTxt = motivo ? `\n\n_Motivo: ${motivo}_` : '';
    bot.sendMessage(rejPatientId,
      `❌ *Tu turno no pudo confirmarse*\n\n📅 ${rejFecha} — ${rejHora}hs${motivoTxt}\n\nPodés intentar con otro horario usando /start`,
      {parse_mode:'Markdown'}
    ).catch(()=>{});
    return;
  }

  if (session.step === 'ADMIN_CONFIG_VALUE' && isAdmin(id)) {
    setConfig(session.configKey, text);
    ds(id);
    return bot.sendMessage(id,`✅ ${session.configKey} = ${text}`);
  }

  switch (session.step) {
    case 'P2_TEXT':
      ws(id, { p2Extra:text, step:'P3' });
      bot.sendMessage(id,'¿Cuál es el motivo de la consulta?', kb([
        [btn('💓 Control Marcapasos','P3:CONTROL_MARCAPASOS')],
        [btn('🩺 Consulta Cardiológica','P3:CONSULTA_SIMPLE')]
      ]));
      break;
    case 'P3_COLEGA':
      ws(id, { nombreColega:text, step:'NOMBRE' });
      bot.sendMessage(id,'¿Cuál es tu nombre completo?');
      break;
    case 'NOMBRE':
      ws(id, { nombre:text, step:'TELEFONO' });
      bot.sendMessage(id,'¿Cuál es tu número de WhatsApp? (con código de área, ej: 3794123456)');
      break;
    case 'TELEFONO':
      ws(id, { telefono:text, step:'CALENDARIO' });
      mostrarCalendario(id);
      break;
  }
});

// ─── Callbacks inline ────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const id = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const session = ss(id);

  const edit = (text, opts) => bot.editMessageText(text, { chat_id:id, message_id:msgId, parse_mode:'Markdown', ...(opts||{}) });
  bot.answerCallbackQuery(query.id).catch(()=>{});

  // P1
  if (data.startsWith('P1:')) {
    const val = data.split(':')[1];
    ws(id, { p1:val, step:'P2' });
    edit(`${val==='SI_PRIMERA_VEZ'?'✨ Primera vez — ¡Bienvenido!':'📋 Paciente existente'}\n\n¿De dónde es usted?`, kb([
      [btn('🏙 Corrientes Capital','P2:CORRIENTES_CAPITAL')],
      [btn('🚜 Interior de la Provincia','P2:INTERIOR_PROVINCIA')],
      [btn('✈️ Otra provincia / país','P2:OTRA_PROVINCIA_PAIS')]
    ]));
    return;
  }

  // P2
  if (data.startsWith('P2:')) {
    const val = data.split(':')[1];
    ws(id, { p2:val });
    if (val === 'CORRIENTES_CAPITAL') {
      ws(id, { step:'P3' });
      edit('🏙 Corrientes Capital\n\n¿Cuál es el motivo de la consulta?', kb([
        [btn('💓 Control Marcapasos','P3:CONTROL_MARCAPASOS')],
        [btn('🩺 Consulta Cardiológica','P3:CONSULTA_SIMPLE')]
      ]));
    } else {
      ws(id, { step:'P2_TEXT' });
      const label = val==='INTERIOR_PROVINCIA' ? '¿De qué localidad?' : '¿De qué provincia o país?';
      edit(`${val==='INTERIOR_PROVINCIA'?'🚜 Interior':'✈️ Otra provincia/país'}\n\n${label}\n_(escribí la respuesta)_`);
    }
    return;
  }

  // P3
  if (data.startsWith('P3:')) {
    const val = data.split(':')[1];
    ws(id, { p3:val });
    if (val === 'CONTROL_MARCAPASOS') {
      ws(id, { step:'NOMBRE' });
      edit('💓 Control Marcapasos\n\n¿Cuál es tu nombre completo?\n_(escribilo)_');
    } else {
      ws(id, { step:'P3_DERIVACION' });
      edit('🩺 Consulta Cardiológica\n\n¿Venís derivado por un colega?', kb([
        [btn('✅ Sí, vengo derivado','DERIVACION:SI')],
        [btn('❌ No','DERIVACION:NO')]
      ]));
    }
    return;
  }

  // Derivación
  if (data.startsWith('DERIVACION:')) {
    const val = data.split(':')[1];
    ws(id, { derivado: val==='SI' });
    if (val==='SI') {
      ws(id, { step:'P3_COLEGA' });
      edit('👨‍⚕️ ¿Cuál es el nombre del médico que te derivó?\n_(escribilo)_');
    } else {
      ws(id, { step:'NOMBRE' });
      edit('¿Cuál es tu nombre completo?\n_(escribilo)_');
    }
    return;
  }

  // Día calendario
  if (data === 'LLENO') {
    bot.answerCallbackQuery(query.id, { text:'⚠️ Ese día no tiene turnos.' }).catch(()=>{});
    return;
  }
  if (data.startsWith('DIA:')) {
    const fecha = data.split(':')[1];
    const slots = getSlotsLibres(fecha);
    if (!slots.length) {
      bot.answerCallbackQuery(query.id, { text:'⚠️ Sin turnos disponibles ese día.' }).catch(()=>{});
      return;
    }
    ws(id, { selectedFecha:fecha, step:'HORARIO' });
    const nombreDia = new Date(fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    const rows = slots.map(h => [btn(`🕐 ${h}hs`, `HORA:${h}`)]);
    rows.push([btn('↩️ Cambiar día','BACK:CALENDARIO')]);
    edit(`📅 *${nombreDia}*\n\nElegí el horario:`, kb(rows));
    return;
  }

  // Hora
  if (data.startsWith('HORA:')) {
    const hora = data.split(':').slice(1).join(':');
    ws(id, { selectedHora:hora, step:'CONFIRMACION' });
    const s = ss(id);
    const nombreDia = new Date(s.selectedFecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    const tipoLabel = s.p3==='CONTROL_MARCAPASOS'?'💓 Control Marcapasos':'🩺 Consulta Cardiológica';
    edit(`📋 *Resumen del turno:*\n\n${tipoLabel}\n📅 ${nombreDia}\n🕐 ${hora}hs\n👤 ${s.nombre}\n📱 ${s.telefono}\n\n¿Confirmás?`, kb([
      [btn('✅ Confirmar turno','CONFIRMAR:SI')],
      [btn('❌ Cancelar','CONFIRMAR:NO')]
    ]));
    return;
  }

  // Confirmar
  if (data.startsWith('CONFIRMAR:')) {
    const val = data.split(':')[1];
    if (val==='NO') { ds(id); edit('❌ Turno cancelado. Usá /start para empezar de nuevo.'); return; }
    const s = ss(id);
    edit('⏳ Guardando turno...');
    const res = saveTurno({
      chat_id:String(id), nombre:s.nombre, telefono:s.telefono,
      fecha:s.selectedFecha, hora:s.selectedHora, tipo:s.p3,
      p1:s.p1, p2:s.p2, p2_extra:s.p2Extra||'',
      derivado:s.derivado?1:0, nombre_colega:s.nombreColega||'', es_urgencia:0
    });
    const turnoId = res.lastInsertRowid;
    ds(id);
    const nombreDia = new Date(s.selectedFecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    const tipoLabel = s.p3==='CONTROL_MARCAPASOS'?'💓 Control Marcapasos':'🩺 Consulta Cardiológica';
    edit(`⏳ *Turno enviado \\#${turnoId}*\n\n${tipoLabel}\n📅 ${nombreDia}\n🕐 ${s.selectedHora}hs\n\nEl Dr\\. revisará y te confirmará a la brevedad\\.\nPara cancelar usá /cancelar`);
    // Google Calendar async
    crearEvento({ id:turnoId, ...s, fecha:s.selectedFecha, hora:s.selectedHora, tipo:s.p3, p2_extra:s.p2Extra||'' })
      .then(ev => { if (ev && ev.id) setTurnoGcalId(turnoId, ev.id); })
      .catch(()=>{});
    // Notificar admins con botones de gestión
    const origen = s.p2==='CORRIENTES_CAPITAL'?'Corrientes Capital':s.p2Extra||s.p2;
    const adminMsg = `🆕 *Nuevo turno \\#${turnoId}*\n\n${tipoLabel}\n📅 ${nombreDia}\n🕐 ${s.selectedHora}hs\n👤 ${s.nombre}\n📱 ${s.telefono}\n📍 ${origen}\n\n_Esperando confirmación_`;
    const adminKb = kb([
      [btn('✅ Confirmar','ADMIN_OK:'+turnoId+':'+id), btn('❌ Rechazar','ADMIN_REJ:'+turnoId+':'+id)],
      [btn('🔄 Reprogramar','ADMIN_REP:'+turnoId+':'+id)]
    ]);
    for (const adminId of ADMIN_IDS) {
      bot.sendMessage(adminId, adminMsg, { parse_mode:'MarkdownV2', ...adminKb }).catch(()=>{});
    }
    return;
  }

  // Cancelar turno
  if (data.startsWith('CANCELAR:')) {
    const turnoId = data.split(':')[1];
    if (turnoId==='NADA') { edit('↩️ Cancelación abortada.'); return; }
    const t = getTurnoById(parseInt(turnoId));
    if (!t || String(t.chat_id)!==String(id)) { edit('Turno no encontrado.'); return; }
    cancelarTurno(t.id);
    if (t.gcal_event_id) eliminarEvento(t.gcal_event_id).catch(()=>{});
    const f = new Date(t.fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    edit(`✅ Turno cancelado:\n📅 ${f} — ${t.hora}hs`);
    notify(`🔴 Turno cancelado:\n${formatTurno(t)}`);
    return;
  }

  // Volver al calendario
  if (data==='BACK:CALENDARIO') {
    ws(id, { step:'CALENDARIO', selectedFecha:null });
    bot.deleteMessage(id, msgId).catch(()=>{});
    mostrarCalendario(id);
    return;
  }

  // ── Gestión de turnos por admin ──────────────────────────────────────────

  if (data.startsWith('ADMIN_OK:')) {
    if (!isAdmin(id)) return;
    const [, turnoId, patientId] = data.split(':');
    const t = getTurnoById(parseInt(turnoId));
    if (!t) { edit('Turno no encontrado.'); return; }
    updateTurnoEstado(t.id, 'confirmado');
    const f = new Date(t.fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    const tipo = t.tipo==='CONTROL_MARCAPASOS'?'💓 Control Marcapasos':'🩺 Consulta Cardiológica';
    edit(`✅ *Turno \\#${turnoId} confirmado*\n\n${tipo}\n📅 ${f}\n🕐 ${t.hora}hs\n👤 ${t.nombre}`);
    bot.sendMessage(patientId,
      `✅ *Tu turno fue confirmado\\!*\n\n${tipo}\n📅 ${f}\n🕐 ${t.hora}hs\n\nTe esperamos en el consultorio\\.`,
      {parse_mode:'MarkdownV2'}
    ).catch(()=>{});
    return;
  }

  if (data.startsWith('ADMIN_REJ:')) {
    if (!isAdmin(id)) return;
    const [, turnoId, patientId] = data.split(':');
    const t = getTurnoById(parseInt(turnoId));
    if (!t) { edit('Turno no encontrado.'); return; }
    updateTurnoEstado(t.id, 'rechazado');
    if (t.gcal_event_id) eliminarEvento(t.gcal_event_id).catch(()=>{});
    const f = new Date(t.fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    ws(id, { step:'ADMIN_REJ_MOTIVO', rejTurnoId:turnoId, rejPatientId:patientId, rejFecha:f, rejHora:t.hora });
    edit(`❌ Turno #${turnoId} rechazado.\n\n¿Querés enviarle un motivo al paciente? _(escribilo o mandá "no")_`);
    return;
  }

  if (data.startsWith('ADMIN_REP:')) {
    if (!isAdmin(id)) return;
    const [, turnoId, patientId] = data.split(':');
    const t = getTurnoById(parseInt(turnoId));
    if (!t) { edit('Turno no encontrado.'); return; }
    ws(id, { step:'ADMIN_REP_DIA', repTurnoId:parseInt(turnoId), repPatientId:patientId });
    const dias = getProximosDias(6);
    const rows = dias.map(d => {
      const slots = getSlotsLibres(d.fecha);
      const label = slots.length ? `📅 ${d.nombre} (${slots.length})` : `❌ ${d.nombre} — lleno`;
      return [btn(label, slots.length ? `REPDIA:${d.fecha}` : 'LLENO')];
    });
    bot.deleteMessage(id, msgId).catch(()=>{});
    bot.sendMessage(id, `🔄 *Reprogramar turno \\#${turnoId}*\n\nElegí el nuevo día:`, {parse_mode:'MarkdownV2', ...kb(rows)});
    return;
  }

  if (data.startsWith('REPDIA:')) {
    if (!isAdmin(id)) return;
    const fecha = data.split(':')[1];
    const slots = getSlotsLibres(fecha);
    if (!slots.length) { bot.answerCallbackQuery(query.id,{text:'Sin turnos ese día.'}).catch(()=>{}); return; }
    ws(id, { ...session, repFecha:fecha });
    const nombreDia = new Date(fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    const rows = slots.map(h => [btn(`🕐 ${h}hs`, `REPHORA:${h}`)]);
    edit(`📅 *${nombreDia}*\n\nElegí el nuevo horario:`, kb(rows));
    return;
  }

  if (data.startsWith('REPHORA:')) {
    if (!isAdmin(id)) return;
    const hora = data.split(':').slice(1).join(':');
    const { repTurnoId, repPatientId, repFecha } = session;
    const t = getTurnoById(repTurnoId);
    if (!t) { edit('Turno no encontrado.'); return; }
    reprogramarTurno(repTurnoId, repFecha, hora);
    ds(id);
    const f = new Date(repFecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    const tipo = t.tipo==='CONTROL_MARCAPASOS'?'💓 Control Marcapasos':'🩺 Consulta Cardiológica';
    edit(`🔄 *Turno \\#${repTurnoId} reprogramado*\n\n${tipo}\n📅 ${f}\n🕐 ${hora}hs\n👤 ${t.nombre}`);
    // Notificar paciente
    bot.sendMessage(repPatientId,
      `🔄 *Tu turno fue reprogramado*\n\n${tipo}\n📅 ${f}\n🕐 ${hora}hs\n\nTe esperamos en el consultorio\\.`,
      {parse_mode:'MarkdownV2'}
    ).catch(()=>{});
    // Actualizar Google Calendar
    if (t.gcal_event_id) eliminarEvento(t.gcal_event_id).catch(()=>{});
    crearEvento({...t, fecha:repFecha, hora, id:repTurnoId, p2_extra:t.p2_extra||''})
      .then(ev => { if (ev?.id) setTurnoGcalId(repTurnoId, ev.id); })
      .catch(()=>{});
    return;
  }

  // Admin callbacks
  if (data==='ADMIN:PENDIENTES') {
    if (!isAdmin(id)) return;
    const pend = getTurnosPendientes();
    if (!pend.length) { edit('✅ Sin pendientes.'); return; }
    let txt = `⏳ *Pendientes de confirmación (${pend.length}):*\n\n`;
    for (const t of pend) {
      const f = new Date(t.fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'short',day:'numeric',month:'short'});
      txt += `• #${t.id} ${f} ${t.hora}hs — ${t.nombre||'?'} | ${t.telefono||'—'}\n`;
      txt += `  ${t.tipo==='CONTROL_MARCAPASOS'?'💓 Marcapasos':'🩺 Consulta'}${t.derivado?' (derivado)':''}\n\n`;
    }
    txt += 'Respondé cada turno con los botones que mandó el bot al recibirlo.';
    edit(txt);
    return;
  }
  if (data==='ADMIN:HOY') {
    if (!isAdmin(id)) return;
    const turnos = getTurnosHoy();
    if (!turnos.length) { edit('📭 Sin turnos hoy.'); return; }
    const txt = turnos.map((t,i)=>`${i+1}. ${t.hora}hs — ${t.nombre||'?'} | ${t.tipo==='CONTROL_MARCAPASOS'?'💓':'🩺'} | ${t.telefono||'—'}`).join('\n');
    edit(`📋 *Hoy (${new Date().toLocaleDateString('es-AR')}):*\n\n${txt}`);
    return;
  }
  if (data==='ADMIN:AGENDA') {
    if (!isAdmin(id)) return;
    const turnos = getProximosTurnos(7);
    if (!turnos.length) { edit('📭 Sin turnos próximos.'); return; }
    const grupos = {};
    for (const t of turnos) { if (!grupos[t.fecha]) grupos[t.fecha]=[]; grupos[t.fecha].push(t); }
    let txt = '';
    for (const [fecha,ts] of Object.entries(grupos)) {
      const d = new Date(fecha+'T12:00:00');
      txt += `\n*${d.toLocaleDateString('es-AR',{weekday:'short',day:'numeric',month:'short'})}*\n`;
      txt += ts.map(t=>`  ${t.hora}hs ${t.tipo==='CONTROL_MARCAPASOS'?'💓':'🩺'} ${t.nombre||'?'}`).join('\n');
    }
    edit(`📅 *Próximos 7 días:*\n${txt}`);
    return;
  }
  if (data==='ADMIN:BLOQUEAR') {
    if (!isAdmin(id)) return;
    ws(id, { step:'ADMIN_BLOQUEAR_FECHA' });
    edit('📅 ¿Qué fecha bloqueás? (AAAA-MM-DD)');
    return;
  }
  if (data==='ADMIN:CONFIG') {
    if (!isAdmin(id)) return;
    edit(`⚙️ *Config actual:*\n\n• Horario: ${getConfig('hora_inicio')}:00 — ${getConfig('hora_fin')}:00\n• Turnos/día: ${getConfig('turnos_por_dia')}\n• Urgencias: ${getConfig('cupos_urgencia')}`, kb([
      [btn('🕐 Hora inicio','CFG:hora_inicio'), btn('🕐 Hora fin','CFG:hora_fin')],
      [btn('📋 Turnos/día','CFG:turnos_por_dia'), btn('🚨 Urgencias','CFG:cupos_urgencia')]
    ]));
    return;
  }
  if (data==='ADMIN:AUTH') {
    if (!isAdmin(id)) return;
    const url = getAuthUrl();
    bot.sendMessage(id, '🔑 Abrí este link EN EL NAVEGADOR DE ESTA PC (Windows):', {reply_markup:{inline_keyboard:[[{text:'Autorizar Google Calendar',url}]]}});
    waitForCode(300000)
      .then(async code => { await exchangeCode(code); notify('✅ Google Calendar vinculado.'); })
      .catch(()=>{});
    return;
  }
  if (data.startsWith('CFG:')) {
    if (!isAdmin(id)) return;
    const key = data.split(':')[1];
    const labels = { hora_inicio:'hora de inicio (ej: 17)', hora_fin:'hora de fin (ej: 22)', turnos_por_dia:'turnos por día (ej: 5)', cupos_urgencia:'cupos de urgencia (ej: 2)' };
    ws(id, { step:'ADMIN_CONFIG_VALUE', configKey:key });
    edit(`✏️ Nuevo valor para *${labels[key]||key}*:`);
    return;
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

// ── WEB turno handlers ───────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const id = query.message.chat.id;
  const data = query.data;
  if (!data.startsWith('WEB_')) return;
  bot.answerCallbackQuery(query.id).catch(()=>{});
  if (!isAdmin(id)) return;
  const msgId = query.message.message_id;
  const edit = (text) => bot.editMessageText(text, { chat_id:id, message_id:msgId }).catch(()=>{});

  if (data.startsWith('WEB_OK:')) {
    const turnoId = parseInt(data.split(':')[1]);
    const t = getTurnoById(turnoId);
    if (!t) { edit('Turno no encontrado.'); return; }
    updateTurnoEstado(turnoId, 'confirmado');
    const f = new Date(t.fecha+'T12:00:00').toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});
    edit(`✅ Turno WEB #${turnoId} confirmado\n\n${t.tipo==='CONTROL_MARCAPASOS'?'Control Marcapasos':'Consulta'}\n📅 ${f}\n🕐 ${t.hora}hs\n👤 ${t.nombre}\n📱 ${t.telefono}\n\nContactar al paciente para notificarle.`);
    return;
  }

  if (data.startsWith('WEB_REJ:')) {
    const turnoId = parseInt(data.split(':')[1]);
    const t = getTurnoById(turnoId);
    if (!t) { edit('Turno no encontrado.'); return; }
    updateTurnoEstado(turnoId, 'rechazado');
    if (t.gcal_event_id) eliminarEvento(t.gcal_event_id).catch(()=>{});
    edit(`❌ Turno WEB #${turnoId} rechazado.\n👤 ${t.nombre} — 📱 ${t.telefono}\n\nAvisar al paciente.`);
    return;
  }

  if (data.startsWith('WEB_REP:')) {
    const turnoId = parseInt(data.split(':')[1]);
    const t = getTurnoById(turnoId);
    if (!t) { edit('Turno no encontrado.'); return; }
    ws(id, { step:'ADMIN_REP_DIA', repTurnoId:turnoId, repPatientId:'WEB' });
    const dias = getProximosDias(6);
    const rows = dias.map(d => {
      const slots = getSlotsLibres(d.fecha);
      return [btn(slots.length ? `📅 ${d.nombre} (${slots.length})` : `❌ ${d.nombre} — lleno`, slots.length ? `REPDIA:${d.fecha}` : 'LLENO')];
    });
    bot.deleteMessage(id, msgId).catch(()=>{});
    bot.sendMessage(id, `🔄 Reprogramar turno WEB #${turnoId} - ${t.nombre}\n\nElegí el nuevo día:`, kb(rows));
    return;
  }
});

// ── HTTP API ─────────────────────────────────────────────────────────────────
startHttpServer(bot, ADMIN_IDS);

// ── Registro en Cloudflare Worker (si configurado) ───────────────────────────
(async () => {
  const workerUrl = process.env.WORKER_URL;
  const workerSecret = process.env.WORKER_SECRET;
  const tunnelUrl = process.env.TUNNEL_URL;
  if (workerUrl && tunnelUrl) {
    try {
      const https = require('https');
      const body = JSON.stringify({ botUrl: tunnelUrl, secret: workerSecret || '' });
      const url = new URL(workerUrl + '/register');
      const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, () => {
        console.log('Worker registrado:', tunnelUrl);
        notify(`🌐 Bot API online: ${tunnelUrl}`).catch(()=>{});
      });
      req.on('error', () => {});
      req.write(body); req.end();
    } catch {}
  }
})();

bot.on('polling_error', (err) => console.error('POLLING ERR:', err.code, err.message));

// ── Sync desde Google Calendar ────────────────────────────────────────────────
async function syncCalendar(tag) {
  const token = getConfig('google_refresh_token') || process.env.GOOGLE_REFRESH_TOKEN || '';
  if (!token) return;
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const hasta = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    const eventos = await listarEventos(hoy, hasta);
    importarDesdeCalendar(eventos, hoy, hasta);
    console.log(`GCal sync [${tag}]: ${eventos.length} eventos`);
  } catch (e) {
    console.error(`GCal sync error [${tag}]:`, e.message);
  }
}
syncCalendar('startup');
setInterval(() => syncCalendar('periodic'), 5 * 60 * 1000);

console.log('🏥 Bot Dr. Pantich activo — admins:', ADMIN_IDS);
notify('🟢 Bot iniciado').catch(()=>{});
