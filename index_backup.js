const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.write('Bot Online');
  res.end();
}).listen(process.env.PORT || 8080, '0.0.0.0');
const { default: makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');

let sessioni = {}; 
let modalitaTest = {}; // Per gestire il bypass dell'orario per i fondatori
let numeriAdmin = {};
function caricaConfigAzienda() {
    const dati = fs.readFileSync('aziende.json', 'utf8');
    return JSON.parse(dati);
}
const MIO_NUMERO = '393791304280@s.whatsapp.net';
const FONDATORI = ['393791304280@s.whatsapp.net', '390683423876@s.whatsapp.net'];

const orariApertura = {
    1: [{ s: '14:30', e: '20:00' }], // Lun
    2: [{ s: '16:40', e: '18:00' }, { s: '20:00', e: '20:35' }], // Mar
    3: [{ s: '14:30', e: '20:00' }], // Mer
    4: [{ s: '16:35', e: '18:00' }, { s: '20:00', e: '20:40' }], // Gio
    5: [{ s: '14:20', e: '21:30' }], // Ven
    6: [{ s: '07:00', e: '13:30' }, { s: '16:00', e: '19:30' }], // Sab
    0: [{ s: '08:00', e: '12:00' }]  // Dom
};

function isAperto(sender) {
    // Se il fondatore ha attivato il test, per lui è sempre "aperto"
    if (modalitaTest[sender]) return true;

    const oraAttuale = new Date();
    const giorno = oraAttuale.getDay();
    const oraMinuti = oraAttuale.getHours() * 100 + oraAttuale.getMinutes();
    if (!orariApertura[giorno]) return false;
    return orariApertura[giorno].some(slot => {
        const inizio = parseInt(slot.s.replace(':', ''));
        const fine = parseInt(slot.e.replace(':', ''));
        return oraMinuti >= inizio && oraMinuti <= fine;
    });
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'open') console.log('\n🚀 BOT ASSISTENZA OPERATIVO!');
        if (connection === 'close') connectToWhatsApp();
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid.endsWith('@g.us')) return;

        const from = msg.key.remoteJid;
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const isMe = msg.key.fromMe;
        const isFondatore = FONDATORI.includes(from);

        // --- GESTIONE COMANDI TEST (SOLO FONDATORI) ---
        if (isFondatore && body.toLowerCase() === 'test') {
            modalitaTest[from] = true;
            return await sock.sendMessage(from, { text: '🛠 Modalità TEST attivata. Ora puoi testare il bot anche fuori orario.' });
        }
        if (isFondatore && body.toLowerCase() === '.stoptest') {
            delete modalitaTest[from];
            delete sessioni[from];
            return await sock.sendMessage(from, { text: '🔒 Modalità TEST disattivata. Il bot seguirà gli orari normali.' });
        }

        if (isMe) {
            if (sessioni[from]?.stato === 'attesa_operatore') {
                clearTimeout(sessioni[from].timer);
                delete sessioni[from];
                await sock.sendMessage(from, { text: 'UN OPERATORE SI È CONNESSO ALLA CHAT!💬🟢✅' });
            }
            return;
        }

        const chiusuraFinale = async () => {
            await delay(2000);
            await sock.sendMessage(from, { text: 'Arrivederci!\nGrazie per aver usufruito dei nostri servizi! A presto!\n\nTicket numero 10759264, puoi tracciarlo qui:\nhttps://base44.app' });
        };

        if (!sessioni[from]) {
            if (!isAperto(from)) {
                return await sock.sendMessage(from, { text: "Ci dispiace ma siamo chiusi, ci ricontatti, questi sono i nostri orari:\nLun: 14:30-20:00\nMar: 16:40-18:00 / 20:00-20:35\nMer: 14:30-20:00\nGio: 16:35-18:00 / 20:00-20:40\nVen: 14:20-21:30\nSab: 07:00-13:30 / 16:00-19:30\nDom: 08:00-12:00" });
            }
const config = caricaConfigAzienda();

await sock.sendMessage(from, { 
  text: config.default.messaggio_benvenuto 
});
            await delay(10000);
            await sock.sendMessage(from, { text: 'Ticket aperto!\nIl tuo numero di ticket è\n*10759264*.\nPuoi tracciare il tuo ticket qui: https://base44.app\n\nOra possiamo continuare….' });
            await delay(4000);
            await sock.sendMessage(from, { text: 'Ciao!\nAdesso scegli tra queste opzioni cosa fare qui:\n1- Parla con me e posso risolverti alcuni problemi!\n2- Prenota una chiamata telefonica!\n3- Prova a parlare con un operatore!' });
            sessioni[from] = { stato: 'menu_principale' };
            return;
        }

        if (sessioni[from].stato === 'menu_principale') {
            if (body === '1') {
                await sock.sendMessage(from, { text: 'Perfetto!\nCome posso aiutarti?' });
                sessioni[from].stato = 'attesa_domanda_op1';
            } else if (body === '2') {
                await sock.sendMessage(from, { text: 'Perfetto!\nOra dimmi la data e l orario della chiamata, se prenoti una chiamata non potrai annullarla con il chatbot!' });
                sessioni[from].stato = 'attesa_prenotazione';
            } else if (body === '3') {
                await sock.sendMessage(from, { text: 'Perfetto!\nTi sto connettendo ad un operatore\nma prima forniscici il tuo Nome ed il tuo Cognome Grazie!' });
                sessioni[from].stato = 'attesa_nome_op3';
            }
        } else if (sessioni[from].stato === 'attesa_domanda_op1') {
            await sock.sendMessage(from, { text: 'Mi dispiace ma non ho capito! Ti connetto subito ad un operatore.' });
            avviaAttesaOperatore(from, sock);
        } else if (sessioni[from].stato === 'attesa_prenotazione') {
            await sock.sendMessage(from, { text: 'Ok perfetto ho registrato la tua prenotazione!' });
     const config = caricaConfigAzienda();
const admin = config.default.numero_admin || MIO_NUMERO;
await sock.sendMessage(admin, { text: '📅 *NUOVA PRENOTAZIONE*\nUtente: ' + from + '\nInfo: ' + body });
            await chiusuraFinale();
            delete sessioni[from];
        } else if (sessioni[from].stato === 'attesa_nome_op3') {
            await sock.sendMessage(from, { text: 'Grazie!\nTi stiamo connettendo ad un operatore!\nIl tempo medio di attesa è di 3 minuti!\nAttendi qui grazie!' });
       const admin = numeriAdmin[from] || MIO_NUMERO;
await sock.sendMessage(admin, { text: '👤 *RICHIESTA OPERATORE*\nNome: ' + body + '\nContatto: ' + from });
            avviaAttesaOperatore(from, sock);
        }
    });

    function avviaAttesaOperatore(from, sock) {
        sessioni[from].stato = 'attesa_operatore';
        sessioni[from].timer = setTimeout(async () => {
            if (sessioni[from]?.stato === 'attesa_operatore') {
                await sock.sendMessage(from, { text: 'Mi dispiace ma ora Non ci sono operatori disponibili😭\nProva ad attendere ancora qui o se Non puoi ti contatteremo dopo grazie!🔴' });
                avviaAttesaOperatore(from, sock);
            }
        }, 120000);
    }
}
connectToWhatsApp();
