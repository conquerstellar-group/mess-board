// ── State ──
let conversations = [];
let selectedId = null;
let ws = null;
let wsReconnectTimer = null;
const beforeCursors = {};   // conversationId → cursor for next older page
const hasMoreMap = {};      // conversationId → boolean
let loadingMore = false;

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const conversationList = document.getElementById('conversation-list');
const mainContent = document.getElementById('main-content');
const chatMessages = document.getElementById('chat-messages');
const chatHeaderName = document.getElementById('chat-header-name');
const chatHeaderStatus = document.getElementById('chat-header-status');
const noChatSelected = document.getElementById('no-chat-selected');
const systemStatus = document.getElementById('system-status');
const wsStatusDot = document.getElementById('ws-status');
const totalBadge = document.getElementById('total-badge');
const sidebar = document.getElementById('sidebar');
const chatArea = document.getElementById('chat-area');
const chatInputBar = document.getElementById('chat-input-bar');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

// ── Time formatting ──
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);

  if (mins < 1) return 'Vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  if (hours < 24) return `${hours} giờ trước`;

  return d.toLocaleDateString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}

function formatTimeFull(ts) {
  return new Date(ts).toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Escape HTML ──
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Render conversation list ──
function renderConversations() {
  if (!conversations.length) {
    conversationList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        Chưa có hội thoại nào<br/>Khách hàng mới sẽ xuất hiện tại đây
      </div>
    `;
    return;
  }

  totalBadge.textContent = conversations.length;

  conversationList.innerHTML = conversations
    .map(
      (conv) => `
      <div class="conversation-item ${selectedId === conv.customerId ? 'active' : ''}"
           onclick="selectConversation('${conv.customerId}')">
        <div class="conversation-avatar">
          <img src="https://graph.facebook.com/v25.0/${esc(conv.customerId)}/picture?type=square" 
               alt="${esc(conv.customerName)}" 
               onerror="this.style.display='none';this.parentNode.textContent='${(conv.customerName || '?').charAt(0).toUpperCase()}'">
        </div>
        <div class="conversation-info">
          <div class="conversation-name">${esc(conv.customerName === conv.customerId ? 'Khách hàng' : conv.customerName)}</div>
          <div class="conversation-preview">
            ${conv.messages.length > 0 ? esc(conv.messages[conv.messages.length - 1].text.slice(0, 50)) + (conv.messages[conv.messages.length - 1].text.length > 50 ? '...' : '') : 'Chưa có tin nhắn'}
          </div>
        </div>
        <div class="conversation-meta">
          <div class="conversation-time">${formatTime(conv.lastActivity)}</div>
          <div class="conversation-status ${conv.status}"></div>
        </div>
      </div>
    `
    )
    .join('');
}

// ── Simple markdown renderer ──
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

// ── Build reasoning HTML ──
function reasoningHTML(text, collapsed) {
  return `
    <div class="reasoning-block${collapsed ? ' collapsed' : ''}">
      <div class="reasoning-header">
        <span class="reasoning-label">🤖 Suy luận</span>
        <button class="reasoning-toggle" onclick="toggleReasoning(this)">${collapsed ? 'Hiện' : 'Ẩn'}</button>
      </div>
      <div class="reasoning-content">${renderMarkdown(text)}</div>
    </div>
  `;
}

// ── Toggle reasoning show/hide ──
window.toggleReasoning = function (btn) {
  const block = btn.closest('.reasoning-block');
  block.classList.toggle('collapsed');
  btn.textContent = block.classList.contains('collapsed') ? 'Hiện' : 'Ẩn';
};

// ── Avatars ──
function avatarHTML(senderId, senderName, size) {
  const s = size || 32;
  return `<div class="message-avatar" style="width:${s}px;height:${s}px;font-size:${Math.round(s*0.4)}px">
    <img src="https://graph.facebook.com/v25.0/${esc(senderId)}/picture?type=square" 
         alt="${esc(senderName)}"
         onerror="this.style.display='none';this.parentNode.textContent='${(senderName || '?').charAt(0).toUpperCase()}'">
  </div>`;
}

// ── Render selected conversation messages ──
function renderMessages() {
  const conv = conversations.find((c) => c.customerId === selectedId);
  if (!conv) {
    noChatSelected.style.display = 'flex';
    chatArea.style.display = 'none';
    chatInputBar.style.display = 'none';
    chatMessages.innerHTML = '';
    chatHeaderName.textContent = '';
    chatHeaderStatus.className = 'chat-header-status';
    return;
  }

  noChatSelected.style.display = 'none';
  chatArea.style.display = 'flex';
  chatInputBar.style.display = 'block';
  chatHeaderName.textContent = conv.customerName;
  chatHeaderStatus.textContent = conv.status === 'active' ? 'Đang hoạt động' : conv.status === 'waiting' ? 'Đang chờ' : 'Đã kết thúc';
  chatHeaderStatus.className = 'chat-header-status ' + conv.status;

  chatMessages.innerHTML = conv.messages
    .map((msg) => {
      const isCustomer = msg.role === 'customer';
      const role = isCustomer ? 'customer' : 'ai';
      const name = msg.senderName && msg.senderName !== msg.senderId ? msg.senderName : (isCustomer ? 'Khách hàng' : 'AI Assistant');
      const fbId = isCustomer ? (conv.customerId || msg.senderId) : '1202330162966881';
      return `
        <div class="message ${role}">
          ${isCustomer ? avatarHTML(fbId, name, 28) : ''}
          <div class="message-body">
            ${!isCustomer ? '' : ''}
            <div class="message-bubble">${esc(msg.text)}</div>
            ${msg.reasoning ? reasoningHTML(msg.reasoning, true) : ''}
            <div class="message-time">${formatTimeFull(msg.timestamp)}</div>
          </div>
          ${!isCustomer ? '<div class="message-avatar" style="width:28px;height:28px;font-size:11px;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;border-radius:50%;flex-shrink:0"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg></div>' : ''}
        </div>
      `;
    })
    .join('');

  scrollToBottomIfNear();
}

// ── Smart scroll: only auto-scroll if user is near bottom ──
function scrollToBottomIfNear() {
  const el = chatMessages;
  const threshold = 80;
  const isNearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
  if (isNearBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

// ── Select conversation ──
window.selectConversation = function (id) {
  selectedId = id;
  renderConversations();
  renderMessages();

  // Lazy load: fetch latest 20 messages
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'fetch_history', payload: { conversationId: id, limit: 20 } }));
  }
  // Reset pagination state
  beforeCursors[id] = null;
  hasMoreMap[id] = true;
  loadingMore = false;

  if (window.innerWidth <= 768) {
    sidebar.style.display = 'none';
    mainContent.classList.add('visible');
  }
};

window.backToSidebar = function () {
  if (window.innerWidth <= 768) {
    sidebar.style.display = 'flex';
    mainContent.classList.remove('visible');
  }
};

// ── Scroll to top → load older messages ──
chatMessages.addEventListener('scroll', () => {
  if (chatMessages.scrollTop > 10) return;
  if (!selectedId || !hasMoreMap[selectedId] || loadingMore) return;
  const cursor = beforeCursors[selectedId];
  if (!cursor) return;
  loadingMore = true;
  ws.send(JSON.stringify({
    type: 'fetch_history',
    payload: { conversationId: selectedId, limit: 20, before: cursor },
  }));
});

function loadMoreMessages() {
  if (!selectedId || !hasMoreMap[selectedId] || loadingMore) return;
  const cursor = beforeCursors[selectedId];
  if (!cursor) return;
  loadingMore = true;
  ws.send(JSON.stringify({
    type: 'fetch_history',
    payload: { conversationId: selectedId, limit: 20, before: cursor },
  }));
}

// ── Send message ──
function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !selectedId) return;

  chatInput.value = '';
  chatSendBtn.disabled = true;

  // Optimistic: add message locally first
  const conv = conversations.find((c) => c.customerId === selectedId);
  if (conv) {
    const tempMsg = {
      id: 'temp-' + Date.now(),
      senderId: '1202330162966881',
      senderName: 'Conquerstellar',
      text,
      timestamp: Date.now(),
      role: 'ai',
    };
    conv.messages.push(tempMsg);
    conv.lastActivity = Date.now();
    renderMessages();
    renderConversations();
  }

  ws.send(JSON.stringify({ type: 'send_message', payload: { conversationId: selectedId, text } }));
  setTimeout(() => { chatSendBtn.disabled = false; }, 300);
}

// ── Send on Enter ──
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

chatSendBtn.addEventListener('click', sendMessage);

// ── Handle incoming reasoning streaming ──
function updateReasoning(conversationId, reasoningText) {
  if (selectedId !== conversationId) return;

  const existingLive = document.getElementById('live-reasoning');
  if (existingLive) existingLive.remove();

  const div = document.createElement('div');
  div.id = 'live-reasoning';
  div.className = 'message ai';
  div.innerHTML = `
    <div class="message-body">
      <div class="message-bubble" style="background:var(--primary);color:white">
        <span style="opacity:0.7">Đang suy luận...</span>
      </div>
      <div class="reasoning-block">
        <div class="reasoning-header">
          <span class="reasoning-label">🤖 Suy luận</span>
          <button class="reasoning-toggle" onclick="toggleReasoning(this)">Ẩn</button>
        </div>
        <div class="reasoning-content">${renderMarkdown(reasoningText)}<span class="reasoning-cursor"></span></div>
      </div>
      <div class="message-time">Đang xử lý...</div>
    </div>
    <div class="message-avatar" style="width:28px;height:28px;font-size:11px;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;border-radius:50%;flex-shrink:0"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg></div>
  `;
  chatMessages.appendChild(div);
  scrollToBottomIfNear();
}

function removeLiveReasoning() {
  const el = document.getElementById('live-reasoning');
  if (el) el.remove();
}

// ── WebSocket ──
function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    updateConnectionStatus(false);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[WS] Connected');
    updateConnectionStatus(true);
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected');
    updateConnectionStatus(false);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, 3000);
}

function updateConnectionStatus(connected) {
  wsStatusDot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
  systemStatus.textContent = connected ? 'Đã kết nối' : 'Mất kết nối';
  systemStatus.style.color = connected ? 'var(--status-active)' : '#EF4444';
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'conversations':
      conversations = msg.payload;
      renderConversations();
      if (selectedId) renderMessages();
      break;

    case 'history': {
      const { conversationId, messages, beforeCursor, hasMore, append } = msg.payload;
      const conv = conversations.find((c) => c.customerId === conversationId);
      if (!conv) break;
      if (append) {
        // Prepend older messages
        const existingIds = new Set(conv.messages.map((m) => m.id));
        const newMsgs = messages.filter((m) => !existingIds.has(m.id));
        conv.messages = [...newMsgs, ...conv.messages];
        const prevScrollHeight = chatMessages.scrollHeight;
        if (selectedId === conversationId) renderMessages();
        // Restore scroll position after prepend
        chatMessages.scrollTop = chatMessages.scrollHeight - prevScrollHeight;
      } else {
        conv.messages = messages;
        if (selectedId === conversationId) renderMessages();
      }
      beforeCursors[conversationId] = beforeCursor || null;
      hasMoreMap[conversationId] = !!hasMore;
      loadingMore = false;
      break;
    }

    case 'new_message': {
      const { conversationId, customerName, message } = msg.payload;
      const existing = conversations.find((c) => c.customerId === conversationId);
      if (existing) {
        // Skip duplicates
        if (!existing.messages.some((m) => m.id === message.id)) {
          existing.messages.push(message);
        }
        existing.lastActivity = message.timestamp;
        existing.customerName = customerName;
      } else {
        conversations.unshift({
          id: conversationId,
          customerId: conversationId,
          customerName,
          messages: [message],
          lastActivity: message.timestamp,
          status: 'active',
        });
      }
      renderConversations();
      if (selectedId === conversationId) renderMessages();
      break;
    }

    case 'ai_reasoning': {
      const { conversationId, reasoning } = msg.payload;
      updateReasoning(conversationId, reasoning);
      break;
    }

    case 'ai_response': {
      const { conversationId, message } = msg.payload;
      removeLiveReasoning();

      const existing = conversations.find((c) => c.customerId === conversationId);
      if (existing) {
        if (!existing.messages.some((m) => m.id === message.id)) {
          existing.messages.push(message);
        }
        existing.lastActivity = message.timestamp;
      }
      renderConversations();
      if (selectedId === conversationId) renderMessages();
      break;
    }

    case 'error':
      console.error('[WS] Server error:', msg.payload);
      break;
  }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  connectWs();
});