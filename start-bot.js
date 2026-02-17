import { Telegraf, Markup } from 'telegraf';
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";

const PDF_DIR = "hasil-label";
const JSON_DIR = "data-json";
[PDF_DIR, JSON_DIR].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir); });

const bot = new Telegraf(process.env.BOT_TOKEN);
const DB = {};

// --- COLOR LOGS ---
const log = {
    info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
    success: (msg) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
    warn: (msg) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
    error: (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
    system: (msg) => console.log(`\x1b[35m[SYSTEM]\x1b[0m ${msg}`)
};

// --- RENDER LOGIC ---
const expandLabelsByStock = (labels) => labels.flatMap(l => Array(l.stock || 1).fill(l));
const chunkArray = (array, size) => Array.from({ length: Math.ceil(array.length / size) }, (v, i) => array.slice(i * size, i * size + size));

const generateHtml = (labels) => {
    const pages = chunkArray(labels, 9);
    const pageHtml = pages.map(pageLabels => `
        <div class="page">
            ${pageLabels.map(label => `
                <div class="label">
                    <div class="product-name">${label.name}</div>
                    <div class="spec-box">
                        ${label.description.split("\n").map(line => `<div>> ${line}</div>`).join("")}
                    </div>
                    <div class="price">RP ${new Intl.NumberFormat("id-ID").format(label.price)},-</div>
                </div>
            `).join("")}
        </div>
    `).join("");

    return `
    <html>
    <head>
        <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&display=swap" rel="stylesheet">
        <style>
            @media print {
                @page { size: A4 landscape; margin: 0; }
                body { font-family: 'Fira Code', monospace; margin: 0; background-color: #fff; }
                .page { width: 29.7cm; height: 21cm; padding: 1.5cm; display: grid; grid-template-columns: repeat(3, 8.7cm); grid-template-rows: repeat(3, 5.7cm); gap: 0.5cm; page-break-after: always; justify-content: center; align-items: center; }
                .label { width: 8.7cm; height: 5.7cm; border: 1px solid #000; border-radius: 0px; padding: 0.4cm; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box; overflow: hidden; background: white; }
                .product-name { font-size: 14pt; font-weight: 700; background: #0da11aff; color: #fff; text-align: center; margin: -0.4cm -0.4cm 0.2cm -0.4cm; padding: 0.2cm 0; text-transform: uppercase; }
                .spec-box { font-size: 10pt; font-weight: 400; flex-grow: 1; color: #333; line-height: 1.4; padding-top: 5px; }
                .price { font-size: 13pt; font-weight: 700; background: #0da11aff; color: #fff; text-align: center; margin: 0.2cm -0.4cm -0.4cm -0.4cm; padding: 0.2cm 0; }
            }
        </style>
    </head>
    <body>${pageHtml}</body>
    </html>`;
};

// --- MENU ---
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Tambah Data', 'menu_tambah')],
    [Markup.button.callback('💾 Save (JSON)', 'menu_save')],
    [Markup.button.callback('🖨️ Generate PDF', 'menu_generate')]
]);

// --- BOT HANDLERS ---

bot.start((ctx) => {
    const userId = ctx.chat.id;
    DB[userId] = { 
        realName: null, 
        queue: [], 
        savedData: null, 
        waitingForName: true,
        waitingForInput: false, 
        waitingForStock: false 
    };
    log.system(`New connection from @${ctx.from.username}. Asking for name...`);
    ctx.reply("Halo! Sebelum mulai, kenalan dulu ya. Nama kamu siapa?");
});

bot.action('menu_tambah', (ctx) => {
    const userId = ctx.chat.id;
    const userDb = DB[userId];
    if (!userDb || !userDb.realName) return ctx.reply("Klik /start dulu!");

    userDb.waitingForInput = true;
    log.info(`${userDb.realName} clicked Tambah Data.`);
    ctx.reply("Kirim data laptop (Tipe, Spek, Harga di baris terakhir):");
});

bot.action('menu_save', (ctx) => {
    const userId = ctx.chat.id;
    const userDb = DB[userId];
    if (!userDb || userDb.queue.length === 0) return ctx.reply("Antrian kosong!");

    const fileName = `data_${userDb.realName.replace(/\s/g, '_')}_${Date.now()}.json`;
    const finalOutput = {
        generated_by: userDb.realName,
        telegram_user: `@${ctx.from.username}`,
        timestamp: new Date().toLocaleString('id-ID'),
        items: userDb.queue
    };

    fs.writeFileSync(path.join(JSON_DIR, fileName), JSON.stringify(finalOutput, null, 4));
    userDb.savedData = [...userDb.queue];
    
    log.success(`JSON Saved by ${userDb.realName}. Total items: ${userDb.queue.length}`);
    ctx.reply(`✅ JSON Saved! Data dicatat atas nama: ${userDb.realName}`, mainMenu);
});

bot.action('menu_generate', async (ctx) => {
    const userId = ctx.chat.id;
    const userDb = DB[userId];
    if (!userDb || !userDb.savedData) return ctx.reply("Save dulu boss!");

    log.info(`Generating PDF for ${userDb.realName}...`);
    ctx.reply("⏳ Rendering PDF...");

    try {
        const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
        const page = await browser.newPage();
        const labels = expandLabelsByStock(userDb.savedData);
        await page.setContent(generateHtml(labels), { waitUntil: "networkidle0" });
        const pdfPath = path.join(PDF_DIR, `label_${userDb.realName}_${Date.now()}.pdf`);
        await page.pdf({ path: pdfPath, format: "A4", landscape: true, printBackground: true });
        await browser.close();

        await ctx.replyWithDocument({ source: pdfPath }, { caption: `Price Tag sukses digenerate oleh ${userDb.realName}` });
        log.success(`PDF generated for ${userDb.realName}.`);
        userDb.queue = []; userDb.savedData = null;
    } catch (err) {
        log.error(err.message);
        ctx.reply("Gagal Render!");
    }
});

bot.on('text', async (ctx) => {
    const userId = ctx.chat.id;
    const userDb = DB[userId];
    if (!userDb || ctx.message.text.startsWith('/')) return;

    const text = ctx.message.text;

    // STEP 1: Tanya Nama
    if (userDb.waitingForName) {
        userDb.realName = text;
        userDb.waitingForName = false;
        log.success(`User identified as: ${text}`);
        return ctx.reply(`Salam kenal ${text}! Sekarang kamu bisa mulai input data.`, mainMenu);
    }

    // STEP 2: Input Stok
    if (userDb.waitingForStock) {
        const stock = parseInt(text.replace(/\D/g, '')) || 1;
        userDb.currentInput.stock = stock;
        userDb.queue.push({ ...userDb.currentInput });
        userDb.waitingForStock = false;
        log.info(`[${userDb.realName}] Added: ${userDb.currentInput.name} x${stock}`);
        return ctx.reply(`✅ Tersimpan. Antrian: ${userDb.queue.length}`, mainMenu);
    }

    // STEP 3: Input Blok Teks
    if (userDb.waitingForInput) {
        const lines = text.split('\n').filter(l => l.trim() !== "");
        if (lines.length < 2) return ctx.reply("Minimal Nama dan Harga!");

        const name = lines[0];
        const price = parseInt(lines[lines.length - 1].replace(/\D/g, '')) || 0;
        const description = lines.slice(1, lines.length - 1).join('\n');

        userDb.currentInput = { name, description, price };
        userDb.waitingForInput = false;
        userDb.waitingForStock = true;
        ctx.reply(`Berapa lembar untuk ${name}?`);
    }
});

// --- LOGO ---
console.clear();
console.log("\x1b[32m%s\x1b[0m", "==========================================");
console.log("\x1b[32m%s\x1b[0m", "   BOT LABEL [MULTI-USER & TRACKING]     ");
console.log("\x1b[32m%s\x1b[0m", "==========================================");
log.success("Bot is ONLINE.");
console.log("\x1b[32m%s\x1b[0m", "------------------------------------------\n");

bot.launch();