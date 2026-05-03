const http = require('http');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Bot Online');
  res.end();
}).listen(process.env.PORT || 8080, '0.0.0.0');

let sessioni = {};
let modalitaTest = {};

function caricaConfig() {
  const dati = fs.readFileSync('aziende.json', 'utf8');
  return JSON.parse(dati);
}

function getAzienda() {
  const config = caricaConfig();
  return config.default;
}

function getTesto(azienda, chiave, fallback = '') {
  return azienda.messaggi?.[chiave] || fallback;
}

function getRispostaKeyword(azienda, messaggio) {
  const testo = messaggio.toLowerCase().trim();
  const keywords = azienda.keywords || [];

  return keywords.find(item =>
    item.parole.some(parola => testo.includes(parola.toLowerCase()))
  );
}

function isAperto(sender, azienda) {
  if (modalitaTest[sender]) return true;

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

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', update => {
    const { connection, qr } = update;

    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'open') {
      console.log('\n🚀 BOT ASSISTENZA OPERATIVO!');
    }

    if (connection === 'close') {
      connectToWhatsApp();
    }
  });

  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.remoteJid.endsWith('@g.us')) return;

    const azienda = getAzienda();

    const from = msg.key.remoteJid;
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const isMe = msg.key.fromMe;

    const fondatori = azienda.fondatori || [];
    const isFondatore = fondatori.includes(from);

    if (isFondatore && body.toLowerCase() === azienda.comandi?.test) {
      modalitaTest[from] = true;
      return await sock.sendMessage(from, {
        text: getTesto(azienda, 'test_attivato', 'Modalità test attivata.')
      });
    }

    if (isFondatore && body.toLowerCase() === azienda.comandi?.stop_test) {
      delete modalitaTest[from];
      delete sessioni[from];

      return await sock.sendMessage(from, {
        text: getTesto(azienda, 'test_disattivato', 'Modalità test disattivata.')
      });
    }

    if (isMe) {
      if (sessioni[from]?.stato === 'attesa_operatore') {
        clearTimeout(sessioni[from].timer);
        delete sessioni[from];

        await sock.sendMessage(from, {
          text: getTesto(azienda, 'operatore_connesso')
        });
      }
      return;
    }

    if (!sessioni[from]) {
      if (!isAperto(from, azienda)) {
        return await sock.sendMessage(from, {
          text: getTesto(azienda, 'chiuso') + '\n\n' + (azienda.orari?.testo || '')
        });
      }

      await sock.sendMessage(from, {
        text: getTesto(azienda, 'benvenuto')
      });

      await delay(azienda.tempi?.delay_ticket || 3000);

      await sock.sendMessage(from, {
        text: getTesto(azienda, 'ticket_aperto')
      });

      await delay(azienda.tempi?.delay_menu || 2000);

      await sock.sendMessage(from, {
        text: getTesto(azienda, 'menu')
      });

      sessioni[from] = { stato: 'menu_principale' };
      return;
    }

    if (sessioni[from].stato === 'menu_principale') {
      const rispostaKeyword = getRispostaKeyword(azienda, body);

      if (rispostaKeyword) {
        return await sock.sendMessage(from, {
          text: rispostaKeyword.risposta
        });
      }

      const opzioni = azienda.opzioni || {};

      if (opzioni[body]) {
        const scelta = opzioni[body];

        await sock.sendMessage(from, {
          text: scelta.messaggio
        });

        sessioni[from].stato = scelta.prossimo_stato;
        return;
      }

      await sock.sendMessage(from, {
        text: getTesto(azienda, 'scelta_non_valida')
      });

      return;
    }

    if (sessioni[from].stato === 'attesa_domanda') {
      const rispostaKeyword = getRispostaKeyword(azienda, body);

      if (rispostaKeyword) {
        return await sock.sendMessage(from, {
          text: rispostaKeyword.risposta
        });
      }

      await sock.sendMessage(from, {
        text: getTesto(azienda, 'non_ho_capito')
      });

      avviaAttesaOperatore(from, sock, azienda);
      return;
    }

    if (sessioni[from].stato === 'attesa_prenotazione') {
      await sock.sendMessage(from, {
        text: getTesto(azienda, 'prenotazione_registrata')
      });

      const admin = azienda.numero_admin;

      if (admin) {
        await sock.sendMessage(admin, {
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

      delete sessioni[from];
      return;
    }

    if (sessioni[from].stato === 'attesa_nome_operatore') {
      await sock.sendMessage(from, {
        text: getTesto(azienda, 'connessione_operatore')
      });

      const admin = azienda.numero_admin;

      if (admin) {
        await sock.sendMessage(admin, {
          text:
            getTesto(azienda, 'notifica_operatore_titolo', '👤 *RICHIESTA OPERATORE*') +
            '\nNome: ' + body +
            '\nContatto: ' + from
        });
      }

      avviaAttesaOperatore(from, sock, azienda);
      return;
    }
  });

  function avviaAttesaOperatore(from, sock, azienda) {
    sessioni[from].stato = 'attesa_operatore';

    sessioni[from].timer = setTimeout(async () => {
      if (sessioni[from]?.stato === 'attesa_operatore') {
        await sock.sendMessage(from, {
          text: getTesto(azienda, 'operatore_non_disponibile')
        });

        avviaAttesaOperatore(from, sock, azienda);
      }
    }, azienda.tempi?.attesa_operatore || 120000);
  }
}

connectToWhatsApp();