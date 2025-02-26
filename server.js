// server.js - Multi-dispositivo para Railway

// Elimina sesiones antiguas (opcional, para forzar inicio limpio)
const fs = require('fs');
const path = require('path');
const authFiles = fs.readdirSync(__dirname).filter(file => file.startsWith('.wwebjs_auth_'));
authFiles.forEach(file => {
  const fullPath = path.join(__dirname, file);
  fs.rmSync(fullPath, { recursive: true, force: true });
  console.log(`Sesión eliminada: ${file}`);
});

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

// Objeto global para almacenar dispositivos
const devices = {};  // key: deviceId, value: { client, currentQR, isReady, chats (Map) }

// Configuración del webhook (usa GET)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://primary-production-bbfb.up.railway.app/webhook-test/1fae31d9-74e6-4d10-becb-4043413f0a49';

// Función para aplicar mapeo (para el endpoint de prueba de webhook)
function applyMapping(data, mapping) {
  const result = {};
  for (const key in mapping) {
    const pathArr = mapping[key].split('.');
    let value = data;
    for (const p of pathArr) {
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

// Función para inicializar un dispositivo nuevo
function initializeDevice(deviceId) {
  const device = {
    client: null,
    currentQR: null,
    isReady: false,
    chats: new Map()
  };

  device.client = new Client({
    authStrategy: new LocalAuth({ dataPath: `.wwebjs_auth_${deviceId}` }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--single-process'
      ]
    }
  });

  device.client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      device.currentQR = err ? null : url;
      device.isReady = false;
      console.log(`[${deviceId}] QR generado.`);
      io.to(deviceId).emit('qr', { qr: device.currentQR });
    });
  });

  device.client.on('authenticated', () => {
    console.log(`[${deviceId}] WhatsApp autenticado.`);
  });

  device.client.on('ready', async () => {
    console.log(`[${deviceId}] Cliente WhatsApp listo.`);
    device.isReady = true;
    device.currentQR = null;
    io.to(deviceId).emit('ready', { authenticated: true });
    try {
      const chatList = await device.client.getChats();
      for (const chat of chatList) {
        const chatId = chat.id._serialized;
        const name = chat.name || chat.id.user || 'Chat sin nombre';
        const isGroup = chat.isGroup;
        if (!device.chats.has(chatId)) {
          device.chats.set(chatId, { name, isGroup, messages: [] });
        }
        // Cargar historial antiguo (hasta 50 mensajes) con un retraso para evitar errores
        setTimeout(async () => {
          try {
            const olderMessages = await chat.fetchMessages({ limit: 50 });
            const chatData = device.chats.get(chatId);
            olderMessages.forEach(m => {
              const senderId = m.fromMe ? 'me' : (m.author || m.from);
              chatData.messages.push({
                sender: senderId,
                message: m.body,
                timestamp: m.timestamp * 1000,
                fromMe: m.fromMe ? 1 : 0
              });
            });
            io.to(deviceId).emit('chatsUpdated');
          } catch (err) {
            console.error(`[${deviceId}] Error al fetchMessages en chat: ${chatId}`, err.message);
          }
        }, 5000);
      }
      io.to(deviceId).emit('chats', Array.from(device.chats.entries()).map(([chatId, data]) => ({
        id: chatId,
        name: data.name,
        isGroup: data.isGroup ? 1 : 0
      })));
    } catch (err) {
      console.error(`[${deviceId}] Error al cargar chats iniciales:`, err);
    }
  });

  // Al recibir un mensaje (entrante)
  device.client.on('message', async (msg) => {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const senderId = msg.author || msg.from;
    const messageText = msg.body;
    const timestamp = msg.timestamp * 1000;
    if (!device.chats.has(chatId)) {
      try {
        const chatObj = await msg.getChat();
        const chatName = chatObj.name || chatObj.id.user || 'Chat sin nombre';
        device.chats.set(chatId, { name: chatName, isGroup: chatObj.isGroup, messages: [] });
      } catch (err) {
        console.error(`[${deviceId}] Error creando chat en memoria:`, err);
      }
    }
    const chatData = device.chats.get(chatId);
    const newMsg = { sender: senderId, message: messageText, timestamp, fromMe: 0 };
    chatData.messages.push(newMsg);
    io.to(deviceId).emit('new_message', { chatId, message: newMsg });
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
        console.error(`[${deviceId}] Error enviando webhook a n8n (recibido):`, error.message);
      }
    }
  });

  // Al enviar un mensaje (saliente)
  device.client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    const chatId = msg.to;
    const messageText = msg.body;
    const timestamp = msg.timestamp * 1000;
    if (!device.chats.has(chatId)) {
      try {
        const chatObj = await msg.getChat();
        const chatName = chatObj.name || chatObj.id.user || 'Chat sin nombre';
        device.chats.set(chatId, { name: chatName, isGroup: chatObj.isGroup, messages: [] });
      } catch (err) {
        console.error(`[${deviceId}] Error creando chat en memoria:`, err);
      }
    }
    const chatData = device.chats.get(chatId);
    const newMsg = { sender: 'me', message: messageText, timestamp, fromMe: 1 };
    chatData.messages.push(newMsg);
    io.to(deviceId).emit('new_message', { chatId, message: newMsg });
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
        console.error(`[${deviceId}] Error enviando webhook a n8n (enviado):`, error.message);
      }
    }
  });

  device.client.on('disconnected', (reason) => {
    console.log(`[${deviceId}] WhatsApp desconectado:`, reason);
    device.isReady = false;
    io.to(deviceId).emit('disconnected');
  });

  device.client.initialize();
  return device;
}

// Endpoint para crear un nuevo dispositivo
app.post('/api/device/new', (req, res) => {
  const deviceId = Date.now().toString(); // Genera un ID simple basado en timestamp
  const device = initializeDevice(deviceId);
  devices[deviceId] = device;
  res.json({ deviceId });
});

// Endpoint para obtener el QR de un dispositivo
app.get('/api/device/:deviceId/qr', (req, res) => {
  const { deviceId } = req.params;
  const device = devices[deviceId];
  if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  if (device.isReady) return res.json({ authenticated: true });
  res.json({ qr: device.currentQR });
});

// Endpoint para obtener la lista de chats de un dispositivo
app.get('/api/device/:deviceId/chats', (req, res) => {
  const { deviceId } = req.params;
  const device = devices[deviceId];
  if (!device || !device.isReady) return res.status(503).json({ error: 'Dispositivo no conectado' });
  const chatArray = [];
  for (const [chatId, data] of device.chats.entries()) {
    chatArray.push({ id: chatId, name: data.name, isGroup: data.isGroup ? 1 : 0 });
  }
  res.json(chatArray);
});

// Endpoint para obtener el historial de mensajes de un chat de un dispositivo
app.get('/api/device/:deviceId/chat/:chatId', (req, res) => {
  const { deviceId, chatId } = req.params;
  const device = devices[deviceId];
  if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  if (!device.chats.has(chatId)) return res.json([]);
  const chatData = device.chats.get(chatId);
  const sortedMessages = chatData.messages.slice().sort((a, b) => a.timestamp - b.timestamp);
  res.json(sortedMessages);
});

// Endpoint para enviar un mensaje desde un dispositivo (para uso externo)
app.post('/api/device/:deviceId/send', async (req, res) => {
  const { deviceId } = req.params;
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId y message requeridos' });
  const device = devices[deviceId];
  if (!device || !device.isReady) return res.status(503).json({ error: 'Dispositivo no conectado' });
  let targetChatId = chatId;
  if (!targetChatId.endsWith('@c.us') && !targetChatId.endsWith('@g.us')) {
    targetChatId += targetChatId.includes('-') ? '@g.us' : '@c.us';
  }
  try {
    await device.client.sendMessage(targetChatId, message);
    res.json({ status: 'success', chatId: targetChatId });
  } catch (error) {
    console.error(`Error en /api/device/${deviceId}/send:`, error.message);
    res.status(500).json({ error: 'No se pudo enviar el mensaje', details: error.message });
  }
});

// Endpoint para desconectar un dispositivo
app.post('/api/device/:deviceId/disconnect', async (req, res) => {
  const { deviceId } = req.params;
  const device = devices[deviceId];
  if (!device || !device.isReady) return res.json({ status: 'already_disconnected' });
  try {
    await device.client.logout();
  } catch (err) {
    return res.status(500).json({ error: 'Error al desconectar' });
  }
  try {
    await device.client.destroy();
  } catch (err) {
    console.error(`Error al destruir cliente del dispositivo ${deviceId}:`, err.message);
  }
  device.isReady = false;
  res.json({ status: 'disconnected' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${PORT}`);
});
