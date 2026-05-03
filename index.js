const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');

const PORT = process.env.PORT || 8080;

let sessioni = {};
let modalitaTest = {};
let sockets = {};
let ultimiQR = {};
let statiConnessione = {};

function caricaConfig() {
  if (!fs.existsSync('aziende.json')) {
    fs.writeFileSync('aziende.json', JSON.stringify({ default: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync('aziende.json', 'utf8'));
}

function salvaConfig(config) {
  fs.writeFileSync('aziende.json', JSON.stringify(config, null, 2));
}

function pulisciId(id) {
  return String(id || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

function getAzienda(aziendaId = 'default') {
  const config = caricaConfig();
  return config[aziendaId] || config.default;
}

function getTesto(azienda, chiave, fallback = '') {
  return azienda.messaggi?.[chiave] || fallback;
}

function getRispostaKeyword(azienda, messaggio) {
  const testo = messaggio.toLowerCase().trim();
  const keywords = azienda.keywords || [];

  return keywords.find(item =>
    item.parole?.some(parola => testo.includes(parola.toLowerCase()))
  );
}

function isAperto(sender, azienda, sessionKey) {
  if (modalitaTest[sessionKey]) return true;
  if (!azienda.orari?.attivi) return true;

  const oraAttuale = new Date();
  const giorno = oraAttuale.getDay();
  const oraMinuti = oraAttuale.getHours() * 100 + oraAttuale.getMinutes();

  const slotGiorno = azienda.orari.giorni?.[giorno];
  if (!slotGiorno) return false;

  return slotGiorno.some(slot => {
    const inizio = parseInt(slot.s.replace(':', ''));
    const fine = parseInt(slot.e.replace(':', ''));
    return oraMinuti >= inizio && oraMinuti <= fine;
  });
}

function leggiBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function connectToWhatsApp(aziendaId = 'default') {
  aziendaId = pulisciId(aziendaId);

  if (sockets[aziendaId]) {
    return sockets[aziendaId];
  }

  const sessionPath = path.join('sessions', aziendaId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sockets[aziendaId] = sock;
  statiConnessione[aziendaId] = 'connessione_in_corso';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, qr } = update;

    if (qr) {
      ultimiQR[aziendaId] = await QRCode.toDataURL(qr);
      qrcodeTerminal.generate(qr, { small: true });
      statiConnessione[aziendaId] = 'qr_pronto';
    }

    if (connection === 'open') {
      statiConnessione[aziendaId] = 'connesso';
      ultimiQR[aziendaId] = null;
      console.log(`🚀 BOT OPERATIVO PER AZIENDA: ${aziendaId}`);
    }

    if (connection === 'close') {
      statiConnessione[aziendaId] = 'disconnesso';
      delete sockets[aziendaId];

      setTimeout(() => {
        connectToWhatsApp(aziendaId);
      }, 3000);
    }
  });

  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.remoteJid.endsWith('@g.us')) return;

    const azienda = getAzienda(aziendaId);

    const from = msg.key.remoteJid;
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const isMe = msg.key.fromMe;

    const chatKey = `${aziendaId}:${from}`;
    const fondatori = azienda.fondatori || [];
    const isFondatore = fondatori.includes(from);

    if (isFondatore && body.toLowerCase() === azienda.comandi?.test) {
      modalitaTest[chatKey] = true;
      return await sock.sendMessage(from, {
        text: getTesto(azienda, 'test_attivato', 'Modalità test attivata.')
      });
    }

    if (isFondatore && body.toLowerCase() === azienda.comandi?.stop_test) {
      delete modalitaTest[chatKey];
      delete sessioni[chatKey];

      return await sock.sendMessage(from, {
        text: getTesto(azienda, 'test_disattivato', 'Modalità test disattivata.')
      });
    }

    if (isMe) {
      if (sessioni[chatKey]?.stato === 'attesa_operatore') {
        clearTimeout(sessioni[chatKey].timer);
        delete sessioni[chatKey];

        await sock.sendMessage(from, {
          text: getTesto(azienda, 'operatore_connesso')
        });
      }
      return;
    }

    if (!sessioni[chatKey]) {
      if (!isAperto(from, azienda, chatKey)) {
        return await sock.sendMessage(from, {
          text: getTesto(azienda, 'chiuso') + '\n\n' + (azienda.orari?.testo || '')
        });
      }

      await sock.sendMessage(from, { text: getTesto(azienda, 'benvenuto') });
      await delay(azienda.tempi?.delay_ticket || 3000);

      await sock.sendMessage(from, { text: getTesto(azienda, 'ticket_aperto') });
      await delay(azienda.tempi?.delay_menu || 2000);

      await sock.sendMessage(from, { text: getTesto(azienda, 'menu') });

      sessioni[chatKey] = { stato: 'menu_principale' };
      return;
    }

    if (sessioni[chatKey].stato === 'menu_principale') {
      const rispostaKeyword = getRispostaKeyword(azienda, body);

      if (rispostaKeyword) {
        return await sock.sendMessage(from, { text: rispostaKeyword.risposta });
      }

      const opzioni = azienda.opzioni || {};

      if (opzioni[body]) {
        const scelta = opzioni[body];

        await sock.sendMessage(from, { text: scelta.messaggio });
        sessioni[chatKey].stato = scelta.prossimo_stato;
        return;
      }

      await sock.sendMessage(from, { text: getTesto(azienda, 'scelta_non_valida') });
      return;
    }

    if (sessioni[chatKey].stato === 'attesa_domanda') {
      const rispostaKeyword = getRispostaKeyword(azienda, body);

      if (rispostaKeyword) {
        return await sock.sendMessage(from, { text: rispostaKeyword.risposta });
      }

      await sock.sendMessage(from, { text: getTesto(azienda, 'non_ho_capito') });
      avviaAttesaOperatore(chatKey, from, sock, azienda);
      return;
    }

    if (sessioni[chatKey].stato === 'attesa_prenotazione') {
      await sock.sendMessage(from, {
        text: getTesto(azienda, 'prenotazione_registrata')
      });

      if (azienda.numero_admin) {
        await sock.sendMessage(azienda.numero_admin, {
          text:
            getTesto(azienda, 'notifica_prenotazione_titolo', '📅 *NUOVA PRENOTAZIONE*') +
            '\nUtente: ' + from +
            '\nInfo: ' + body
        });
      }

      await delay(azienda.tempi?.delay_chiusura || 2000);

      await sock.sendMessage(from, {
        text: getTesto(azienda, 'chiusura_finale')
      });

      delete sessioni[chatKey];
      return;
    }

    if (sessioni[chatKey].stato === 'attesa_nome_operatore') {
      await sock.sendMessage(from, {
        text: getTesto(azienda, 'connessione_operatore')
      });

      if (azienda.numero_admin) {
        await sock.sendMessage(azienda.numero_admin, {
          text:
            getTesto(azienda, 'notifica_operatore_titolo', '👤 *RICHIESTA OPERATORE*') +
            '\nNome: ' + body +
            '\nContatto: ' + from
        });
      }

      avviaAttesaOperatore(chatKey, from, sock, azienda);
      return;
    }
  });

  function avviaAttesaOperatore(chatKey, from, sock, azienda) {
    sessioni[chatKey].stato = 'attesa_operatore';

    sessioni[chatKey].timer = setTimeout(async () => {
      if (sessioni[chatKey]?.stato === 'attesa_operatore') {
        await sock.sendMessage(from, {
          text: getTesto(azienda, 'operatore_non_disponibile')
        });

        avviaAttesaOperatore(chatKey, from, sock, azienda);
      }
    }, azienda.tempi?.attesa_operatore || 120000);
  }

  return sock;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  try {
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'online' }));
    }

    if (req.method === 'POST' && pathname === '/api/azienda') {
      const body = await leggiBody(req);

      const aziendaId = pulisciId(body.aziendaId || body.nome_azienda);
      const config = caricaConfig();

      config[aziendaId] = body.config || body;

      salvaConfig(config);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        aziendaId
      }));
    }

if (req.method === 'GET' && pathname.startsWith('/api/stato/')) {
  const aziendaId = pulisciId(pathname.split('/').pop());

  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    aziendaId,
    stato: statiConnessione[aziendaId] || 'non_avviato'
  }));
}

if (req.method === 'GET' && pathname.startsWith('/qr-view/')) {
  const aziendaId = pulisciId(pathname.split('/').pop());

  await connectToWhatsApp(aziendaId);

  const qr = ultimiQR[aziendaId];

  res.writeHead(200, { 'Content-Type': 'text/html' });

  return res.end(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>QR WhatsApp - ${aziendaId}</title>
      </head>
      <body style="background:#0b1020;color:white;font-family:Arial;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;">
        <h1>Scansiona il QR WhatsApp</h1>
        <p>Azienda: ${aziendaId}</p>
        ${qr ? `<img src="${qr}" style="background:white;padding:20px;border-radius:20px;width:280px;height:280px;" />` : `<p>QR non ancora pronto. Ricarica tra 2 secondi.</p>`}
      </body>
    </html>
  `);
}

res.writeHead(404, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ error: 'endpoint_non_trovato' }));

  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'errore_server',
      message: error.message
    }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 API attiva su porta ${PORT}`);
});

//connectToWhatsApp('default');