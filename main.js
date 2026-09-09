const STORAGE_KEY = 'conversaciones-whatsapp-v1';
const MESSAGE_BATCH_SIZE = 80;
const DRIVE_FILE_NAME = 'conversaciones-cloud.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GOOGLE_CLIENT_ID = '447085803012-0j36qg7khrf42491p7ftff223v4v5bid.apps.googleusercontent.com';

const state = {
	chats: loadChats(),
	activeChatId: null,
	search: '',
	messageStart: 0,
	pendingChat: null,
	messageQuery: '',
	profilePhotoDraft: '',
	updateMode: false,
	chatBackgroundDraft: '',
	googleClientId: GOOGLE_CLIENT_ID,
	driveToken: null,
	driveFileId: null
};

const elements = {
	sidebar: document.querySelector('#sidebar'),
	chatList: document.querySelector('#chatList'),
	emptySidebar: document.querySelector('#emptySidebar'),
	chatSearch: document.querySelector('#chatSearch'),
	fileInput: document.querySelector('#fileInput'),
	updateFileInput: document.querySelector('#updateFileInput'),
	welcomeView: document.querySelector('#welcomeView'),
	conversationView: document.querySelector('#conversationView'),
	conversationTitle: document.querySelector('#conversationTitle'),
	conversationMeta: document.querySelector('#conversationMeta'),
	conversationAvatar: document.querySelector('#conversationAvatar'),
	messageArea: document.querySelector('#messageArea'),
	toast: document.querySelector('#toast'),
	authorDialog: document.querySelector('#authorDialog'),
	authorSelect: document.querySelector('#authorSelect'),
	conversationMenu: document.querySelector('#conversationMenu'),
	contactInfoButton: document.querySelector('#contactInfoButton'),
	profileDialog: document.querySelector('#profileDialog'),
	profilePhotoPreview: document.querySelector('#profilePhotoPreview'),
	profilePhotoInput: document.querySelector('#profilePhotoInput'),
	profileNameInput: document.querySelector('#profileNameInput'),
	profilePhoneInput: document.querySelector('#profilePhoneInput'),
	profileNotesInput: document.querySelector('#profileNotesInput'),
	profileDateInput: document.querySelector('#profileDateInput'),
	profileDateLabelInput: document.querySelector('#profileDateLabelInput'),
	importantDates: document.querySelector('#importantDates'),
	searchDialog: document.querySelector('#searchDialog'),
	messageSearchInput: document.querySelector('#messageSearchInput'),
	messageSearchResults: document.querySelector('#messageSearchResults'),
	starredDialog: document.querySelector('#starredDialog'),
	starredResults: document.querySelector('#starredResults')
	,
	styleDialog: document.querySelector('#styleDialog'),
	chatBackgroundColor: document.querySelector('#chatBackgroundColor'),
	myBubbleColor: document.querySelector('#myBubbleColor'),
	otherBubbleColor: document.querySelector('#otherBubbleColor'),
	chatBackgroundImage: document.querySelector('#chatBackgroundImage'),
	driveDialog: document.querySelector('#driveDialog'),
	connectDriveButton: document.querySelector('#connectDriveButton'),
	syncDriveButton: document.querySelector('#syncDriveButton'),
	pullDriveButton: document.querySelector('#pullDriveButton'),
	disconnectDriveButton: document.querySelector('#disconnectDriveButton'),
	storageStatus: document.querySelector('#storageStatus'),
	cloudStatusDot: document.querySelector('#cloudStatusDot'),
	driveDialogStatus: document.querySelector('#driveDialogStatus')
};

function loadChats() {
	try {
		const savedChats = JSON.parse(localStorage.getItem(STORAGE_KEY));
		return Array.isArray(savedChats) ? savedChats : [];
	} catch {
		return [];
	}
}

function saveChats() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state.chats));
		return true;
	} catch (error) {
		console.error('No se pudieron guardar las conversaciones:', error);
		showToast('No hay espacio suficiente para guardar la foto o los datos.');
		return false;
	}
}

function updateDriveStatus(connected, message) {
	const statusMessage = message || (connected ? 'Sincronizado con Drive' : 'Guardado en este dispositivo');
	elements.storageStatus.textContent = statusMessage;
	elements.driveDialogStatus.textContent = statusMessage;
	elements.cloudStatusDot.classList.toggle('cloud-connected', connected);
}

async function requestDriveToken(prompt = 'none') {
	if (!state.googleClientId) throw new Error('Configura tu Google Client ID primero.');
	const started = Date.now();
	while (!window.google?.accounts?.oauth2 && Date.now() - started < 10000) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (!window.google?.accounts?.oauth2) throw new Error('Google Identity Services no terminó de cargar. Recarga la página.');
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback) => (value) => {
			if (settled) return;
			settled = true;
			callback(value);
		};
		const client = google.accounts.oauth2.initTokenClient({
			client_id: state.googleClientId,
			scope: DRIVE_SCOPE,
			callback: finish((response) => response.error ? reject(new Error(response.error_description || response.error)) : resolve(response.access_token)),
			error_callback: finish((error) => reject(new Error(error.type === 'popup_closed' ? 'La ventana de Google se cerró antes de completar el acceso.' : 'Google no pudo abrir la ventana de acceso.')))
		});
		client.requestAccessToken({ prompt });
		setTimeout(() => finish(() => reject(new Error('La autorización de Google tardó demasiado.')))(null), 15000);
	});
}

async function connectDrive({ allowConsent = true, silentFirst = true } = {}) {
	if (silentFirst) {
		try {
			state.driveToken = await requestDriveToken('none');
		} catch (error) {
			if (!allowConsent) throw error;
			state.driveToken = await requestDriveToken('consent');
		}
	} else {
		state.driveToken = await requestDriveToken('consent');
	}
	elements.connectDriveButton.hidden = true;
	elements.syncDriveButton.hidden = false;
	elements.pullDriveButton.hidden = false;
	elements.disconnectDriveButton.hidden = false;
	await syncDrive();
}

async function driveRequest(url, options = {}) {
	const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${state.driveToken}`, ...(options.headers || {}) } });
	const responseText = await response.text();
	if (!response.ok) {
		let detail = '';
		try {
			const errorData = JSON.parse(responseText);
			detail = errorData.error?.errors?.[0]?.reason || errorData.error?.message || '';
		} catch { detail = responseText.slice(0, 180); }
		if (detail === 'accessNotConfigured') detail = 'Activa Google Drive API en Google Cloud.';
		if (detail === 'insufficientPermissions') detail = 'El token no tiene el scope drive.appdata. Desconecta y vuelve a conectar Drive.';
		throw new Error(`Drive respondió ${response.status}: ${detail || 'petición rechazada'}`);
	}
	return responseText ? JSON.parse(responseText) : null;
}

async function findDriveFile() {
	const query = encodeURIComponent(`name = '${DRIVE_FILE_NAME}' and trashed = false`);
	const result = await driveRequest(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&fields=files(id,name)`);
	return result.files?.[0] || null;
}

async function downloadDriveChats(fileId) {
	const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${state.driveToken}` } });
	if (!response.ok) throw new Error('No se pudo descargar el archivo de Drive.');
	const data = await response.json();
	return Array.isArray(data.chats) ? data.chats : [];
}

function mergeChatRecords(localChats, remoteChats) {
	const byId = new Map(remoteChats.map((chat) => [chat.id, chat]));
	localChats.forEach((localChat) => {
		const remoteChat = byId.get(localChat.id);
		if (!remoteChat) { byId.set(localChat.id, localChat); return; }
		remoteChat.messages = mergeMessages(remoteChat.messages || [], localChat.messages || []);
		Object.assign(remoteChat, localChat, { messages: remoteChat.messages });
	});
	return [...byId.values()].sort((first, second) => (second.importedAt || 0) - (first.importedAt || 0));
}

async function uploadDriveChats(fileId) {
	const metadata = { name: DRIVE_FILE_NAME, mimeType: 'application/json' };
	if (!fileId) metadata.parents = ['appDataFolder'];
	const body = JSON.stringify({ version: 1, updatedAt: Date.now(), chats: state.chats });
	const multipart = `--drive-boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--drive-boundary\r\nContent-Type: application/json\r\n\r\n${body}\r\n--drive-boundary--\r\n`;
	const url = fileId ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
	const result = await driveRequest(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary="drive-boundary"' }, body: new Blob([multipart], { type: 'multipart/related; boundary="drive-boundary"' }) });
	state.driveFileId = fileId || result.id;
}

async function syncDrive() {
	if (!state.driveToken) return;
	updateDriveStatus(true, 'Sincronizando...');
	try {
		const file = state.driveFileId ? { id: state.driveFileId } : await findDriveFile();
		const remoteChats = file ? await downloadDriveChats(file.id) : [];
		state.chats = mergeChatRecords(state.chats, remoteChats);
		if (!saveChats()) throw new Error('No se pudieron guardar los datos fusionados.');
		await uploadDriveChats(file?.id);
		renderChatList();
		if (state.activeChatId) openChat(state.activeChatId);
		updateDriveStatus(true, `Drive sincronizado · ${new Date().toLocaleTimeString()}`);
		showToast('Chats sincronizados con Drive');
	} catch (error) {
		console.error(error);
		updateDriveStatus(false, 'Error de sincronización');
		showToast(error.message || 'No se pudo sincronizar con Drive.');
	}
}

async function pullDriveChats() {
	if (!state.driveToken) {
		showToast('Conecta Drive para traer tus chats.');
		return;
	}
	updateDriveStatus(true, 'Trayendo chats...');
	try {
		const file = state.driveFileId ? { id: state.driveFileId } : await findDriveFile();
		if (!file) throw new Error('No encontré conversaciones guardadas en Drive.');
		state.driveFileId = file.id;
		const remoteChats = await downloadDriveChats(file.id);
		const previousChatCount = state.chats.length;
		state.chats = mergeChatRecords(state.chats, remoteChats);
		if (!saveChats()) throw new Error('No se pudieron guardar los chats recuperados.');
		renderChatList();
		if (state.activeChatId) openChat(state.activeChatId);
		updateDriveStatus(true, `Drive sincronizado · ${new Date().toLocaleTimeString()}`);
		elements.driveDialog.hidden = true;
		showToast(`${state.chats.length - previousChatCount} chats recuperados de Drive`);
	} catch (error) {
		console.error(error);
		updateDriveStatus(false, 'Error al traer chats');
		showToast(error.message || 'No se pudieron traer los chats.');
	}
}

function openFilePicker() {
	elements.fileInput.click();
}

function parseWhatsAppChat(text) {
	const lines = text.replace(/\uFEFF/g, '').split(/\r?\n/);
	const androidPattern = /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?)\s+-\s+(.*)$/i;
	const iosPattern = /^\[?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*,\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?)\]\s+(.*)$/i;
	const messages = [];
	let currentMessage = null;

	for (const line of lines) {
		const cleanLine = line.replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]/g, '');
		const match = cleanLine.match(iosPattern) || cleanLine.match(androidPattern);
		if (match) {
			if (currentMessage) messages.push(currentMessage);
			const content = match[3].trim();
			const separator = content.indexOf(':');
			const author = separator > -1 ? content.slice(0, separator).trim() : null;
			const body = separator > -1 ? content.slice(separator + 1).trim() : content;
			currentMessage = {
				date: match[1],
				time: match[2].replace(/\s+/g, ' ').trim(),
				author,
				body: body.trim()
			};
		} else if (currentMessage && cleanLine.trim()) {
			currentMessage.body += `\n${cleanLine.trim()}`;
		}
	}
	if (currentMessage) messages.push(currentMessage);
	return messages;
}

function messageTimestamp(message) {
	const dateParts = message.date.split(/[./-]/).map(Number);
	let [hours, minutes, seconds = 0] = message.time.replace(/\u00a0/g, ' ').match(/\d+/g).map(Number);
	const isPm = /p\.?\s*m/i.test(message.time);
	if (isPm && hours < 12) hours += 12;
	if (!isPm && /a\.?\s*m/i.test(message.time) && hours === 12) hours = 0;
	const year = dateParts[2] < 100 ? 2000 + dateParts[2] : dateParts[2];
	return new Date(year, dateParts[1] - 1, dateParts[0], hours, minutes, seconds).getTime();
}

function messageKey(message) {
	return [message.date, message.time, authorKey(message.author), message.body].join('|');
}

function mergeMessages(existingMessages, incomingMessages) {
	const messages = [...existingMessages, ...incomingMessages];
	const unique = [...new Map(messages.map((message) => [messageKey(message), message])).values()];
	return unique.sort((first, second) => messageTimestamp(first) - messageTimestamp(second));
}

function updateActiveChat(file) {
	const chat = getActiveChat();
	if (!chat || !file) return;
	const reader = new FileReader();
	reader.onload = () => {
		const incomingMessages = parseWhatsAppChat(String(reader.result));
		if (!incomingMessages.length) {
			showToast('No encontré mensajes con formato de WhatsApp.');
			return;
		}
		const previousCount = chat.messages.length;
		chat.messages = mergeMessages(chat.messages, incomingMessages);
		chat.myAuthor ||= getOwnAuthor(chat.messages);
		if (!saveChats()) return;
		state.messageStart = Math.max(0, chat.messages.length - MESSAGE_BATCH_SIZE);
		openChat(chat.id);
		showToast(`${chat.messages.length - previousCount} mensajes nuevos añadidos`);
		elements.updateFileInput.value = '';
	};
	reader.onerror = () => showToast('No pude leer ese archivo.');
	reader.readAsText(file, 'UTF-8');
}

function makeChatName(fileName, messages) {
	const authors = [...new Set(messages.map((message) => message.author).filter(Boolean))];
	const baseName = fileName.replace(/\.txt$/i, '').replace(/[_-]+/g, ' ').trim();
	return baseName || authors.join(' y ') || 'Chat importado';
}

function authorKey(author) {
	return author?.trim().toLocaleLowerCase() || '';
}

function getOwnAuthor(messages) {
	const authors = [...new Set(messages.map((message) => message.author).filter(Boolean))];
	return authors.find((author) => ['@', 'yo'].includes(authorKey(author))) || authors[0] || null;
}

function getChatAuthors(messages) {
	return [...new Map(messages.filter((message) => message.author).map((message) => [authorKey(message.author), message.author])).values()];
}

function getActiveChat() {
	return state.chats.find((chat) => chat.id === state.activeChatId);
}

function isPersonalChat(chat) {
	return getChatAuthors(chat.messages).length <= 2;
}

function getProfile(chat) {
	chat.profile ||= { name: chat.name, phone: '', notes: '', photo: '', dates: [] };
	chat.profile.dates ||= [];
	return chat.profile;
}

function getChatTheme(chat) {
	chat.theme ||= { background: '#f3efe7', mine: '#e9f0e8', theirs: '#fffdf9', image: '' };
	return chat.theme;
}

function applyChatTheme(chat) {
	const theme = getChatTheme(chat);
	elements.conversationView.style.setProperty('--chat-background', theme.background);
	elements.conversationView.style.setProperty('--chat-bubble-mine', theme.mine);
	elements.conversationView.style.setProperty('--chat-bubble-theirs', theme.theirs);
	elements.conversationView.style.setProperty('--chat-background-image', theme.image ? `url("${theme.image}")` : 'none');
}

function getChatNameForAuthor(fileName, messages, myAuthor) {
	const authors = getChatAuthors(messages);
	if (authors.length === 2) {
		const otherAuthor = authors.find((author) => authorKey(author) !== authorKey(myAuthor));
		if (otherAuthor) return otherAuthor;
	}
	return makeChatName(fileName, messages);
}

function finishImport(chat, myAuthor) {
	chat.myAuthor = myAuthor;
	chat.name = getChatNameForAuthor(chat.fileName, chat.messages, myAuthor);
	chat.profile = { name: chat.name, phone: '', notes: '', photo: '', dates: [] };
	delete chat.fileName;
	state.chats.unshift(chat);
	state.pendingChat = null;
	saveChats();
	renderChatList();
	openChat(chat.id);
	showToast(`${chat.messages.length} mensajes importados`);
	elements.fileInput.value = '';
}

function showAuthorDialog(chat) {
	const authors = getChatAuthors(chat.messages);
	state.pendingChat = chat;
	elements.authorSelect.innerHTML = authors.map((author) => `<option value="${escapeHtml(author)}">${escapeHtml(author)}</option>`).join('');
	elements.authorDialog.hidden = false;
	elements.authorSelect.focus();
}

function closeAuthorDialog() {
	state.pendingChat = null;
	elements.authorDialog.hidden = true;
	elements.fileInput.value = '';
}

function importChat(file) {
	if (!file) return;
	const reader = new FileReader();
	reader.onload = () => {
		const messages = parseWhatsAppChat(String(reader.result));
		if (!messages.length) {
			showToast('No encontré mensajes con formato de WhatsApp.');
			return;
		}
		const chat = {
			id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
			name: makeChatName(file.name, messages),
			fileName: file.name,
			importedAt: Date.now(),
			myAuthor: null,
			messages
		};
		const authors = getChatAuthors(messages);
		if (authors.length) showAuthorDialog(chat);
		else finishImport(chat, null);
	};
	reader.onerror = () => showToast('No pude leer ese archivo.');
	reader.readAsText(file, 'UTF-8');
}

function getInitial(name) {
	return (name || '?').trim().charAt(0).toUpperCase();
}

function renderChatList() {
	const filteredChats = state.chats.filter((chat) => {
		const haystack = `${chat.name} ${chat.messages.at(-1)?.body || ''}`.toLowerCase();
		return haystack.includes(state.search.toLowerCase());
	});
	elements.chatList.innerHTML = '';
	elements.emptySidebar.hidden = state.chats.length > 0;

	if (!filteredChats.length && state.chats.length) {
		elements.chatList.innerHTML = '<p class="no-results">No hay coincidencias.</p>';
	}
	filteredChats.forEach((chat) => {
		const lastMessage = chat.messages.at(-1);
		const profile = getProfile(chat);
		const item = document.createElement('button');
		item.className = `chat-item${chat.id === state.activeChatId ? ' active' : ''}`;
		item.type = 'button';
		item.innerHTML = `<span class="chat-avatar">${escapeHtml(getInitial(chat.name))}</span><span class="chat-summary"><strong>${escapeHtml(chat.name)}</strong><span>${escapeHtml(lastMessage?.body || 'Sin mensajes')}</span></span><time>${escapeHtml(lastMessage?.time || '')}</time>`;
		const avatar = item.querySelector('.chat-avatar');
		if (profile.photo) {
			avatar.textContent = '';
			avatar.style.backgroundImage = `url("${profile.photo}")`;
			avatar.classList.add('has-photo');
		}
		item.addEventListener('click', () => openChat(chat.id));
		elements.chatList.appendChild(item);
	});
}

function openChat(id) {
	const chat = state.chats.find((item) => item.id === id);
	if (!chat) return;
	chat.myAuthor ||= getOwnAuthor(chat.messages);
	getProfile(chat);
	state.activeChatId = id;
	state.messageStart = Math.max(0, chat.messages.length - MESSAGE_BATCH_SIZE);
	elements.welcomeView.hidden = true;
	elements.conversationView.hidden = false;
	elements.conversationTitle.textContent = chat.name;
	elements.conversationMeta.textContent = `${chat.messages.length} ${chat.messages.length === 1 ? 'mensaje' : 'mensajes'}`;
	elements.conversationAvatar.textContent = chat.profile.photo ? '' : getInitial(chat.name);
	elements.conversationView.dataset.style = chat.style || 0;
	applyChatTheme(chat);
	elements.conversationAvatar.style.backgroundImage = chat.profile.photo ? `url("${chat.profile.photo}")` : '';
	elements.conversationAvatar.classList.toggle('has-photo', Boolean(chat.profile.photo));
	elements.contactInfoButton.hidden = !isPersonalChat(chat);
	renderMessages(chat);
	renderChatList();
	elements.sidebar.classList.add('mobile-hidden');
}

function renderMessages(chat) {
	elements.messageArea.innerHTML = '';
	const visibleMessages = chat.messages.slice(state.messageStart);
	let lastDate = '';
	const fragment = document.createDocumentFragment();
	visibleMessages.forEach((message) => {
		if (message.date !== lastDate) {
			const dateDivider = document.createElement('div');
			dateDivider.className = 'date-divider';
			dateDivider.textContent = message.date;
			fragment.appendChild(dateDivider);
			lastDate = message.date;
		}
		const bubble = document.createElement('article');
		bubble.className = `message-row ${message.author ? 'with-author' : 'system-message'}`;
		const isMine = authorKey(message.author) === authorKey(chat.myAuthor);
		if (message.author) bubble.classList.add(isMine ? 'mine' : 'theirs');
		const author = message.author && !isMine ? `<span class="message-author">${escapeHtml(message.author)}</span>` : '';
		const starred = chat.starred?.includes(chat.messages.indexOf(message));
		bubble.innerHTML = `<div class="bubble">${author}<p>${escapeHtml(message.body).replace(/\n/g, '<br>')} </p><div class="bubble-footer"><time>${escapeHtml(message.time)}</time><button class="star-message${starred ? ' selected' : ''}" type="button" data-message-index="${chat.messages.indexOf(message)}" title="${starred ? 'Quitar de destacados' : 'Destacar mensaje'}">${starred ? '★' : '☆'}</button></div></div>`;
		bubble.querySelector('.star-message').addEventListener('click', (event) => toggleStarred(Number(event.currentTarget.dataset.messageIndex)));
		fragment.appendChild(bubble);
	});
	elements.messageArea.classList.toggle('large-chat', chat.messages.length > MESSAGE_BATCH_SIZE);
	elements.messageArea.appendChild(fragment);
	elements.messageArea.scrollTop = elements.messageArea.scrollHeight;
}

function toggleStarred(index) {
	const chat = getActiveChat();
	if (!chat) return;
	chat.starred ||= [];
	chat.starred = chat.starred.includes(index) ? chat.starred.filter((item) => item !== index) : [...chat.starred, index];
	saveChats();
	renderMessages(chat);
}

function closeDialog(dialog) {
	dialog.hidden = true;
}

function prepareProfileImage(dataUrl) {
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => {
			const maxSize = 512;
			const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
			canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
			canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
			resolve(canvas.toDataURL('image/jpeg', 0.82));
		};
		image.onerror = () => resolve(dataUrl);
		image.src = dataUrl;
	});
}

function openProfile() {
	const chat = getActiveChat();
	if (!chat) return;
	const profile = getProfile(chat);
	state.profilePhotoDraft = profile.photo || '';
	elements.profileNameInput.value = profile.name || chat.name;
	elements.profilePhoneInput.value = profile.phone || '';
	elements.profileNotesInput.value = profile.notes || '';
	elements.profileDateInput.value = '';
	elements.profileDateLabelInput.value = '';
	elements.profilePhotoPreview.textContent = getInitial(profile.name || chat.name);
	elements.profilePhotoPreview.style.backgroundImage = state.profilePhotoDraft ? `url("${state.profilePhotoDraft}")` : '';
	elements.profilePhotoPreview.classList.toggle('has-photo', Boolean(state.profilePhotoDraft));
	renderImportantDates(profile);
	elements.profileDialog.hidden = false;
}

function renderImportantDates(profile) {
	elements.importantDates.innerHTML = profile.dates.length ? '<p class="dates-heading">Fechas importantes</p>' : '';
	profile.dates.forEach((item, index) => {
		const row = document.createElement('div');
		row.className = 'important-date-row';
		row.innerHTML = `<span><strong>${escapeHtml(item.label || 'Fecha')}</strong><small>${escapeHtml(item.date)}</small></span><button type="button" data-date-index="${index}" aria-label="Eliminar fecha">×</button>`;
		row.querySelector('button').addEventListener('click', () => {
			profile.dates.splice(index, 1);
			saveChats();
			renderImportantDates(profile);
		});
		elements.importantDates.appendChild(row);
	});
}

function saveProfile() {
	const chat = getActiveChat();
	if (!chat) return;
	const profile = getProfile(chat);
	const previousName = profile.name || chat.name;
	const nextName = elements.profileNameInput.value.trim() || chat.name;
	if (authorKey(previousName) && authorKey(previousName) !== authorKey(nextName)) {
		chat.messages.forEach((message) => {
			if (authorKey(message.author) === authorKey(previousName)) message.author = nextName;
		});
		if (authorKey(chat.myAuthor) === authorKey(previousName)) chat.myAuthor = nextName;
	}
	profile.name = nextName;
	profile.phone = elements.profilePhoneInput.value.trim();
	profile.notes = elements.profileNotesInput.value.trim();
	profile.photo = state.profilePhotoDraft;
	if (elements.profileDateInput.value) {
		profile.dates.push({ date: elements.profileDateInput.value, label: elements.profileDateLabelInput.value.trim() || 'Fecha importante' });
	}
	chat.name = profile.name;
	if (!saveChats()) return;
	elements.conversationTitle.textContent = chat.name;
	elements.conversationAvatar.textContent = profile.photo ? '' : getInitial(chat.name);
	elements.conversationAvatar.style.backgroundImage = profile.photo ? `url("${profile.photo}")` : '';
	elements.conversationAvatar.classList.toggle('has-photo', Boolean(profile.photo));
	renderMessages(chat);
	renderChatList();
	renderImportantDates(profile);
	elements.profileDateInput.value = '';
	elements.profileDateLabelInput.value = '';
	elements.profileDialog.hidden = true;
	showToast('Perfil guardado');
}

function showSearchResults() {
	const chat = getActiveChat();
	if (!chat) return;
	const query = state.messageQuery.toLocaleLowerCase();
	const matches = query ? chat.messages.map((message, index) => ({ message, index })).filter(({ message }) => `${message.author || ''} ${message.body}`.toLocaleLowerCase().includes(query)) : [];
	elements.messageSearchResults.innerHTML = matches.length ? '' : `<p class="search-empty">${query ? 'No se encontraron mensajes.' : 'Escribe una palabra para buscar.'}</p>`;
	matches.slice(0, 80).forEach(({ message, index }) => {
		const result = document.createElement('button');
		result.className = 'search-result';
		result.innerHTML = `<strong>${escapeHtml(message.author || 'Sistema')}</strong><span>${escapeHtml(message.body)}</span><time>${escapeHtml(message.date)} · ${escapeHtml(message.time)}</time>`;
		result.addEventListener('click', () => {
			state.messageStart = Math.max(0, index - 20);
			renderMessages(chat);
			closeDialog(elements.searchDialog);
		});
		elements.messageSearchResults.appendChild(result);
	});
}

function renderStarred() {
	const chat = getActiveChat();
	if (!chat) return;
	const starred = (chat.starred || []).map((index) => chat.messages[index]).filter(Boolean);
	elements.starredResults.innerHTML = starred.length ? '' : '<p class="search-empty">Todavía no hay mensajes destacados.</p>';
	starred.forEach((message) => {
		const result = document.createElement('div');
		result.className = 'search-result starred-result';
		result.innerHTML = `<strong>${escapeHtml(message.author || 'Sistema')}</strong><span>${escapeHtml(message.body)}</span><time>${escapeHtml(message.date)} · ${escapeHtml(message.time)}</time>`;
		elements.starredResults.appendChild(result);
	});
}

function openChatStyle() {
	if (window.matchMedia('(min-width: 681px)').matches) {
		showToast('El estilo personalizado solo está disponible en móvil.');
		return;
	}
	const chat = getActiveChat();
	if (!chat) return;
	const theme = getChatTheme(chat);
	state.chatBackgroundDraft = theme.image;
	elements.chatBackgroundColor.value = theme.background;
	elements.myBubbleColor.value = theme.mine;
	elements.otherBubbleColor.value = theme.theirs;
	elements.chatBackgroundImage.value = '';
	elements.styleDialog.hidden = false;
}

function saveChatStyle() {
	const chat = getActiveChat();
	if (!chat) return;
	const theme = getChatTheme(chat);
	theme.background = elements.chatBackgroundColor.value;
	theme.mine = elements.myBubbleColor.value;
	theme.theirs = elements.otherBubbleColor.value;
	theme.image = state.chatBackgroundDraft;
	applyChatTheme(chat);
	if (!saveChats()) return;
	elements.styleDialog.hidden = true;
	showToast('Estilo guardado');
}

function loadOlderMessages() {
	const chat = state.chats.find((item) => item.id === state.activeChatId);
	if (!chat || state.messageStart === 0) return;
	const previousHeight = elements.messageArea.scrollHeight;
	const previousTop = elements.messageArea.scrollTop;
	state.messageStart = Math.max(0, state.messageStart - MESSAGE_BATCH_SIZE);
	renderMessagesWithoutScrollReset(chat);
	elements.messageArea.scrollTop = elements.messageArea.scrollHeight - previousHeight + previousTop;
}

function renderMessagesWithoutScrollReset(chat) {
	const currentTop = elements.messageArea.scrollTop;
	renderMessages(chat);
	elements.messageArea.scrollTop = currentTop;
}

function deleteActiveChat() {
	const chat = state.chats.find((item) => item.id === state.activeChatId);
	if (!chat || !window.confirm(`¿Eliminar la conversación "${chat.name}"?`)) return;
	state.chats = state.chats.filter((item) => item.id !== state.activeChatId);
	state.activeChatId = null;
	saveChats();
	elements.conversationView.hidden = true;
	elements.welcomeView.hidden = false;
	elements.sidebar.classList.remove('mobile-hidden');
	renderChatList();
}

function escapeHtml(value) {
	return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

let toastTimer;
function showToast(message) {
	elements.toast.textContent = message;
	elements.toast.classList.add('visible');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2800);
}

document.querySelector('#newChatButton').addEventListener('click', openFilePicker);
document.querySelector('#emptyImportButton').addEventListener('click', openFilePicker);
document.querySelector('#welcomeImportButton').addEventListener('click', openFilePicker);
document.querySelector('#fileInput').addEventListener('change', (event) => importChat(event.target.files[0]));
document.querySelector('#updateFileInput').addEventListener('change', (event) => updateActiveChat(event.target.files[0]));
document.querySelector('#driveButton').addEventListener('click', () => {
	elements.driveDialog.hidden = false;
	if (state.driveToken) {
		updateDriveStatus(true, 'Drive conectado');
		return;
	}
	updateDriveStatus(false, 'Comprobando sesión de Google...');
	connectDrive({ allowConsent: false }).catch(() => updateDriveStatus(false, 'No conectado · pulsa Conectar Drive'));
});
document.querySelector('#closeDriveButton').addEventListener('click', () => { elements.driveDialog.hidden = true; });
document.querySelector('#connectDriveButton').addEventListener('click', async () => {
	updateDriveStatus(false, 'Conectando con Google...');
	try {
		await connectDrive({ silentFirst: false });
	} catch (error) {
		updateDriveStatus(false, 'No se pudo conectar');
		showToast(error.message || 'No se pudo conectar Drive.');
	}
});
document.querySelector('#syncDriveButton').addEventListener('click', syncDrive);
document.querySelector('#pullDriveButton').addEventListener('click', pullDriveChats);
document.querySelector('#disconnectDriveButton').addEventListener('click', () => {
	if (state.driveToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(state.driveToken);
	state.driveToken = null;
	state.driveFileId = null;
	elements.connectDriveButton.hidden = false;
	elements.syncDriveButton.hidden = true;
	elements.pullDriveButton.hidden = true;
	elements.disconnectDriveButton.hidden = true;
	updateDriveStatus(false);
});
document.querySelector('#cancelAuthorButton').addEventListener('click', closeAuthorDialog);
document.querySelector('#confirmAuthorButton').addEventListener('click', () => {
	if (!state.pendingChat) return;
	finishImport(state.pendingChat, elements.authorSelect.value);
	elements.authorDialog.hidden = true;
});
document.querySelector('#conversationMenuButton').addEventListener('click', (event) => {
	event.stopPropagation();
	elements.conversationMenu.hidden = !elements.conversationMenu.hidden;
});
document.querySelector('#searchChatButton').addEventListener('click', () => {
	elements.conversationMenu.hidden = true;
	state.messageQuery = '';
	elements.messageSearchInput.value = '';
	elements.searchResults = '';
	elements.searchDialog.hidden = false;
	elements.messageSearchInput.focus();
	showSearchResults();
});
document.querySelector('#starredButton').addEventListener('click', () => {
	elements.conversationMenu.hidden = true;
	renderStarred();
	elements.starredDialog.hidden = false;
});
document.querySelector('#updateChatButton').addEventListener('click', () => {
	elements.conversationMenu.hidden = true;
	if (getActiveChat()) elements.updateFileInput.click();
});
document.querySelector('#chatStyleButton').addEventListener('click', () => {
	elements.conversationMenu.hidden = true;
	openChatStyle();
});
document.querySelector('#contactInfoButton').addEventListener('click', () => {
	elements.conversationMenu.hidden = true;
	openProfile();
});
document.querySelector('#deleteChatButton').addEventListener('click', () => {
	elements.conversationMenu.hidden = true;
	deleteActiveChat();
});
document.querySelectorAll('.profile-trigger').forEach((button) => button.addEventListener('click', openProfile));
document.querySelector('#closeProfileButton').addEventListener('click', () => closeDialog(elements.profileDialog));
document.querySelector('#saveProfileButton').addEventListener('click', saveProfile);
document.querySelector('#saveChatStyleButton').addEventListener('click', saveChatStyle);
document.querySelector('#clearChatBackground').addEventListener('click', () => {
	state.chatBackgroundDraft = '';
	elements.chatBackgroundImage.value = '';
});
document.querySelector('#chatBackgroundImage').addEventListener('change', (event) => {
	const file = event.target.files[0];
	if (!file) return;
	const reader = new FileReader();
	reader.onload = () => prepareProfileImage(String(reader.result)).then((imageData) => { state.chatBackgroundDraft = imageData; });
	reader.readAsDataURL(file);
});
document.querySelector('#profilePhotoInput').addEventListener('change', (event) => {
	const file = event.target.files[0];
	if (!file) return;
	const reader = new FileReader();
	reader.onload = () => {
		prepareProfileImage(String(reader.result)).then((imageData) => {
			state.profilePhotoDraft = imageData;
			elements.profilePhotoPreview.style.backgroundImage = `url("${imageData}")`;
			elements.profilePhotoPreview.classList.add('has-photo');
		});
	};
	reader.readAsDataURL(file);
});
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => closeDialog(document.querySelector(`#${button.dataset.closeDialog}`))));
elements.messageSearchInput.addEventListener('input', (event) => {
	state.messageQuery = event.target.value.trim();
	showSearchResults();
});
document.addEventListener('click', (event) => {
	if (!event.target.closest('.conversation-actions')) elements.conversationMenu.hidden = true;
});
document.querySelector('#backButton').addEventListener('click', () => {
	elements.sidebar.classList.remove('mobile-hidden');
	elements.conversationView.hidden = true;
	elements.welcomeView.hidden = false;
	elements.conversationMenu.hidden = true;
});
elements.chatSearch.addEventListener('input', (event) => {
	state.search = event.target.value.trim();
	renderChatList();
});
elements.messageArea.addEventListener('scroll', () => {
	if (elements.messageArea.scrollTop < 180) loadOlderMessages();
});

renderChatList();
