/**
 * Pink Messages — main app script
 * Uses Graffiti (decentralized) for login + storage.
 * I tried to keep the flow obvious: discover → merge → render.
 */

import { GraffitiDecentralized } from "https://esm.sh/@graffiti-garden/implementation-decentralized@0.0.9";

// ---- Constants (easy to change if the class reuses another year)
const DISCOVERY_CHANNEL = "pink-messages-2026";

/** Personal "inbox" channel for this app — Join + Important live here */
function personalChannel(actor) {
  return `${actor}/pink-messages`;
}

/** Fresh id for a chat's message channel */
function newChatChannelId() {
  return `pink-messages/chat/${crypto.randomUUID()}`;
}

// Loose JSON Schema so discover accepts normal Graffiti objects (incl. optional `allowed`)
const GRAFFITI_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string" },
    actor: { type: "string" },
    channels: {
      type: "array",
      items: { type: "string" },
    },
    value: { type: "object" },
    allowed: { type: "array", items: { type: "string" } },
  },
  required: ["url", "actor", "channels", "value"],
  additionalProperties: true,
};

// ---- Graffiti instance + session
const graffiti = new GraffitiDecentralized();

/** Current Graffiti session (null on login screen) */
let session = null;

/**
 * Graffiti's discover returns an async stream of chunks.
 * We just loop until it ends — good enough for a small class-scale app.
 */
async function drainDiscover(channels, schema, sess) {
  const objects = [];
  const stream = graffiti.discover(channels, schema, sess);
  for await (const chunk of stream) {
    if (chunk && chunk.object) objects.push(chunk.object);
    if (chunk && chunk.error) console.warn("discover warning:", chunk.error);
  }
  return objects;
}

// ---- App state (kept simple on purpose)
let mainTab = "chats"; // "chats" | "important"
let selectedFolder = "All"; // All | People | Groups | Verification
/** @type {{ channel: string, title: string, folder: string } | null} */
let activeChat = null;

/** map channel -> chat row for sidebar */
let chatRows = [];
/** all Create objects from discovery (for Discover panel) */
let discoveredCreates = [];
/** message url -> { importantUrl } when saved */
const importantByMessageUrl = new Map();

let pollTimer = null;

// ---- UI refs
const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const btnLogin = document.getElementById("btn-login");
const loginStatus = document.getElementById("login-status");
const btnLogout = document.getElementById("btn-logout");
const userHandleEl = document.getElementById("user-handle");
const globalStatus = document.getElementById("global-status");

const tabChats = document.getElementById("tab-chats");
const tabImportant = document.getElementById("tab-important");
const chatsLayout = document.getElementById("chats-layout");
const importantLayout = document.getElementById("important-layout");

const folderPills = document.getElementById("folder-pills");
const chatList = document.getElementById("chat-list");
const chatListStatus = document.getElementById("chat-list-status");
const btnNewChat = document.getElementById("btn-new-chat");
const btnToggleDiscover = document.getElementById("btn-toggle-discover");
const discoverPanel = document.getElementById("discover-panel");
const discoverList = document.getElementById("discover-list");
const discoverStatus = document.getElementById("discover-status");

const chatPlaceholder = document.getElementById("chat-placeholder");
const chatView = document.getElementById("chat-view");
const chatTitleEl = document.getElementById("chat-title");
const chatFolderBadge = document.getElementById("chat-folder-badge");
const messagesArea = document.getElementById("messages-area");
const sendForm = document.getElementById("send-form");
const messageInput = document.getElementById("message-input");
const btnSend = document.getElementById("btn-send");
const chatError = document.getElementById("chat-error");

const importantList = document.getElementById("important-list");
const importantStatus = document.getElementById("important-status");

const modalNewChat = document.getElementById("modal-new-chat");
const formNewChat = document.getElementById("form-new-chat");
const newChatTitle = document.getElementById("new-chat-title");
const newChatFolder = document.getElementById("new-chat-folder");
const newChatStatus = document.getElementById("new-chat-status");
const newChatError = document.getElementById("new-chat-error");
const btnCreateChat = document.getElementById("btn-create-chat");

// ---- Small helpers
function show(el) {
  el.classList.remove("hidden");
  el.removeAttribute("hidden");
}

function hide(el) {
  el.classList.add("hidden");
  el.setAttribute("hidden", "");
}

function setStatus(el, text) {
  el.textContent = text || "";
}

function setGlobalStatus(text) {
  setStatus(globalStatus, text);
}

/** Format time for humans — short */
function formatTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// ---- Session / identity
graffiti.sessionEvents.addEventListener("login", async (event) => {
  if (!(event instanceof CustomEvent)) return;
  const detail = event.detail;
  if (detail.error) {
    setStatus(loginStatus, "Login did not finish: " + detail.error.message);
    return;
  }
  session = detail.session;
  hide(loginScreen);
  show(appScreen);
  await refreshHandle();
  await loadEverything();
});

graffiti.sessionEvents.addEventListener("logout", () => {
  session = null;
  stopPolling();
  show(loginScreen);
  hide(appScreen);
  chatRows = [];
  activeChat = null;
  importantByMessageUrl.clear();
});

graffiti.sessionEvents.addEventListener("initialized", () => {
  // If something failed during startup we could show it — usually fine
});

async function refreshHandle() {
  if (!session) return;
  try {
    const h = await graffiti.actorToHandle(session.actor);
    userHandleEl.textContent = h;
  } catch {
    userHandleEl.textContent = session.actor.slice(0, 18) + "…";
  }
}

btnLogin.addEventListener("click", () => {
  setStatus(loginStatus, "Opening Graffiti login…");
  graffiti.login().catch((e) => {
    setStatus(loginStatus, "Login error: " + e.message);
  });
});

btnLogout.addEventListener("click", () => {
  if (session) graffiti.logout(session);
});

// ---- Data loading
/** Pull every public chat announcement from the class discovery channel */
async function loadCreates() {
  const objs = await drainDiscover([DISCOVERY_CHANNEL], GRAFFITI_OBJECT_SCHEMA, session);
  discoveredCreates = objs.filter((o) => o.value && o.value.activity === "Create");
}

async function loadJoins() {
  const ch = personalChannel(session.actor);
  const objs = await drainDiscover([ch], GRAFFITI_OBJECT_SCHEMA, session);
  return objs.filter((o) => o.value && o.value.activity === "Join");
}

async function loadImportantMarkers() {
  const ch = personalChannel(session.actor);
  const objs = await drainDiscover([ch], GRAFFITI_OBJECT_SCHEMA, session);
  const markers = objs.filter((o) => o.value && o.value.activity === "MarkImportant");
  importantByMessageUrl.clear();
  for (const o of markers) {
    const t = o.value.target;
    if (t) importantByMessageUrl.set(t, { importantUrl: o.url });
  }
  return markers;
}

/**
 * Build sidebar list: Join rows + my own Create rows (deduped by channel)
 */
async function buildChatRows() {
  await loadCreates();
  const joins = await loadJoins();
  const byChannel = new Map();

  for (const j of joins) {
    const v = j.value;
    byChannel.set(v.channel, {
      channel: v.channel,
      title: v.title,
      folder: v.folder,
      source: "join",
    });
  }

  for (const c of discoveredCreates) {
    if (c.actor !== session.actor) continue;
    const v = c.value;
    if (!byChannel.has(v.channel)) {
      byChannel.set(v.channel, {
        channel: v.channel,
        title: v.title,
        folder: v.folder,
        source: "create",
      });
    }
  }

  chatRows = Array.from(byChannel.values());
  chatRows.sort((a, b) => a.title.localeCompare(b.title));
}

function folderMatches(row) {
  if (selectedFolder === "All") return true;
  return row.folder === selectedFolder;
}

function renderChatList() {
  chatList.innerHTML = "";
  const rows = chatRows.filter(folderMatches);
  if (rows.length === 0) {
    chatList.innerHTML = "<li><span class='chat-item-meta'>No chats in this folder yet.</span></li>";
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-item";
    if (activeChat && activeChat.channel === row.channel) btn.classList.add("selected");
    btn.innerHTML = `<span class="chat-item-title"></span><span class="chat-item-meta"></span>`;
    btn.querySelector(".chat-item-title").textContent = row.title;
    btn.querySelector(".chat-item-meta").textContent = row.folder;
    btn.addEventListener("click", () => selectChat(row));
    li.appendChild(btn);
    chatList.appendChild(li);
  }
}

function renderDiscoverList() {
  discoverList.innerHTML = "";
  const joined = new Set(chatRows.map((r) => r.channel));
  const available = discoveredCreates.filter((c) => !joined.has(c.value.channel));
  if (available.length === 0) {
    discoverList.innerHTML =
      "<li><span class='chat-item-meta'>Nothing new — you're already in every visible chat.</span></li>";
    return;
  }
  for (const obj of available) {
    const v = obj.value;
    const li = document.createElement("li");
    li.className = "join-row";
    const span = document.createElement("span");
    span.textContent = `${v.title} · ${v.folder}`;
    const joinBtn = document.createElement("button");
    joinBtn.type = "button";
    joinBtn.className = "btn btn-secondary btn-tiny";
    joinBtn.textContent = "Join";
    joinBtn.addEventListener("click", () => joinChat(obj));
    li.appendChild(span);
    li.appendChild(joinBtn);
    discoverList.appendChild(li);
  }
}

async function loadEverything() {
  if (!session) return;
  setStatus(chatListStatus, "Loading chats…");
  try {
    await buildChatRows();
    await loadImportantMarkers();
    renderChatList();
    renderDiscoverList();
    setStatus(chatListStatus, "");
    if (mainTab === "important") renderImportantTab();
    if (activeChat) {
      await openChatMessages(activeChat);
    }
  } catch (e) {
    console.error(e);
    setStatus(chatListStatus, "Could not load data. Check connection and try again.");
  }
}

// ---- Tabs
function setMainTab(tab) {
  mainTab = tab;
  const chatsOn = tab === "chats";
  tabChats.classList.toggle("active", chatsOn);
  tabChats.setAttribute("aria-selected", chatsOn ? "true" : "false");
  tabImportant.classList.toggle("active", !chatsOn);
  tabImportant.setAttribute("aria-selected", chatsOn ? "false" : "true");
  if (chatsOn) {
    show(chatsLayout);
    hide(importantLayout);
  } else {
    hide(chatsLayout);
    show(importantLayout);
    renderImportantTab();
  }
}

tabChats.addEventListener("click", () => setMainTab("chats"));
tabImportant.addEventListener("click", () => setMainTab("important"));

// ---- Folders
folderPills.addEventListener("click", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (!t.matches(".folder-pill")) return;
  selectedFolder = t.dataset.folder || "All";
  for (const pill of folderPills.querySelectorAll(".folder-pill")) {
    pill.classList.toggle("active", pill === t);
  }
  renderChatList();
});

// ---- Create chat
function openNewChatModal() {
  newChatTitle.value = "";
  newChatFolder.value = "People";
  setStatus(newChatStatus, "");
  newChatError.textContent = "";
  show(modalNewChat);
}

function closeNewChatModal() {
  hide(modalNewChat);
}

btnNewChat.addEventListener("click", openNewChatModal);
modalNewChat.addEventListener("click", (e) => {
  const t = e.target;
  if (t instanceof HTMLElement && t.hasAttribute("data-close-modal")) closeNewChatModal();
});

let creatingChat = false;
formNewChat.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!session || creatingChat) return;
  creatingChat = true;
  btnCreateChat.disabled = true;
  newChatError.textContent = "";
  setStatus(newChatStatus, "Creating chat…");

  const title = newChatTitle.value.trim();
  const folder = newChatFolder.value;
  const channel = newChatChannelId();
  const published = Date.now();
  const chatId = crypto.randomUUID();

  try {
    // A) shared discovery record so others can find it
    await graffiti.post(
      {
        channels: [DISCOVERY_CHANNEL],
        value: {
          activity: "Create",
          type: "Chat",
          id: chatId,
          title,
          folder,
          channel,
          published,
        },
      },
      session
    );

    // B) personal Join so it shows in my sidebar the same way as chats I joined later
    await graffiti.post(
      {
        channels: [personalChannel(session.actor)],
        value: {
          activity: "Join",
          id: crypto.randomUUID(),
          target: chatId,
          title,
          folder,
          channel,
          published,
        },
      },
      session
    );

    setStatus(newChatStatus, "Done!");
    closeNewChatModal();
    await loadEverything();
    selectChat({ channel, title, folder });
  } catch (err) {
    console.error(err);
    newChatError.textContent = "Could not create chat: " + err.message;
    setStatus(newChatStatus, "");
  } finally {
    creatingChat = false;
    btnCreateChat.disabled = false;
  }
});

// ---- Join chat
let joining = false;
/** Copy metadata from someone else's Create object into my personal Join record */
async function joinChat(createObj) {
  if (!session || joining) return;
  joining = true;
  setStatus(discoverStatus, "Joining chat…");
  const v = createObj.value;
  try {
    await graffiti.post(
      {
        channels: [personalChannel(session.actor)],
        value: {
          activity: "Join",
          id: crypto.randomUUID(),
          target: v.id,
          title: v.title,
          folder: v.folder,
          channel: v.channel,
          published: Date.now(),
        },
      },
      session
    );
    setStatus(discoverStatus, "Joined!");
    await loadEverything();
    selectChat({ channel: v.channel, title: v.title, folder: v.folder });
  } catch (e) {
    console.error(e);
    setStatus(discoverStatus, "Join failed: " + e.message);
  } finally {
    joining = false;
  }
}

// ---- Select chat + messages
function selectChat(row) {
  activeChat = { channel: row.channel, title: row.title, folder: row.folder };
  renderChatList();
  showChatChrome();
  openChatMessages(activeChat);
  startPolling();
}

function showChatChrome() {
  hide(chatPlaceholder);
  show(chatView);
  chatTitleEl.textContent = activeChat.title;
  chatFolderBadge.textContent = activeChat.folder;
}

async function openChatMessages(chat) {
  chatError.textContent = "";
  messagesArea.innerHTML = "";
  setGlobalStatus("Loading messages…");
  try {
    // Stars depend on personal MarkImportant objects — refresh before drawing bubbles
    await loadImportantMarkers();
    const objs = await drainDiscover([chat.channel], GRAFFITI_OBJECT_SCHEMA, session);
    const msgs = objs
      .filter((o) => o.value && o.value.activity === "Send")
      .sort((a, b) => (a.value.published || 0) - (b.value.published || 0));

    for (const o of msgs) {
      messagesArea.appendChild(renderMessageBubble(o));
    }
    messagesArea.scrollTop = messagesArea.scrollHeight;
  } catch (e) {
    console.error(e);
    chatError.textContent = "Could not load messages.";
  }
  setGlobalStatus("");
}

function renderMessageBubble(o) {
  const v = o.value;
  const mine = o.actor === session.actor;
  const wrap = document.createElement("div");
  wrap.className = "msg-row " + (mine ? "mine" : "theirs");
  wrap.dataset.msgUrl = o.url;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble " + (mine ? "mine" : "theirs");

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = mine ? "You · " + formatTime(v.published) : "Someone · " + formatTime(v.published);

  const body = document.createElement("div");
  body.textContent = v.content || "";

  bubble.appendChild(meta);
  bubble.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const star = document.createElement("button");
  star.type = "button";
  star.className = "btn-star";
  const saved = importantByMessageUrl.has(o.url);
  star.textContent = saved ? "★ Saved" : "☆ Save";
  if (saved) star.classList.add("saved");
  star.addEventListener("click", () => toggleImportant(o, star));
  actions.appendChild(star);

  wrap.appendChild(bubble);
  wrap.appendChild(actions);
  return wrap;
}

let sending = false;
sendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!session || !activeChat || sending) return;
  const text = messageInput.value.trim();
  if (!text) return;
  sending = true;
  btnSend.disabled = true;
  setGlobalStatus("Sending…");
  chatError.textContent = "";
  try {
    await graffiti.post(
      {
        channels: [activeChat.channel],
        value: {
          activity: "Send",
          type: "Message",
          id: crypto.randomUUID(),
          content: text,
          chatChannel: activeChat.channel,
          chatTitle: activeChat.title,
          published: Date.now(),
        },
      },
      session
    );
    messageInput.value = "";
    await openChatMessages(activeChat);
  } catch (err) {
    console.error(err);
    chatError.textContent = "Send failed: " + err.message;
  } finally {
    sending = false;
    btnSend.disabled = false;
    setGlobalStatus("");
  }
});

// ---- Important
let importantBusy = false;
async function toggleImportant(messageObj, btn) {
  if (!session || !activeChat || importantBusy) return;
  importantBusy = true;
  btn.disabled = true;
  const url = messageObj.url;
  const existing = importantByMessageUrl.get(url);

  try {
    if (existing) {
      setGlobalStatus("Removing from Important…");
      await graffiti.delete(existing.importantUrl, session);
      importantByMessageUrl.delete(url);
    } else {
      setGlobalStatus("Saving to Important…");
      const preview = (messageObj.value.content || "").slice(0, 160);
      const posted = await graffiti.post(
        {
          channels: [personalChannel(session.actor)],
          value: {
            activity: "MarkImportant",
            id: crypto.randomUUID(),
            target: url,
            chatChannel: activeChat.channel,
            chatTitle: activeChat.title,
            preview,
            published: Date.now(),
          },
        },
        session
      );
      importantByMessageUrl.set(url, { importantUrl: posted.url });
    }
    // openChatMessages refreshes markers + redraws bubbles
    await openChatMessages(activeChat);
    if (mainTab === "important") renderImportantTab();
  } catch (e) {
    console.error(e);
    chatError.textContent = "Important action failed: " + e.message;
  } finally {
    importantBusy = false;
    btn.disabled = false;
    setGlobalStatus("");
  }
}

async function renderImportantTab() {
  importantList.innerHTML = "";
  if (!session) return;
  setStatus(importantStatus, "Loading…");
  try {
    const ch = personalChannel(session.actor);
    const objs = await drainDiscover([ch], GRAFFITI_OBJECT_SCHEMA, session);
    const items = objs
      .filter((o) => o.value && o.value.activity === "MarkImportant")
      .sort((a, b) => (b.value.published || 0) - (a.value.published || 0));

    if (items.length === 0) {
      importantList.innerHTML = "<li class='chat-item-meta'>No saved messages yet. Star one in a chat.</li>";
    } else {
      for (const o of items) {
        const v = o.value;
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "important-item";
        b.innerHTML = `<div class="imp-preview"></div><div class="imp-meta"></div>`;
        b.querySelector(".imp-preview").textContent = v.preview || "(no preview)";
        b.querySelector(".imp-meta").textContent = `${v.chatTitle || "Chat"} · ${formatTime(v.published)}`;
        b.addEventListener("click", () => {
          void goToImportantTarget(v);
        });
        li.appendChild(b);
        importantList.appendChild(li);
      }
    }
    setStatus(importantStatus, "");
  } catch (e) {
    console.error(e);
    setStatus(importantStatus, "Could not load Important list.");
  }
}

async function goToImportantTarget(v) {
  setMainTab("chats");
  const row = chatRows.find((r) => r.channel === v.chatChannel);
  if (!row) {
    setGlobalStatus("That chat is not in your list — join it from Discover first.");
    return;
  }
  activeChat = { channel: row.channel, title: row.title, folder: row.folder };
  renderChatList();
  showChatChrome();
  await openChatMessages(activeChat);
  startPolling();
  for (const el of messagesArea.querySelectorAll(".msg-row")) {
    if (el.dataset.msgUrl === v.target) {
      el.scrollIntoView({ block: "center" });
      el.classList.add("highlight-msg");
      setTimeout(() => el.classList.remove("highlight-msg"), 1400);
      break;
    }
  }
}

// ---- Discover toggle
btnToggleDiscover.addEventListener("click", () => {
  const hidden = discoverPanel.classList.contains("hidden");
  if (hidden) {
    show(discoverPanel);
    renderDiscoverList();
  } else {
    hide(discoverPanel);
  }
});

// ---- Polling (cheap refresh while you're in a chat)
function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    if (!session || !activeChat || mainTab !== "chats") return;
    await openChatMessages(activeChat);
  }, 12000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

window.addEventListener("focus", () => {
  if (session && activeChat) openChatMessages(activeChat);
});
