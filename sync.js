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

    // 4. Save updated index.html
    fs.writeFileSync(path.join(OUT_DIR, 'index.html'), $.html());
    console.log('Saved updated index.html');
}

main();
