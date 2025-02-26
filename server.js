// server.js (corregido)

// Elimina la sesión antigua para forzar un nuevo inicio
const fs = require('fs');
const path = require('path');
const authPath = path.join(__dirname, '.wwebjs_auth');
if (fs.existsSync(authPath)) {
  fs.rmSync(authPath, { recursive: true, force: true });
  console.log('Sesión anterior eliminada.');
}

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = require('socket.io')(server);

// Configuración: URL del webhook (puedes definirla en Railway como variable de entorno)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://primary-production-bbfb.up.railway.app/webhook-test/1fae31d9-74e6-4d10-becb-4043413f0a49';

let client;
let currentQR = null;
let isReady = false;

// Almacenamiento en memoria de chats: Map<chatId, { name, isGroup, messages: [] }>
const chats = new Map();

// Función para aplicar mapeo (si se configura) en la respuesta de un webhook de prueba
function applyMapping(data, mapping) {
  const result = {};
  for (const key in mapping) {
    const path = mapping[key].split('.');
    let value = data;
    for (const p of path) {
      if (value && p in value) {
        value = value[p];
      } else {
        value = undefined;
        break;
      }
    }
    result[key] = value;
  }
  return result;
}

function initializeWhatsAppClient() {
  // Configuración de Puppeteer para entornos como Railway (sin sandbox)
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--single-process',
        '--disable-dev-shm-usage', // Mejora la estabilidad en entornos con poca memoria
        '--disable-accelerated-2d-canvas',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      executablePath: '/usr/bin/google-chrome-stable', // Ruta común en Railway para Chrome
      ignoreHTTPSErrors: true, // Ignora errores de HTTPS para conexiones más estables
      timeout: 60000, // Aumenta el tiempo de espera para conexiones lentas
    }
  });

  // Cuando se genera el QR, se convierte a Data URL y se envía a los clientes vía Socket.IO
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
    try {
      const chatList = await client.getChats();
      for (const chat of chatList) {
        const chatId = chat.id._serialized;
        const name = chat.name || chat.id.user || 'Chat sin nombre';
        const isGroup = chat.isGroup;
        if (!chats.has(chatId)) {
          chats.set(chatId, { name, isGroup, messages: [] });
        }
        // Intenta cargar el historial antiguo de mensajes (hasta 50) con un pequeño retraso
        setTimeout(async () => {
          try {
            const olderMessages = await chat.fetchMessages({ limit: 50 });
            const chatData = chats.get(chatId);
            olderMessages.forEach(m => {
              const senderId = m.fromMe ? 'me' : (m.author || m.from);
              chatData.messages.push({
                sender: senderId,
                message: m.body,
                timestamp: m.timestamp * 1000,
                fromMe: m.fromMe ? 1 : 0
              });
            });
            // (Opcional) Notifica a los clientes que el historial se actualizó
            io.emit('new_message', { chatId, message: "Historial actualizado" });
          } catch (err) {
            console.error('Error al fetchMessages en chat:', chatId, err.message);
          }
        }, 5000);
      }
      io.emit('chats', Array.from(chats.entries()).map(([chatId, data]) => ({
        id: chatId,
        name: data.name,
        isGroup: data.isGroup ? 1 : 0
      })));
    } catch (err) {
      console.error('Error al cargar chats iniciales:', err);
    }
  });

  // Al recibir un mensaje (entrante)
  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const senderId = msg.author || msg.from;
    const messageText = msg.body;
    const timestamp = msg.timestamp * 1000;
    if (!chats.has(chatId)) {
      try {
        const chatObj = await msg.getChat();
        const chatName = chatObj.name || chatObj.id.user || 'Chat sin nombre';
        chats.set(chatId, { name: chatName, isGroup: chatObj.isGroup, messages: [] });
      } catch (err) {
        console.error('Error creando chat en memoria:', err);
      }
    }
    const chatData = chats.get(chatId);
    const newMsg = { sender: senderId, message: messageText, timestamp, fromMe: 0 };
    chatData.messages.push(newMsg);
    io.emit('new_message', { chatId, message: newMsg });
    // Envía el webhook al recibir un mensaje
    if (N8N_WEBHOOK_URL) {
      try {
        await axios.get(N8N_WEBHOOK_URL, {
          params: {
            phone: msg.from,
            message: messageText,
            timestamp: timestamp
          }
        });
      } catch (error) {
        console.error('Error enviando webhook a n8n (recibido):', error.message);
      }
    }
  });

  // Al enviar un mensaje (saliente)
  client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    const chatId = msg.to;
    const senderId = 'me';
    const messageText = msg.body;
    const timestamp = msg.timestamp * 1000;
    if (!chats.has(chatId)) {
      try {
        const chatObj = await msg.getChat();
        const chatName = chatObj.name || chatObj.id.user || 'Chat sin nombre';
        chats.set(chatId, { name: chatName, isGroup: chatObj.isGroup, messages: [] });
      } catch (err) {
        console.error('Error creando chat en memoria:', err);
      }
    }
    const chatData = chats.get(chatId);
    const newMsg = { sender: senderId, message: messageText, timestamp, fromMe: 1 };
    chatData.messages.push(newMsg);
    io.emit('new_message', { chatId, message: newMsg });
    // Envía el webhook al enviar un mensaje
    if (N8N_WEBHOOK_URL) {
      try {
        await axios.get(N8N_WEBHOOK_URL, {
          params: {
            phone: msg.to,
            message: messageText,
            timestamp: timestamp
          }
        });
      } catch (error) {
        console.error('Error enviando webhook a n8n (enviado):', error.message);
      }
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

// Endpoint para obtener el QR
app.get('/api/qr', (req, res) => {
  if (isReady) return res.json({ authenticated: true });
  res.json({ qr: currentQR });
});

// Endpoint para obtener la lista de chats
app.get('/api/chats', (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp no conectado' });
  const chatArray = [];
  for (const [chatId, data] of chats.entries()) {
    chatArray.push({ id: chatId, name: data.name, isGroup: data.isGroup ? 1 : 0 });
  }
  res.json(chatArray);
});

// Endpoint para obtener el historial de mensajes de un chat
app.get('/api/chat/:chatId', (req, res) => {
  const chatId = req.params.chatId;
  if (!chats.has(chatId)) return res.json([]);
  const chatData = chats.get(chatId);
  const sortedMessages = chatData.messages.slice().sort((a, b) => a.timestamp - b.timestamp);
  res.json(sortedMessages);
});

// Endpoint para enviar un mensaje (para uso externo)
app.post('/api/send', async (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId y message requeridos' });
  if (!isReady) return res.status(503).json({ error: 'Cliente de WhatsApp no está listo' });
  let targetChatId = chatId;
  if (!targetChatId.endsWith('@c.us') && !targetChatId.endsWith('@g.us')) {
    targetChatId += targetChatId.includes('-') ? '@g.us' : '@c.us';
  }
  try {
    await client.sendMessage(targetChatId, message);
    res.json({ status: 'success', chatId: targetChatId });
  } catch (error) {
    console.error("Error en /api/send:", error.message);
    res.status(500).json({ error: 'No se pudo enviar el mensaje', details: error.message });
  }
});

// Endpoint para desconectar
app.post('/api/disconnect', async (req, res) => {
  if (!isReady) return res.json({ status: 'already_disconnected' });
  try {
    await client.logout();
  } catch (err) {
    return res.status(500).json({ error: 'Error al desconectar' });
  }
  try {
    await client.destroy();
  } catch (err) {
    console.error('Error al destruir cliente:', err.message);
  }
  isReady = false;
  currentQR = null;
  initializeWhatsAppClient();
  res.json({ status: 'disconnected' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${PORT}`);
});