// AI Chatbot for video generation
// Supports Hindi & English, multiple AI backends (Claude, Gemini, OpenAI)

import { getSettings, saveSettings } from './ai.js';
import { chat } from './ai.js';

const SYSTEM_PROMPT = `You are a helpful AI assistant for creating YouTube Shorts and story videos. 
You help users create engaging video stories with proper characters, dialogue, and animations.
Respond in both Hindi and English as needed. Be conversational and helpful.
When user asks to create a video:
1. Ask for the topic/story idea
2. Ask for duration (15-30 seconds for Shorts)
3. Ask for number of parts (1-3)
4. Ask for language preference (Hindi, English, Hinglish)
5. Confirm and create the video project
If user mentions upload, ask for YouTube channel name and permission.`;

export class ChatBot {
  constructor() {
    this.messages = [];
    this.isOpen = false;
    this.currentProject = null;
    this.pendingVideoCreation = null;
    this.init();
  }

  init() {
    this.panel = document.getElementById('chatbot');
    this.messagesDiv = document.getElementById('chatMessages');
    this.input = document.getElementById('chatInput');
    this.sendBtn = document.getElementById('chatSendBtn');
    this.toggleBtn = document.getElementById('chatToggleBtn');
    this.closeBtn = document.getElementById('chatCloseBtn');

    if (!this.panel) return; // Chatbot not in DOM

    this.toggleBtn.onclick = () => this.toggle();
    this.closeBtn.onclick = () => this.close();
    this.sendBtn.onclick = () => this.send();
    this.input.onkeypress = (e) => e.key === 'Enter' && this.send();

    this.addMessage('bot', '🎬 Namaste! Aapka AI video assistant yahan hai. Mujhe batayein - aap kaunsi kahani banana chahte hain? 📺\n\n(Hi! I\'m your AI video assistant. Tell me - what story do you want to create?)');
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.isOpen = true;
    this.panel.classList.add('open');
    this.toggleBtn.style.display = 'none';
    this.input.focus();
  }

  close() {
    this.isOpen = false;
    this.panel.classList.remove('open');
    this.toggleBtn.style.display = 'flex';
  }

  addMessage(role, text) {
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    this.messages.push({ role, text, time });
    
    const msgEl = document.createElement('div');
    msgEl.className = `chat-message ${role}`;
    
    if (role === 'bot') {
      msgEl.innerHTML = `
        <div class="msg-bubble">
          <div class="msg-text">${this.escapeHtml(text)}</div>
          <div class="msg-time">${time}</div>
        </div>`;
    } else {
      msgEl.innerHTML = `
        <div class="msg-bubble">
          <div class="msg-text">${this.escapeHtml(text)}</div>
          <div class="msg-time">${time}</div>
        </div>`;
    }
    
    this.messagesDiv.appendChild(msgEl);
    this.messagesDiv.scrollTop = this.messagesDiv.scrollHeight;
  }

  async send() {
    const text = this.input.value.trim();
    if (!text) return;

    this.input.value = '';
    this.addMessage('user', text);

    // Check for specific intents
    if (this.matchIntent(text, 'create|video|story|banao')) {
      await this.handleCreateVideo(text);
    } else if (this.matchIntent(text, 'upload|youtube')) {
      await this.handleUpload(text);
    } else if (this.matchIntent(text, 'status|progress')) {
      await this.handleStatus(text);
    } else {
      await this.handleGeneralChat(text);
    }
  }

  matchIntent(text, keywords) {
    const lowerText = text.toLowerCase();
    return keywords.split('|').some(kw => lowerText.includes(kw.toLowerCase()));
  }

  async handleCreateVideo(text) {
    this.addMessage('bot', '📝 Bilkul! Aapka video banane mein madad karunga.\n\nPehle mujhe batayein:\n1️⃣ Story ka topic kya hai?\n2️⃣ Duration (15-30 seconds)?\n3️⃣ Kitne parts chaahiye (1-3)?\n4️⃣ Language: Hindi, English ya Hinglish?\n\n(Sure! I\'ll help you create a video.\n\nTell me:\n1️⃣ What\'s the story topic?\n2️⃣ Duration (15-30 seconds)?\n3️⃣ How many parts (1-3)?\n4️⃣ Language: Hindi, English, or Hinglish?)');
    
    // Try to extract info from text
    const topicMatch = text.match(/about\s+(.+?)(?:\s+duration|\s+parts|$)/i) || text.match(/topic\s+(.+?)(?:\s+duration|\s+parts|$)/i);
    const durationMatch = text.match(/(\d+)\s*(second|sec|s)/i) || text.match(/duration\s+(\d+)/i);
    const partsMatch = text.match(/(\d)\s*(part|parts)/i);
    const langMatch = text.match(/hindi|english|hinglish/i);

    if (topicMatch && durationMatch && partsMatch) {
      const topic = topicMatch[1].trim();
      const duration = parseInt(durationMatch[1]);
      const parts = parseInt(partsMatch[1]);
      const lang = langMatch ? langMatch[0].toLowerCase() : 'hinglish';
      
      this.pendingVideoCreation = { topic, duration, parts, lang };
      this.addMessage('bot', `✅ Bilkul! Main inka video bana dunga:\n\n📌 Topic: ${topic}\n⏱️ Duration: ${duration}s\n📺 Parts: ${parts}\n🗣️ Language: ${lang}\n\n'Create' button kab click karoge? (Ready when you are!)`);
    }
  }

  async handleUpload(text) {
    if (!this.currentProject) {
      this.addMessage('bot', '❌ Pehle video banao, phir upload kar sakte ho! (Create a video first, then upload!)');
      return;
    }

    const channelMatch = text.match(/channel\s+(.+?)(?:\s+yes|\s+ok|$)/i);
    if (channelMatch) {
      const channel = channelMatch[1].trim();
      this.addMessage('bot', `✅ Theek hai! Video '${channel}' channel par upload hoga. Processing...`);
      // Trigger upload in app.js
      window.dispatchEvent(new CustomEvent('chatbot-upload', { detail: { channel } }));
    } else {
      this.addMessage('bot', '📺 Channel name batayein? (e.g., "channel HarshuVlog")\n\nAur haan, permission de rahe ho upload ke liye?');
    }
  }

  async handleStatus(text) {
    if (this.currentProject) {
      this.addMessage('bot', `📊 Project mein kayi hote:
🔸 Title: ${this.currentProject.title}
🔸 Format: ${this.currentProject.format}
🔸 Duration: ${this.currentProject.duration}s\n
Aur updates lenge!`);
    } else {
      this.addMessage('bot', 'Abhi koi video banane ke liye ready nahi ho. Naya create karna hai?');
    }
  }

  async handleGeneralChat(text) {
    try {
      const response = await chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        { json: false }
      );
      this.addMessage('bot', response);
    } catch (err) {
      this.addMessage('bot', `❌ Kuch gadbad ho gayi: ${err.message}\n\nDobara try karein? (Something went wrong. Try again?)`);
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  setCurrentProject(project) {
    this.currentProject = project;
  }

  getPendingVideoCreation() {
    const result = this.pendingVideoCreation;
    this.pendingVideoCreation = null;
    return result;
  }
}

// Global chatbot instance
export const chatbot = new ChatBot();
