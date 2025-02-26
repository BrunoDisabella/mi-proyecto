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

let client;
let currentQR = null;
let isReady = false;
// URL del webhook de n8n (usando GET)
const N8N_WEBHOOK_URL = 'https://primary-production-bbfb.up.railway.app/webhook-test/1fae31d9-74e6-4d10-becb-4043413f0a49';

// Almacenamiento en memoria: Map<chatId, { name, isGroup, messages: [] }>
const chats = new Map();

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
  // Configuramos Puppeteer para no usar sandbox y deshabilitar GPU (necesario en Railway)
  client = new Client({
    authStrategy: new LocalAuth(),
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
        // Se comenta la parte de fetchMessages para evitar errores de sesión cerrada
        /*
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
        } catch (err) {
          console.error('Error al fetchMessages en chat:', chatId, err.message);
        }
        */
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

  // Al recibir un mensaje (entrante), se activa el webhook GET
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

  // Al enviar un mensaje (saliente), se activa el webhook GET
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

// Endpoint para guardar la configuración del Webhook avanzado (para pruebas)
app.post('/api/webhook/request', async (req, res) => {
  const { url, method, headers, body, mapping } = req.body;
  if (!url || !method) {
    return res.status(400).json({ error: 'URL y método son requeridos' });
  }
  try {
    const config = {
      method: method.toLowerCase(),
      url,
      headers: headers || {}
    };
    if (['post', 'put', 'delete'].includes(method.toLowerCase())) {
      config.data = body || null;
    }
    const response = await axios(config);
    let result = response.data;
    if (mapping) {
      result = applyMapping(response.data, mapping);
    }
    return res.json({ status: 'success', response: result });
  } catch (error) {
    console.error('Error en solicitud webhook:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

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
  let targetChatId = chatId;
  if (!targetChatId.endsWith('@c.us') && !targetChatId.endsWith('@g.us')) {
    targetChatId += targetChatId.includes('-') ? '@g.us' : '@c.us';
  }
  try {
    await client.sendMessage(targetChatId, message);
    res.json({ status: 'success', chatId: targetChatId });
  } catch (error) {
    res.status(500).json({ error: 'No se pudo enviar el mensaje' });
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
