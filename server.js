const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const http = require('http');
require('dotenv').config(); // Cargar variables de entorno
const puppeteer = require('puppeteer'); // Asegurar que Puppeteer esté bien integrado

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = require('socket.io')(server);

let client;
let currentQR = null;
let isReady = false;

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://primary-production-bbfb.up.railway.app/webhook-test/1fae31d9-74e6-4d10-becb-4043413f0a49';

// Almacenamiento en memoria: Map<chatId, { name, isGroup, messages: [] }>
const chats = new Map();

async function initializeWhatsAppClient() {
    client = new Client({ authStrategy: new LocalAuth() });

    client.on('qr', (qr) => {
        qrcode.toDataURL(qr, (err, url) => {
            currentQR = err ? null : url;
            isReady = false;
            console.log('QR generado. Escanéalo para iniciar sesión.');
            io.emit('qr', { qr: currentQR });
        });
    });

    client.on('authenticated', () => {
        console.log('WhatsApp autenticado.');
    });

    client.on('ready', async () => {
        console.log('Cliente WhatsApp listo.');
        isReady = true;
        currentQR = null;
        io.emit('ready', { authenticated: true });

        // Lanzar Puppeteer correctamente en Railway
        try {
            const browser = await puppeteer.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            console.log('Puppeteer se inició correctamente en Railway.');
            await browser.close();
        } catch (error) {
            console.error('Error iniciando Puppeteer:', error.message);
        }
    });

    client.on('disconnected', (reason) => {
        console.log('WhatsApp desconectado:', reason);
        isReady = false;
        initializeWhatsAppClient();
    });

    client.initialize();
}

initializeWhatsAppClient();

server.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
