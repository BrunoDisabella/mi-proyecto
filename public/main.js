const socket = io();

const qrContainer = document.getElementById('qr-container');
const qrImage = document.getElementById('qr-image');
const appContainer = document.getElementById('app');
const chatListElem = document.getElementById('chat-list');
const chatTitleElem = document.getElementById('chat-title');
const messagesElem = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const logoutBtn = document.getElementById('logoutBtn');
const webhookBtn = document.getElementById('webhookBtn');
const webhookSection = document.getElementById('webhook-section');
const webhookForm = document.getElementById('webhook-form');
const webhookUrl = document.getElementById('webhook-url');
const webhookMethod = document.getElementById('webhook-method');
const webhookBody = document.getElementById('webhook-body');
const webhookResponse = document.getElementById('webhook-response');
const headersContainer = document.getElementById('headers-container');
const mappingContainer = document.getElementById('mapping-container');

let currentChatId = null;
let currentChatIsGroup = false;
let chatsData = [];

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadChats() {
  try {
    const response = await fetch('/api/chats');
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    chatsData = await response.json();
    chatListElem.innerHTML = '';
    chatsData.forEach(chat => {
      const li = document.createElement('li');
      li.textContent = chat.name || chat.id;
      li.dataset.id = chat.id;
      li.dataset.name = chat.name || chat.id;
      li.dataset.isgroup = chat.isGroup;
      li.addEventListener('click', () => {
        document.querySelectorAll('#chat-list li').forEach(item => item.classList.remove('active'));
        li.classList.add('active');
        currentChatId = li.dataset.id;
        currentChatIsGroup = (li.dataset.isgroup === '1');
        chatTitleElem.textContent = li.dataset.name;
        loadMessages(currentChatId);
      });
      chatListElem.appendChild(li);
    });
  } catch (error) {
    console.error('Error al cargar chats:', error);
  }
}

async function loadMessages(chatId) {
  if (!chatId) return;
  try {
    const res = await fetch(`/api/chat/${encodeURIComponent(chatId)}`);
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    const messages = await res.json();
    messagesElem.innerHTML = '';
    messages.forEach(msg => {
      const msgDiv = document.createElement('div');
      msgDiv.classList.add('message', msg.fromMe ? 'sent' : 'received');
      let content = '';
      if (currentChatIsGroup && !msg.fromMe) {
        const senderName = msg.sender || 'Desconocido';
        content += `<span class="sender">${escapeHTML(senderName)}:</span> `;
      }
      content += `<span class="text">${escapeHTML(msg.message)}</span>`;
      msgDiv.innerHTML = content;
      messagesElem.appendChild(msgDiv);
    });
    messagesElem.scrollTop = messagesElem.scrollHeight;
  } catch (error) {
    console.error(`Error al cargar mensajes del chat ${chatId}:`, error);
  }
}

async function checkAuthAndQR() {
  try {
    const res = await fetch('/api/qr');
    const data = await res.json();
    if (data.authenticated) {
      qrContainer.style.display = 'none';
      appContainer.style.display = 'flex';
      loadChats();
      clearInterval(qrInterval);
    } else if (data.qr) {
      qrImage.src = data.qr;
      qrContainer.style.display = 'block';
    } else {
      console.log('Esperando QR...');
    }
  } catch (error) {
    console.error('Error al verificar autenticación/QR:', error);
  }
}

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentChatId) return alert('Selecciona un chat.');
  const text = messageInput.value.trim();
  if (text === '') return;
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: currentChatId, message: text })
    });
    const result = await res.json();
    if (res.ok && result.status === 'success') {
      messageInput.value = '';
      loadMessages(currentChatId);
    } else {
      alert('Error al enviar el mensaje.');
    }
  } catch (error) {
    alert('Error al enviar el mensaje.');
  }
});

logoutBtn.addEventListener('click', async () => {
  if (confirm('¿Deseas desconectar tu sesión de WhatsApp?')) {
    try {
      const res = await fetch('/api/disconnect', { method: 'POST' });
      const result = await res.json();
      if (result.status === 'disconnected' || result.status === 'already_disconnected') {
        appContainer.style.display = 'none';
        chatListElem.innerHTML = '';
        messagesElem.innerHTML = '';
        qrImage.src = '';
        qrContainer.style.display = 'block';
        chatTitleElem.textContent = 'Selecciona un chat';
        currentChatId = null;
        qrInterval = setInterval(checkAuthAndQR, 3000);
        checkAuthAndQR();
      } else if (result.error) {
        alert('Error al desconectar: ' + result.error);
      }
    } catch (error) {
      alert('No se pudo desconectar la sesión.');
    }
  }
});

webhookBtn.addEventListener('click', () => {
  webhookSection.style.display = webhookSection.style.display === 'none' ? 'block' : 'none';
});

function addHeaderRow() {
  const row = document.createElement('div');
  row.classList.add('header-row');
  row.innerHTML = `
    <input type="text" class="header-key" placeholder="Key" />
    <input type="text" class="header-value" placeholder="Value" />
    <button type="button" class="remove-header">-</button>
  `;
  headersContainer.insertBefore(row, document.getElementById('add-header'));
  row.querySelector('.remove-header').addEventListener('click', () => row.remove());
}

function addMappingRow() {
  const row = document.createElement('div');
  row.classList.add('mapping-row');
  row.innerHTML = `
    <input type="text" class="mapping-jsonpath" placeholder="JSONPath" />
    <input type="text" class="mapping-field" placeholder="Campo personalizado" />
    <button type="button" class="remove-mapping">-</button>
  `;
  mappingContainer.insertBefore(row, document.getElementById('add-mapping'));
  row.querySelector('.remove-mapping').addEventListener('click', () => row.remove());
}

document.getElementById('add-header').addEventListener('click', addHeaderRow);
document.getElementById('add-mapping').addEventListener('click', addMappingRow);

webhookForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const urlVal = webhookUrl.value.trim();
  const methodVal = webhookMethod.value.trim();

  const headerRows = document.querySelectorAll('.header-row');
  const headersObj = {};
  headerRows.forEach(row => {
    const key = row.querySelector('.header-key').value.trim();
    const value = row.querySelector('.header-value').value.trim();
    if (key) {
      headersObj[key] = value;
    }
  });

  let bodyVal;
  try {
    bodyVal = webhookBody.value.trim() ? JSON.parse(webhookBody.value.trim()) : webhookBody.value.trim();
  } catch (err) {
    bodyVal = webhookBody.value.trim();
  }

  const mappingRows = document.querySelectorAll('.mapping-row');
  const mappingObj = {};
  mappingRows.forEach(row => {
    const jsonpath = row.querySelector('.mapping-jsonpath').value.trim();
    const field = row.querySelector('.mapping-field').value.trim();
    if (jsonpath && field) {
      mappingObj[field] = jsonpath;
    }
  });

  const config = {
    url: urlVal,
    method: methodVal,
    headers: headersObj,
    body: bodyVal,
    mapping: Object.keys(mappingObj).length ? mappingObj : null
  };

  localStorage.setItem('webhookConfig', JSON.stringify(config));
  webhookResponse.innerText = "Configuración guardada.";
});

window.addEventListener('load', () => {
  const savedConfig = localStorage.getItem('webhookConfig');
  if (savedConfig) {
    try {
      const config = JSON.parse(savedConfig);
      webhookUrl.value = config.url || "";
      webhookMethod.value = config.method || "POST";
      headersContainer.innerHTML = '<h4>Encabezados</h4>';
      for (const key in config.headers) {
        const row = document.createElement('div');
        row.classList.add('header-row');
        row.innerHTML = `
          <input type="text" class="header-key" placeholder="Key" value="${escapeHTML(key)}" />
          <input type="text" class="header-value" placeholder="Value" value="${escapeHTML(config.headers[key])}" />
          <button type="button" class="remove-header">-</button>
        `;
        headersContainer.appendChild(row);
        row.querySelector('.remove-header').addEventListener('click', () => row.remove());
      }
      mappingContainer.innerHTML = '<h4>Mapeo de respuesta</h4>';
      for (const field in config.mapping || {}) {
        const row = document.createElement('div');
        row.classList.add('mapping-row');
        row.innerHTML = `
          <input type="text" class="mapping-jsonpath" placeholder="JSONPath" value="${escapeHTML(config.mapping[field])}" />
          <input type="text" class="mapping-field" placeholder="Campo personalizado" value="${escapeHTML(field)}" />
          <button type="button" class="remove-mapping">-</button>
        `;
        mappingContainer.appendChild(row);
        row.querySelector('.remove-mapping').addEventListener('click', () => row.remove());
      }
      webhookBody.value = config.body ? JSON.stringify(config.body, null, 2) : "";
    } catch (e) {
      console.error("Error al cargar configuración guardada:", e);
    }
  } else {
    const row = document.createElement('div');
    row.classList.add('header-row');
    row.innerHTML = `
      <input type="text" class="header-key" placeholder="Key" value="Content-Type" />
      <input type="text" class="header-value" placeholder="Value" value="application/json" />
      <button type="button" class="remove-header">-</button>
    `;
    headersContainer.appendChild(row);
    row.querySelector('.remove-header').addEventListener('click', () => row.remove());
  }
});

socket.on('qr', (data) => {
  if (data.qr) {
    qrImage.src = data.qr;
  }
});

socket.on('ready', (data) => {
  if (data.authenticated) {
    qrContainer.style.display = 'none';
    appContainer.style.display = 'flex';
    loadChats();
  }
});

socket.on('new_message', (data) => {
  if (data.chatId === currentChatId) {
    loadMessages(currentChatId);
  }
});

let qrInterval = setInterval(checkAuthAndQR, 3000);
checkAuthAndQR();
