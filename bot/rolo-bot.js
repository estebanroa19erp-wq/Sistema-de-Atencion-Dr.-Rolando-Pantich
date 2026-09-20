require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const {
  getConfig, setConfig,
  getSession, saveSession, deleteSession,
  saveTurno, setTurnoGcalId,
  getTurnosByChatId, cancelarTurno, getTurnoById,
  getProximosTurnos, getTurnosHoy,
  isSlotBloqueado, bloquearSlot, desbloquearSlot,
  getTurnosCountByFecha, getUrgenciasCountHoy
} = require('./db');
const { getAuthUrl, waitForCode, exchangeCode, crearEvento, eliminarEvento } = require('./calendar');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('BOT_TOKEN faltante en .env'); process.exit(1); }

const ADMIN_ID = process.env.ADMIN_CHAT_ID || getConfig('admin_chat_id') || '';
const bot = new Telegraf(BOT_TOKEN);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAdmin(ctx) {
  return ADMIN_ID && String(ctx.from.id) === String(ADMIN_ID);
}

function ss(ctx) {
  return getSession(ctx.from.id) || {};
}

function ws(ctx, state) {
  saveSession(ctx.from.id, { ...ss(ctx), ...state });
}

function ds(ctx) {
  deleteSession(ctx.from.id);
}

// Genera próximos N días hábiles (martes=2, jueves=4) a partir de hoy
function getProximosDias(n) {
  const raw = getConfig('dias_atencion');
  const dias = JSON.parse(raw || '[2,4]');
  const result = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let d = new Date(today);
  d.setDate(d.getDate() + 1); // empezar mañana
  while (result.length < n) {
    if (dias.includes(d.getDay())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      result.push({
        fecha: `${yyyy}-${mm}-${dd}`,
        nombre: d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })
      });
    }
    d.setDate(d.getDate() + 1);
  }
  return result;
}

// Horarios disponibles para un día dado
function getSlotsDisponibles(fecha) {
  const horaInicio = parseInt(getConfig('hora_inicio') || '17');
  const horaFin = parseInt(getConfig('hora_fin') || '22');
  const maxTurnos = parseInt(getConfig('turnos_por_dia') || '5');
  const slots = [];
  for (let h = horaInicio; h < horaFin; h++) {
    const hora = `${String(h).padStart(2, '0')}:00`;
    if (!isSlotBloqueado(fecha, hora)) slots.push(hora);
  }
  const ocupados = getTurnosCountByFecha(fecha);
  const libres = slots.filter((_, i) => i < maxTurnos);
  return libres.filter((h) => {
    return !isSlotBloqueado(fecha, h);
  }).slice(0, Math.max(0, maxTurnos - ocupados + slots.length));

  // Simpler: return all slots not already booked
}

function getSlotsLibres(fecha) {
  const horaInicio = parseInt(getConfig('hora_inicio') || '17');
  const horaFin = parseInt(getConfig('hora_fin') || '22');
  const maxTurnos = parseInt(getConfig('turnos_por_dia') || '5');
  const { db } = require('./db');
  const ocupadas = db.prepare("SELECT hora FROM turnos WHERE fecha = ? AND estado != 'cancelado' AND es_urgencia = 0").all(fecha).map(r => r.hora);
  const slots = [];
  for (let h = horaInicio; h < horaFin; h++) {
    const hora = `${String(h).padStart(2, '0')}:00`;
    if (!ocupadas.includes(hora) && !isSlotBloqueado(fecha, hora)) slots.push(hora);
  }
  return slots.slice(0, maxTurnos);
}

function formatTurno(t) {
  const tipoLabel = t.tipo === 'CONTROL_MARCAPASOS' ? '💓 Control Marcapasos' : '🩺 Consulta';
  const fecha = new Date(t.fecha + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  return `${tipoLabel}\n📅 ${fecha}\n🕐 ${t.hora}hs\n👤 ${t.nombre || 'Sin nombre'}\n📱 ${t.telefono || '—'}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// ─── Flujo paciente ──────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  ds(ctx);
  ws(ctx, { step: 'P1' });
  await ctx.reply(
    `👋 Bienvenido al sistema de turnos del *Dr. Rolando Pantich*\n_Cardiólogo_\n\n📅 Atención: Martes y Jueves de 17 a 22hs\n\n¿Es la *primera vez* que se atiende con el Doctor?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✨ Sí, es la primera vez', 'P1:SI_PRIMERA_VEZ')],
        [Markup.button.callback('📋 No, ya soy paciente del Dr.', 'P1:NO_YA_ATENDIDO')]
      ])
    }
  );
});

bot.command('cancelar', async (ctx) => {
  ds(ctx);
  const turnos = getTurnosByChatId(ctx.from.id);
  if (!turnos.length) return ctx.reply('No tenés turnos pendientes.');
  const btns = turnos.map(t => {
    const fecha = new Date(t.fecha + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
    return [Markup.button.callback(`❌ ${fecha} ${t.hora}hs - ${t.tipo === 'CONTROL_MARCAPASOS' ? 'Marcapasos' : 'Consulta'}`, `CANCELAR:${t.id}`)];
  });
  btns.push([Markup.button.callback('↩️ Volver', 'CANCELAR:NADA')]);
  await ctx.reply('¿Cuál turno querés cancelar?', Markup.inlineKeyboard(btns));
});

bot.command('mis_turnos', async (ctx) => {
  const turnos = getTurnosByChatId(ctx.from.id);
  if (!turnos.length) return ctx.reply('No tenés turnos pendientes.\n\nUsá /start para agendar uno.');
  const txt = turnos.map(t => formatTurno(t)).join('\n\n─────────────────\n\n');
  await ctx.reply(`📋 *Tus turnos:*\n\n${txt}`, { parse_mode: 'Markdown' });
});

bot.command('ayuda', async (ctx) => {
  await ctx.reply(
    `*Comandos disponibles:*\n\n/start — Agendar turno\n/mis\\_turnos — Ver mis turnos\n/cancelar — Cancelar un turno\n/ayuda — Este mensaje`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Callbacks flujo ────────────────────────────────────────────────────────

bot.action(/^P1:(.+)$/, async (ctx) => {
  const val = ctx.match[1];
  ws(ctx, { p1: val, step: 'P2' });
  await ctx.editMessageText(
    `${val === 'SI_PRIMERA_VEZ' ? '✨ Primera vez — ¡Bienvenido!' : '📋 Paciente existente'}\n\n¿De dónde es usted?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🏙 Corrientes Capital', 'P2:CORRIENTES_CAPITAL')],
      [Markup.button.callback('🚜 Interior de la Provincia', 'P2:INTERIOR_PROVINCIA')],
      [Markup.button.callback('✈️ Otra provincia / país', 'P2:OTRA_PROVINCIA_PAIS')]
    ])
  );
});

bot.action(/^P2:(.+)$/, async (ctx) => {
  const val = ctx.match[1];
  ws(ctx, { p2: val });
  if (val === 'CORRIENTES_CAPITAL') {
    ws(ctx, { step: 'P3' });
    await ctx.editMessageText(
      '🏙 Corrientes Capital\n\n¿Cuál es el motivo de la consulta?',
      Markup.inlineKeyboard([
        [Markup.button.callback('💓 Control Marcapasos', 'P3:CONTROL_MARCAPASOS')],
        [Markup.button.callback('🩺 Consulta Cardiológica', 'P3:CONSULTA_SIMPLE')]
      ])
    );
  } else {
    ws(ctx, { step: 'P2_TEXT' });
    const label = val === 'INTERIOR_PROVINCIA' ? '¿De qué localidad?' : '¿De qué provincia o país?';
    await ctx.editMessageText(`${val === 'INTERIOR_PROVINCIA' ? '🚜 Interior de la Provincia' : '✈️ Otra provincia/país'}\n\n${label}\n\n_(Escribí la respuesta)_`, { parse_mode: 'Markdown' });
  }
});

bot.action(/^P3:(.+)$/, async (ctx) => {
  const val = ctx.match[1];
  ws(ctx, { p3: val });
  if (val === 'CONTROL_MARCAPASOS') {
    ws(ctx, { step: 'NOMBRE' });
    await ctx.editMessageText('💓 Control Marcapasos\n\n¿Cuál es tu nombre completo?\n\n_(Escribilo)_', { parse_mode: 'Markdown' });
  } else {
    ws(ctx, { step: 'P3_DERIVACION' });
    await ctx.editMessageText(
      '🩺 Consulta Cardiológica\n\n¿Venís derivado por un colega?',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Sí, vengo derivado', 'DERIVACION:SI')],
        [Markup.button.callback('❌ No', 'DERIVACION:NO')]
      ])
    );
  }
});

bot.action(/^DERIVACION:(.+)$/, async (ctx) => {
  const val = ctx.match[1];
  ws(ctx, { derivado: val === 'SI' });
  if (val === 'SI') {
    ws(ctx, { step: 'P3_COLEGA' });
    await ctx.editMessageText('👨‍⚕️ ¿Cuál es el nombre del médico que te derivó?\n\n_(Escribí el nombre)_', { parse_mode: 'Markdown' });
  } else {
    ws(ctx, { step: 'NOMBRE' });
    await ctx.editMessageText('¿Cuál es tu nombre completo?\n\n_(Escribilo)_', { parse_mode: 'Markdown' });
  }
});

bot.action(/^CANCELAR:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  if (id === 'NADA') return ctx.editMessageText('↩️ Cancelación abortada.');
  const t = getTurnoById(parseInt(id));
  if (!t || String(t.chat_id) !== String(ctx.from.id)) return ctx.editMessageText('Turno no encontrado.');
  cancelarTurno(t.id);
  if (t.gcal_event_id) await eliminarEvento(t.gcal_event_id).catch(() => {});
  const fecha = new Date(t.fecha + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  await ctx.editMessageText(`✅ Turno cancelado:\n📅 ${fecha} — ${t.hora}hs`);
  if (ADMIN_ID) {
    await bot.telegram.sendMessage(ADMIN_ID, `🔴 Turno cancelado:\n${formatTurno(t)}`).catch(() => {});
  }
});

// Selección de día del calendario
bot.action(/^DIA:(.+)$/, async (ctx) => {
  const fecha = ctx.match[1];
  const slots = getSlotsLibres(fecha);
  if (!slots.length) {
    ws(ctx, { step: 'CALENDARIO' });
    return ctx.answerCbQuery('⚠️ Ese día no tiene turnos disponibles. Elegí otro.');
  }
  ws(ctx, { selectedFecha: fecha, step: 'HORARIO' });
  const d = new Date(fecha + 'T12:00:00');
  const nombreDia = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const btns = slots.map(h => [Markup.button.callback(`🕐 ${h}hs`, `HORA:${h}`)]);
  btns.push([Markup.button.callback('↩️ Cambiar día', 'BACK:CALENDARIO')]);
  await ctx.editMessageText(`📅 *${nombreDia}*\n\nElegí el horario:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.action(/^HORA:(.+)$/, async (ctx) => {
  const hora = ctx.match[1];
  const session = ss(ctx);
  ws(ctx, { selectedHora: hora, step: 'CONFIRMACION' });
  const d = new Date(session.selectedFecha + 'T12:00:00');
  const nombreDia = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const tipoLabel = session.p3 === 'CONTROL_MARCAPASOS' ? '💓 Control Marcapasos' : '🩺 Consulta Cardiológica';
  await ctx.editMessageText(
    `📋 *Resumen del turno:*\n\n${tipoLabel}\n📅 ${nombreDia}\n🕐 ${hora}hs\n👤 ${session.nombre}\n📱 ${session.telefono}\n\n¿Confirmás?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirmar turno', 'CONFIRMAR:SI')],
        [Markup.button.callback('❌ Cancelar', 'CONFIRMAR:NO')]
      ])
    }
  );
});

bot.action(/^CONFIRMAR:(.+)$/, async (ctx) => {
  const val = ctx.match[1];
  if (val === 'NO') {
    ds(ctx);
    return ctx.editMessageText('❌ Turno cancelado. Usá /start para comenzar de nuevo.');
  }
  const session = ss(ctx);
  await ctx.editMessageText('⏳ Guardando turno...');
  const res = saveTurno({
    chat_id: String(ctx.from.id),
    nombre: session.nombre,
    telefono: session.telefono,
    fecha: session.selectedFecha,
    hora: session.selectedHora,
    tipo: session.p3,
    p1: session.p1,
    p2: session.p2,
    p2_extra: session.p2Extra || '',
    derivado: session.derivado ? 1 : 0,
    nombre_colega: session.nombreColega || '',
    es_urgencia: 0
  });
  const turnoId = res.lastInsertRowid;
  ds(ctx);
  const d = new Date(session.selectedFecha + 'T12:00:00');
  const nombreDia = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const tipoLabel = session.p3 === 'CONTROL_MARCAPASOS' ? '💓 Control Marcapasos' : '🩺 Consulta Cardiológica';
  await ctx.editMessageText(
    `✅ *Turno confirmado #${turnoId}*\n\n${tipoLabel}\n📅 ${nombreDia}\n🕐 ${session.selectedHora}hs\n\nTe esperamos en el consultorio.\nPara cancelar usá /cancelar`,
    { parse_mode: 'Markdown' }
  );
  // Google Calendar
  const turnoData = { id: turnoId, ...session, fecha: session.selectedFecha, hora: session.selectedHora, tipo: session.p3, p2_extra: session.p2Extra || '' };
  crearEvento(turnoData).then(ev => {
    if (ev && ev.id) setTurnoGcalId(turnoId, ev.id);
  }).catch(() => {});
  // Notificar al Dr.
  if (ADMIN_ID) {
    const msg = `🆕 *Nuevo turno #${turnoId}*\n\n${tipoLabel}\n📅 ${nombreDia}\n🕐 ${session.selectedHora}hs\n👤 ${session.nombre}\n📱 ${session.telefono}\n📍 ${session.p2 === 'CORRIENTES_CAPITAL' ? 'Corrientes Capital' : session.p2Extra}`;
    await bot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  }
});

bot.action('BACK:CALENDARIO', async (ctx) => {
  const session = ss(ctx);
  ws(ctx, { step: 'CALENDARIO', selectedFecha: null });
  await mostrarCalendario(ctx, session);
});

// ─── Manejo de texto ─────────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const session = ss(ctx);
  const text = ctx.message.text.trim();
  if (!session.step) return;

  // Admin: código OAuth
  if (session.step === 'ADMIN_AUTH_CODE' && isAdmin(ctx)) {
    try {
      const tokens = await exchangeCode(text);
      ds(ctx);
      await ctx.reply('✅ Google Calendar vinculado correctamente.');
    } catch (e) {
      await ctx.reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  // Admin: bloquear slot
  if (session.step === 'ADMIN_BLOQUEAR_FECHA' && isAdmin(ctx)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ctx.reply('Formato inválido. Usá AAAA-MM-DD');
    ws(ctx, { step: 'ADMIN_BLOQUEAR_HORA', bloquearFecha: text });
    return ctx.reply(`Fecha: ${text}\n¿Qué hora bloqueás? (ej: 18:00)`);
  }

  if (session.step === 'ADMIN_BLOQUEAR_HORA' && isAdmin(ctx)) {
    if (!/^\d{2}:\d{2}$/.test(text)) return ctx.reply('Formato inválido. Usá HH:MM');
    bloquearSlot(session.bloquearFecha, text, 'admin');
    ds(ctx);
    return ctx.reply(`✅ Slot ${session.bloquearFecha} ${text}hs bloqueado.`);
  }

  if (session.step === 'ADMIN_CONFIG_VALUE' && isAdmin(ctx)) {
    setConfig(session.configKey, text);
    ds(ctx);
    return ctx.reply(`✅ Configuración guardada: ${session.configKey} = ${text}`);
  }

  // Flujo paciente
  switch (session.step) {
    case 'P2_TEXT': {
      ws(ctx, { p2Extra: text, step: 'P3' });
      await ctx.reply(
        '¿Cuál es el motivo de la consulta?',
        Markup.inlineKeyboard([
          [Markup.button.callback('💓 Control Marcapasos', 'P3:CONTROL_MARCAPASOS')],
          [Markup.button.callback('🩺 Consulta Cardiológica', 'P3:CONSULTA_SIMPLE')]
        ])
      );
      break;
    }
    case 'P3_COLEGA': {
      ws(ctx, { nombreColega: text, step: 'NOMBRE' });
      await ctx.reply('¿Cuál es tu nombre completo?\n_(Escribilo)_', { parse_mode: 'Markdown' });
      break;
    }
    case 'NOMBRE': {
      ws(ctx, { nombre: text, step: 'TELEFONO' });
      await ctx.reply('¿Cuál es tu número de teléfono (WhatsApp)?\n_(Escribilo con código de área, ej: 3794123456)_', { parse_mode: 'Markdown' });
      break;
    }
    case 'TELEFONO': {
      ws(ctx, { telefono: text, step: 'CALENDARIO' });
      await mostrarCalendario(ctx, { ...session, telefono: text });
      break;
    }
    default:
      break;
  }
});

async function mostrarCalendario(ctx, session) {
  const dias = getProximosDias(6);
  const btns = dias.map(d => {
    const slots = getSlotsLibres(d.fecha);
    const label = slots.length ? `📅 ${d.nombre} (${slots.length} turnos)` : `❌ ${d.nombre} — sin turnos`;
    return [Markup.button.callback(label, slots.length ? `DIA:${d.fecha}` : 'DIA_LLENO')];
  });
  const method = ctx.callbackQuery ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
  await method('📅 *Seleccioná un día:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
}

bot.action('DIA_LLENO', async (ctx) => {
  await ctx.answerCbQuery('⚠️ Ese día no tiene turnos disponibles.');
});

// ─── Comandos Admin ───────────────────────────────────────────────────────────

function adminOnly(fn) {
  return async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Acceso denegado.');
    return fn(ctx);
  };
}

bot.command('hoy', adminOnly(async (ctx) => {
  const turnos = getTurnosHoy();
  if (!turnos.length) return ctx.reply('📭 Sin turnos hoy.');
  const txt = turnos.map((t, i) => `${i + 1}. ${t.hora}hs — ${t.nombre || '?'} | ${t.tipo === 'CONTROL_MARCAPASOS' ? '💓' : '🩺'} | ${t.telefono || '—'}${t.es_urgencia ? ' 🚨' : ''}`).join('\n');
  await ctx.reply(`📋 *Turnos de hoy (${new Date().toLocaleDateString('es-AR')}):*\n\n${txt}`, { parse_mode: 'Markdown' });
}));

bot.command('agenda', adminOnly(async (ctx) => {
  const args = ctx.message.text.split(' ');
  const dias = parseInt(args[1]) || 7;
  const turnos = getProximosTurnos(dias);
  if (!turnos.length) return ctx.reply(`📭 Sin turnos en los próximos ${dias} días.`);
  const grupos = {};
  for (const t of turnos) {
    if (!grupos[t.fecha]) grupos[t.fecha] = [];
    grupos[t.fecha].push(t);
  }
  let txt = '';
  for (const [fecha, ts] of Object.entries(grupos)) {
    const d = new Date(fecha + 'T12:00:00');
    const label = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'short' });
    txt += `\n*${label}*\n`;
    txt += ts.map(t => `  • ${t.hora}hs ${t.tipo === 'CONTROL_MARCAPASOS' ? '💓' : '🩺'} ${t.nombre || '?'} (${t.telefono || '—'})`).join('\n');
    txt += '\n';
  }
  await ctx.reply(`📅 *Agenda — próximos ${dias} días:*\n${txt}`, { parse_mode: 'Markdown' });
}));

bot.command('bloquear', adminOnly(async (ctx) => {
  ws(ctx, { step: 'ADMIN_BLOQUEAR_FECHA' });
  await ctx.reply('📅 ¿Qué fecha bloqueás?\nFormato: AAAA-MM-DD\n(Ej: 2025-09-23)');
}));

bot.command('desbloquear', adminOnly(async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Uso: /desbloquear AAAA-MM-DD HH:MM');
  desbloquearSlot(args[1], args[2]);
  await ctx.reply(`✅ Slot ${args[1]} ${args[2]}hs desbloqueado.`);
}));

bot.command('auth', adminOnly(async (ctx) => {
  const url = getAuthUrl();
  await ctx.reply(
    `🔑 *Vincular Google Calendar*\n\n1. Abrí este enlace en tu navegador:\n${url}\n\n2. Autorizá el acceso\n3. El sistema se autoriza automáticamente via callback local`,
    { parse_mode: 'Markdown' }
  );
  waitForCode(300000)
    .then(async (code) => {
      await exchangeCode(code);
      await ctx.reply('✅ Google Calendar vinculado correctamente.');
    })
    .catch(() => {});
}));

bot.command('config', adminOnly(async (ctx) => {
  await ctx.reply(
    `⚙️ *Configuración*\n\nValores actuales:\n• Días atención: ${getConfig('dias_atencion')} (2=Mar, 4=Jue)\n• Horario: ${getConfig('hora_inicio')}:00 — ${getConfig('hora_fin')}:00\n• Turnos/día: ${getConfig('turnos_por_dia')}\n• Cupos urgencia: ${getConfig('cupos_urgencia')}\n• Calendar ID: ${getConfig('google_calendar_id')}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🕐 Hora inicio', 'CFG:hora_inicio'), Markup.button.callback('🕐 Hora fin', 'CFG:hora_fin')],
        [Markup.button.callback('📅 Turnos/día', 'CFG:turnos_por_dia'), Markup.button.callback('🚨 Cupos urgencia', 'CFG:cupos_urgencia')],
        [Markup.button.callback('📆 Calendar ID', 'CFG:google_calendar_id')]
      ])
    }
  );
}));

bot.action(/^CFG:(.+)$/, adminOnly(async (ctx) => {
  const key = ctx.match[1];
  const labels = {
    hora_inicio: 'hora de inicio (ej: 17)',
    hora_fin: 'hora de fin (ej: 22)',
    turnos_por_dia: 'cantidad de turnos por día (ej: 5)',
    cupos_urgencia: 'cupos de urgencia por día (ej: 2)',
    google_calendar_id: 'ID del calendario (ej: primary o email@gmail.com)'
  };
  ws(ctx, { step: 'ADMIN_CONFIG_VALUE', configKey: key });
  await ctx.editMessageText(`✏️ Ingresá el nuevo valor para *${labels[key] || key}*:`, { parse_mode: 'Markdown' });
}));

bot.command('admin', adminOnly(async (ctx) => {
  await ctx.reply(
    `👨‍⚕️ *Panel Dr. Pantich*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Hoy', 'ADMIN:HOY'), Markup.button.callback('📅 Agenda 7 días', 'ADMIN:AGENDA')],
        [Markup.button.callback('🔒 Bloquear slot', 'ADMIN:BLOQUEAR'), Markup.button.callback('⚙️ Config', 'ADMIN:CONFIG')],
        [Markup.button.callback('🔑 Vincular Calendar', 'ADMIN:AUTH')]
      ])
    }
  );
}));

bot.action('ADMIN:HOY', adminOnly(async (ctx) => {
  const turnos = getTurnosHoy();
  if (!turnos.length) return ctx.editMessageText('📭 Sin turnos hoy.');
  const txt = turnos.map((t, i) => `${i + 1}. ${t.hora}hs — ${t.nombre || '?'} | ${t.tipo === 'CONTROL_MARCAPASOS' ? '💓' : '🩺'} | ${t.telefono || '—'}${t.es_urgencia ? ' 🚨' : ''}`).join('\n');
  await ctx.editMessageText(`📋 *Hoy (${new Date().toLocaleDateString('es-AR')}):*\n\n${txt}`, { parse_mode: 'Markdown' });
}));

bot.action('ADMIN:AGENDA', adminOnly(async (ctx) => {
  const turnos = getProximosTurnos(7);
  if (!turnos.length) return ctx.editMessageText('📭 Sin turnos próximos.');
  const grupos = {};
  for (const t of turnos) { if (!grupos[t.fecha]) grupos[t.fecha] = []; grupos[t.fecha].push(t); }
  let txt = '';
  for (const [fecha, ts] of Object.entries(grupos)) {
    const d = new Date(fecha + 'T12:00:00');
    txt += `\n*${d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })}*\n`;
    txt += ts.map(t => `  ${t.hora}hs ${t.tipo === 'CONTROL_MARCAPASOS' ? '💓' : '🩺'} ${t.nombre || '?'}`).join('\n');
  }
  await ctx.editMessageText(`📅 *Próximos 7 días:*\n${txt}`, { parse_mode: 'Markdown' });
}));

bot.action('ADMIN:BLOQUEAR', adminOnly(async (ctx) => {
  ws(ctx, { step: 'ADMIN_BLOQUEAR_FECHA' });
  await ctx.editMessageText('📅 ¿Qué fecha bloqueás? (formato AAAA-MM-DD)');
}));

bot.action('ADMIN:CONFIG', adminOnly(async (ctx) => {
  await ctx.editMessageText(
    `⚙️ *Configuración actual:*\n\n• Horario: ${getConfig('hora_inicio')}:00 — ${getConfig('hora_fin')}:00\n• Turnos/día: ${getConfig('turnos_por_dia')}\n• Cupos urgencia: ${getConfig('cupos_urgencia')}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🕐 Hora inicio', 'CFG:hora_inicio'), Markup.button.callback('🕐 Hora fin', 'CFG:hora_fin')],
        [Markup.button.callback('📋 Turnos/día', 'CFG:turnos_por_dia'), Markup.button.callback('🚨 Urgencias', 'CFG:cupos_urgencia')]
      ])
    }
  );
}));

bot.action('ADMIN:AUTH', adminOnly(async (ctx) => {
  const url = getAuthUrl();
  await ctx.editMessageText(`🔑 Abrí este enlace en el navegador del servidor:\n\n${url}\n\nEl sistema captura el código automáticamente.`);
  waitForCode(300000)
    .then(async (code) => {
      await exchangeCode(code);
      await bot.telegram.sendMessage(ADMIN_ID, '✅ Google Calendar vinculado.').catch(() => {});
    })
    .catch(() => {});
}));

// ─── Launch ──────────────────────────────────────────────────────────────────

bot.launch().then(() => {
  console.log('🏥 Bot Dr. Pantich activo');
  if (ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, '🟢 Bot iniciado').catch(() => {});
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
