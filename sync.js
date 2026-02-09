const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const BASE_URL = 'https://global-indesign.base44.app';
const OUT_DIR = __dirname;
const ASSETS_DIR = path.join(OUT_DIR, 'assets');

if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

async function downloadFile(url, filepath) {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'arraybuffer'
        });
        fs.writeFileSync(filepath, response.data);
        console.log(`Downloaded: ${url} -> ${filepath}`);
        return response.data;
    } catch (error) {
        console.error(`Error downloading ${url}: ${error.message}`);
        return null;
    }
}

async function processCss(cssContent, baseUrl) {
    const cssText = cssContent.toString();
    const urlRegex = /url\((['"]?)(.*?)\1\)/g;
    let match;
    const urls = [];
    
    while ((match = urlRegex.exec(cssText)) !== null) {
        const url = match[2];
        if (!url.startsWith('data:') && !url.startsWith('http')) {
            urls.push(url);
        }
    }

    for (const relUrl of urls) {
        // clean query params or hashes
        const cleanRelUrl = relUrl.split('#')[0].split('?')[0];
        const absoluteUrl = new URL(relUrl, baseUrl).href;
        const filename = path.basename(cleanRelUrl);
        const filepath = path.join(ASSETS_DIR, filename);
        
        await downloadFile(absoluteUrl, filepath);
    }
}

async function main() {
    console.log(`Syncing from ${BASE_URL}...`);

    // 1. Fetch index.html
    let html;
    try {
        const response = await axios.get(BASE_URL);
        html = response.data;
    } catch (error) {
        console.error('Failed to fetch index.html');
        process.exit(1);
    }

    const $ = cheerio.load(html);

    // 2. Remove "Edit with Base44" badge
    $('script[src*="badge.js"]').remove();
    console.log('Removed badge.js reference');

    // 3. Process Assets
    const assetsToDownload = [];

    // Helper to add asset
    const addAsset = (url, isCss = false) => {
        if (!url) return;
        if (url.startsWith('data:')) return;
        
        try {
            const absoluteUrl = new URL(url, BASE_URL).href;
            const filename = path.basename(new URL(absoluteUrl).pathname);
            // If it's in assets/ in URL, put in assets/ locally. 
            // Most vite apps put everything in assets/.
            // We will put everything in assets/ except manifest/favicon if they are at root.
            
            let localDir = ASSETS_DIR;
            if (!absoluteUrl.includes('/assets/')) {
                // If it's at root, maybe keep at root? 
                // Let's check manifest.json specifically
                if (filename === 'manifest.json') localDir = OUT_DIR;
            }
            
            assetsToDownload.push({
                url: absoluteUrl,
                filepath: path.join(localDir, filename),
                isCss,
                originalUrl: url
            });
            
            // Return new relative path for HTML
            let newPath;
            if (localDir === OUT_DIR) {
                newPath = `./${filename}`;
            } else {
                newPath = `./assets/${filename}`;
            }
            return newPath;
        } catch (e) {
            console.error(`Invalid URL: ${url}`);
            return url;
        }
    };

    // Process Links (CSS, Icon, Manifest)
    $('link').each((i, el) => {
        const href = $(el).attr('href');
        const rel = $(el).attr('rel');
        const validRels = ['stylesheet', 'icon', 'manifest', 'apple-touch-icon', 'shortcut icon'];
        
        if (href && validRels.includes(rel)) {
            const isCss = rel === 'stylesheet';
            const newPath = addAsset(href, isCss);
            $(el).attr('href', newPath);
        }
    });

    // Process Scripts
    $('script').each((i, el) => {
        const src = $(el).attr('src');
        if (src) {
            const newPath = addAsset(src);
            $(el).attr('src', newPath);
        }
    });

    // Process Images
    $('img').each((i, el) => {
        const src = $(el).attr('src');
        if (src) {
            const newPath = addAsset(src);
            $(el).attr('src', newPath);
        }
    });
    
    // Process Meta Images (OG, Twitter)
    $('meta[property="og:image"], meta[name="twitter:image"]').each((i, el) => {
        const content = $(el).attr('content');
        if (content) {
            const newPath = addAsset(content);
            $(el).attr('content', newPath);
        }
    });

    // Download all assets
    for (const asset of assetsToDownload) {
        const data = await downloadFile(asset.url, asset.filepath);
        if (data && asset.isCss) {
            // If CSS, parse for more assets (fonts, images)
            // We assume CSS is at base URL/assets/style.css
            // So relative URLs in CSS are relative to that.
            await processCss(data, asset.url);
        }
    }

    // 4. Inject Form Fixer Script
    // This script intercepts form submissions and sends them to Formspree
    // because GitHub Pages is static and cannot process backend forms.
    const formFixerScript = `
    <script>
      document.addEventListener('submit', async function(e) {
        // Only intercept if it's a POST request or default form behavior
        // We assume any form submission on this static site intends to contact the owner.
        e.preventDefault();
        
        const form = e.target;
        const data = new FormData(form);
        
        // Use FormSubmit.co which is free and requires no setup other than confirming the email
        // We use the email provided by the user: globalindesign@gmail.com
        const action = 'https://formsubmit.co/globalindesign@gmail.com'; 
        
        // Add hidden configuration fields if they don't exist
        if (!form.querySelector('input[name="_captcha"]')) {
             const captcha = document.createElement('input');
             captcha.type = 'hidden';
             captcha.name = '_captcha';
             captcha.value = 'false'; // Disable captcha for cleaner UX
             form.appendChild(captcha);
        }
        
        if (!form.querySelector('input[name="_subject"]')) {
             const subject = document.createElement('input');
             subject.type = 'hidden';
             subject.name = '_subject';
             subject.value = 'Nouveau message via Global Indesign Studio';
             form.appendChild(subject);
        }
        
        const btn = form.querySelector('[type="submit"], button:not([type="button"])');
        const originalText = btn ? btn.innerText : '';
        if(btn) {
            btn.disabled = true;
            btn.innerText = 'Envoi en cours...';
        }

        try {
          const response = await fetch(action, {
            method: 'POST',
            body: data,
            headers: {
              'Accept': 'application/json'
            }
          });
          if (response.ok) {
            alert('Message envoyé avec succès !');
            form.reset();
          } else {
            const json = await response.json();
            alert('Erreur: ' + (json.errors ? json.errors.map(e => e.message).join(', ') : 'Erreur inconnue'));
          }
        } catch (error) {
          alert('Erreur technique lors de l\\'envoi. Vérifiez que l\\'ID Formspree est correct.');
          console.error('Form Error:', error);
        } finally {
            if(btn) {
                btn.disabled = false;
                btn.innerText = originalText;
            }
        }
      }, true);
    </script>
    `;
    $('body').append(formFixerScript);
    console.log('Injected Form Fixer script');

    // 5. Inject "Light" AI Chatbot
    // A simple, lightweight chatbot that runs locally to answer basic questions and book appointments.
    const chatbotScript = `
    <style>
      #gis-chat-widget {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 9999;
        font-family: 'Arial', sans-serif;
      }
      #gis-chat-btn {
        background-color: #000;
        color: #fff;
        border: none;
        border-radius: 50%;
        width: 60px;
        height: 60px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.3s;
      }
      #gis-chat-btn:hover { transform: scale(1.1); }
      #gis-chat-window {
        display: none;
        position: absolute;
        bottom: 80px;
        right: 0;
        width: 350px;
        height: 500px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 5px 20px rgba(0,0,0,0.2);
        flex-direction: column;
        overflow: hidden;
        border: 1px solid #eee;
      }
      #gis-chat-header {
        background: #000;
        color: #fff;
        padding: 15px;
        font-weight: bold;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      #gis-chat-messages {
        flex: 1;
        padding: 15px;
        overflow-y: auto;
        background: #f9f9f9;
      }
      .gis-msg {
        margin-bottom: 10px;
        padding: 10px;
        border-radius: 8px;
        max-width: 80%;
        font-size: 14px;
        line-height: 1.4;
      }
      .gis-msg-bot {
        background: #e0e0e0;
        color: #333;
        align-self: flex-start;
        border-bottom-left-radius: 2px;
      }
      .gis-msg-user {
        background: #000;
        color: #fff;
        align-self: flex-end;
        margin-left: auto;
        border-bottom-right-radius: 2px;
      }
      #gis-chat-input-area {
        padding: 10px;
        border-top: 1px solid #eee;
        display: flex;
        background: #fff;
      }
      #gis-chat-input {
        flex: 1;
        border: 1px solid #ddd;
        padding: 8px;
        border-radius: 20px;
        outline: none;
      }
      #gis-chat-send {
        background: none;
        border: none;
        color: #000;
        font-weight: bold;
        cursor: pointer;
        margin-left: 10px;
      }
      .gis-quick-btn {
        display: inline-block;
        margin-top: 5px;
        padding: 5px 10px;
        background: #000;
        color: #fff;
        text-decoration: none;
        border-radius: 15px;
        font-size: 12px;
        cursor: pointer;
      }
    </style>

    <div id="gis-chat-widget">
      <div id="gis-chat-window">
        <div id="gis-chat-header">
          <span>Assistant Global Indesign</span>
          <span style="cursor:pointer;" onclick="toggleChat()">✕</span>
        </div>
        <div id="gis-chat-messages" id="messages-container"></div>
        <div id="gis-chat-input-area">
          <input type="text" id="gis-chat-input" placeholder="Posez une question..." onkeypress="handleEnter(event)">
          <button id="gis-chat-send" onclick="sendMessage()">➤</button>
        </div>
      </div>
      <button id="gis-chat-btn" onclick="toggleChat()">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      </button>
    </div>

    <script>
      let isChatOpen = false;
      
      // Knowledge Base
      const botKnowledge = [
        { keywords: ['bonjour', 'salut', 'hello', 'hi'], response: "Bonjour ! Je suis l'assistant virtuel de Global Indesign. Comment puis-je vous aider aujourd'hui ?" },
        { keywords: ['rendez-vous', 'rdv', 'meeting', 'réserver', 'dispo'], response: "Je peux vous aider à planifier un rendez-vous ! Cliquez ci-dessous pour voir nos disponibilités :<br><a href='https://calendly.com/' target='_blank' class='gis-quick-btn'>📅 Prendre Rendez-vous</a>" },
        { keywords: ['prix', 'tarif', 'coût', 'devis'], response: "Nos tarifs dépendent de la complexité de votre projet. Le mieux est de demander un devis gratuit via notre formulaire de contact ou de prendre un rendez-vous d'échange." },
        { keywords: ['contact', 'email', 'mail', 'téléphone'], response: "Vous pouvez nous contacter directement via le formulaire du site, ou par email à <b>contact@globalindesign.com</b>." },
        { keywords: ['site', 'web', 'internet'], response: "Nous créons des sites web modernes, rapides et entièrement personnalisés. Souhaitez-vous voir notre portfolio ?" },
        { keywords: ['logo', 'design', 'graphisme'], response: "Nous sommes experts en identité visuelle. Un bon logo est la clé d'une marque forte !" }
      ];

      function toggleChat() {
        const window = document.getElementById('gis-chat-window');
        isChatOpen = !isChatOpen;
        window.style.display = isChatOpen ? 'flex' : 'none';
        if (isChatOpen && document.getElementById('gis-chat-messages').children.length === 0) {
          addMessage("bot", "Bienvenue chez Global Indesign ! 👋<br>Je peux vous aider à prendre <b>rendez-vous</b> ou répondre à vos questions.");
        }
      }

      function handleEnter(e) {
        if (e.key === 'Enter') sendMessage();
      }

      function sendMessage() {
        const input = document.getElementById('gis-chat-input');
        const text = input.value.trim();
        if (!text) return;

        addMessage("user", text);
        input.value = '';

        // Simulate thinking
        setTimeout(() => {
          const response = findResponse(text);
          addMessage("bot", response);
        }, 600);
      }

      function addMessage(sender, html) {
        const container = document.getElementById('gis-chat-messages');
        const div = document.createElement('div');
        div.className = 'gis-msg gis-msg-' + sender;
        div.innerHTML = html;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
      }

      function findResponse(text) {
        const lowerText = text.toLowerCase();
        for (const entry of botKnowledge) {
          if (entry.keywords.some(k => lowerText.includes(k))) {
            return entry.response;
          }
        }
        return "Je ne suis pas sûr de comprendre. Vous pouvez <a href='https://calendly.com/' target='_blank' style='color:#000;font-weight:bold;'>prendre rendez-vous ici</a> ou utiliser le formulaire de contact pour parler à un humain.";
      }
    </script>
    `;
    $('body').append(chatbotScript);
    console.log('Injected Chatbot script');

    // 6. Save updated index.html
    fs.writeFileSync(path.join(OUT_DIR, 'index.html'), $.html());
    console.log('Saved updated index.html');
}

main();
