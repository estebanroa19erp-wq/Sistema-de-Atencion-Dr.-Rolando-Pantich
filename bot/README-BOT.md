# Bot Telegram — Dr. Rolando Pantich

Bot de turnos que replica el flujo del sistema web vía Telegram, con Google Calendar OAuth real.

## Instalación

```bash
cd bot
npm install
cp .env.example .env
# Editar .env con los tokens reales
node rolo-bot.js
```

## Configuración paso a paso

### 1. Crear bot en Telegram
1. Hablar con @BotFather en Telegram
2. `/newbot` → elegir nombre y username
3. Copiar el token → `BOT_TOKEN` en `.env`

### 2. Obtener tu ADMIN_CHAT_ID
1. Hablar con @userinfobot en Telegram
2. Copiar el "Id" → `ADMIN_CHAT_ID` en `.env`

### 3. Crear credenciales Google Calendar
1. Ir a https://console.cloud.google.com
2. Crear proyecto (o usar uno existente)
3. APIs y servicios → Biblioteca → buscar "Google Calendar API" → Activar
4. APIs y servicios → Credenciales → Crear credencial → ID de cliente OAuth 2.0
5. Tipo de aplicación: **Aplicación de escritorio**
6. Copiar Client ID y Client Secret → `.env`

### 4. Vincular el calendario
1. Iniciar el bot (`node rolo-bot.js`)
2. Enviar `/auth` al bot (solo funciona con tu ADMIN_CHAT_ID)
3. Abrir el link en el navegador del mismo equipo donde corre el bot
4. Autorizar acceso → el bot confirma automáticamente

## Comandos — Pacientes

| Comando | Función |
|---------|---------|
| `/start` | Iniciar flujo de turno |
| `/mis_turnos` | Ver mis turnos pendientes |
| `/cancelar` | Cancelar un turno |
| `/ayuda` | Lista de comandos |

## Comandos — Admin (solo Dr. Rolo)

| Comando | Función |
|---------|---------|
| `/admin` | Panel de control con botones |
| `/hoy` | Ver turnos de hoy |
| `/agenda [dias]` | Ver agenda (default 7 días) |
| `/bloquear` | Bloquear un slot por fecha/hora |
| `/desbloquear FECHA HORA` | Desbloquear slot (ej: `/desbloquear 2025-09-23 18:00`) |
| `/config` | Configurar horarios, turnos/día, etc. |
| `/auth` | Vincular/renovar Google Calendar |

## Base de datos

SQLite local: `bot/rolo-turnos.db`

Tablas:
- `turnos` — todos los turnos registrados
- `slots_bloqueados` — slots bloqueados por el admin
- `config` — configuración editable desde Telegram
- `sessions` — estado de conversaciones activas

## Ejecutar como servicio (LaunchAgent macOS)

Crear `~/Library/LaunchAgents/com.pantich.rolobot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pantich.rolobot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ruta/al/repo/bot/rolo-bot.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/ruta/al/repo/bot</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_TOKEN</key>
    <string>TU_TOKEN</string>
    <key>ADMIN_CHAT_ID</key>
    <string>TU_CHAT_ID</string>
    <key>GOOGLE_CLIENT_ID</key>
    <string>TU_CLIENT_ID</string>
    <key>GOOGLE_CLIENT_SECRET</key>
    <string>TU_CLIENT_SECRET</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/rolobot.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/rolobot-err.log</string>
</dict>
</plist>
```
