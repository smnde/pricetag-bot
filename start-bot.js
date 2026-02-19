import { Telegraf, Markup } from 'telegraf';
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";

const PDF_DIR = "hasil-label";
const JSON_DIR = "data-json";
const CSV_DIR = "hasil-csv";
[PDF_DIR, JSON_DIR, CSV_DIR].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir); });

const bot = new Telegraf(process.env.BOT_TOKEN);
const DB = {};

const log = {
    info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
    success: (msg) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
    system: (msg) => console.log(`\x1b[35m[SYSTEM]\x1b[0m ${msg}`)
};

// --- PDF HTML RENDERER ---
const generateHtml = (labels) => {
    const expandLabels = labels.flatMap(l => Array(l.stock || 1).fill(l));
    const pages = Array.from({ length: Math.ceil(expandLabels.length / 9) }, (v, i) => expandLabels.slice(i * 9, i * 9 + 9));
    
    const pageHtml = pages.map((pageLabels, index) => `
        <div class="page" style="${index === pages.length - 1 ? 'page-break-after: avoid;' : ''}">
            ${pageLabels.map(label => `
                <div class="label">
                    <div class="product-name">${label.name}</div>
                    <div class="spec-box">${label.description.split("\n").map(line => `<div>> ${line}</div>`).join("")}</div>
                    <div class="price">RP ${new Intl.NumberFormat("id-ID").format(label.price)},-</div>
                </div>
            `).join("")}
        </div>
    `).join("");

    return `<html><head><link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&display=swap" rel="stylesheet"><style>
        * { box-sizing: border-box; }
        body { font-family: 'Fira Code', monospace; margin: 0; padding: 0; -webkit-print-color-adjust: exact; }
        .page { width: 29.7cm; height: 21cm; padding: 1.2cm; display: grid; grid-template-columns: repeat(3, 8.7cm); grid-template-rows: repeat(3, 5.7cm); gap: 0.4cm; page-break-after: always; overflow: hidden; justify-content: center; align-content: center; }
        .page:last-child { page-break-after: avoid !important; }
        .label { width: 8.7cm; height: 5.7cm; border: 1px solid #000; display: flex; flex-direction: column; justify-content: space-between; background: white; }
        .product-name { font-size: 14pt; font-weight: 700; background: #0da11aff; color: #fff; text-align: center; padding: 8px 5px; text-transform: uppercase; }
        .spec-box { font-size: 10pt; flex-grow: 1; color: #333; line-height: 1.3; padding: 10px; overflow: hidden; }
        .price { font-size: 13pt; font-weight: 700; background: #0da11aff; color: #fff; text-align: center; padding: 8px 5px; }
    </style></head><body>${pageHtml}</body></html>`;
};

// --- KEYBOARDS ---
const menuUtama = () => Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH DATA', 'menu_tambah')],
    [Markup.button.callback('💾 SAVE (JSON)', 'menu_save_json')],
    [Markup.button.callback('⚙️ GENERATE (PDF & CSV)', 'menu_generate')],
    [Markup.button.callback('📂 DOWNLOAD FILE', 'menu_archive_type')]
]);

const archiveTypeMenu = Markup.inlineKeyboard([
    [Markup.button.callback('📄 FILE JSON', 'arc:json')],
    [Markup.button.callback('📊 FILE CSV', 'arc:csv')],
    [Markup.button.callback('🖨️ FILE PDF', 'arc:pdf')],
    [Markup.button.callback('🔙 KEMBALI', 'back_main')]
]);

// --- BOT LOGIC ---
bot.start((ctx) => {
    DB[ctx.chat.id] = { realName: null, queue: [], savedData: null, lastBaseName: null, step: 'WAITING_NAME' };
    ctx.reply("Halo! Nama kamu siapa?");
});

bot.action('back_main', (ctx) => ctx.editMessageText("Menu Utama:", menuUtama()));

bot.action('menu_tambah', (ctx) => {
    DB[ctx.chat.id].step = 'INPUT_DATA';
    ctx.reply("Kirim data laptop (Nama, Spek, Harga di baris terakhir):");
});

bot.action('menu_save_json', (ctx) => {
    if (DB[ctx.chat.id].queue.length === 0) return ctx.reply("Antrian kosong!");
    DB[ctx.chat.id].step = 'INPUT_FILENAME_SAVE';
    ctx.reply("Mau kasih nama apa untuk file JSON ini?");
});

// GENERATE LANGSUNG PAKAI NAMA JSON
bot.action('menu_generate', async (ctx) => {
    const userDb = DB[ctx.chat.id];
    if (!userDb.savedData || !userDb.lastBaseName) return ctx.reply("❌ Kamu harus SAVE ke JSON dulu sebelum Generate!");

    ctx.reply(`⏳ Menghasilkan PDF & CSV dengan nama: ${userDb.lastBaseName}...`);
    
    try {
        const baseName = userDb.lastBaseName;
        
        // CSV
        const csvFile = `${baseName}.csv`;
        let csv = "Nama,Spek,Harga,Qty\n";
        userDb.savedData.forEach(i => csv += `"${i.name}","${i.description.replace(/\n/g, ' | ')}",${i.price},${i.stock}\n`);
        fs.writeFileSync(path.join(CSV_DIR, csvFile), csv);

        // PDF
        const pdfFile = `${baseName}.pdf`;
        const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(generateHtml(userDb.savedData), { waitUntil: "networkidle0" });
        await page.pdf({ 
            path: path.join(PDF_DIR, pdfFile), 
            format: "A4", 
            landscape: true, 
            printBackground: true, 
            margin: {top:0,right:0,bottom:0,left:0}
        });
        await browser.close();

        ctx.reply(`✅ Berhasil Generate!\n\n📄 ${pdfFile}\n📊 ${csvFile}`, menuUtama());
    } catch (e) {
        ctx.reply("❌ Error saat generate!");
    }
});

bot.action('menu_archive_type', (ctx) => ctx.editMessageText("Mau download file jenis apa?", archiveTypeMenu));

bot.action(/^arc:(json|csv|pdf)$/, (ctx) => {
    const type = ctx.match[1];
    let folder = type === 'json' ? JSON_DIR : (type === 'csv' ? CSV_DIR : PDF_DIR);
    const ext = `.${type}`;
    const files = fs.readdirSync(folder).filter(f => f.endsWith(ext));
    if (files.length === 0) return ctx.answerCbQuery(`Tidak ada file ${type.toUpperCase()}`, { show_alert: true });
    
    const buttons = files.slice(-10).map(f => [Markup.button.callback(f, `dl:${f}`)]);
    buttons.push([Markup.button.callback('🔙 Kembali', 'menu_archive_type')]);
    ctx.editMessageText(`Daftar File ${type.toUpperCase()}:`, Markup.inlineKeyboard(buttons));
});

bot.action(/^dl:(.+)$/, (ctx) => {
    const fName = ctx.match[1];
    let fDir = fName.endsWith('.json') ? JSON_DIR : (fName.endsWith('.csv') ? CSV_DIR : PDF_DIR);
    ctx.replyWithDocument({ source: path.join(fDir, fName) });
});

bot.on('text', async (ctx) => {
    const userId = ctx.chat.id;
    const userDb = DB[userId];
    if (!userDb || ctx.message.text.startsWith('/')) return;
    const text = ctx.message.text;

    switch (userDb.step) {
        case 'WAITING_NAME':
            userDb.realName = text;
            userDb.step = 'IDLE';
            ctx.reply(`Halo ${text}!`, menuUtama());
            break;

        case 'INPUT_DATA':
            const lines = text.split('\n').filter(l => l.trim() !== "");
            userDb.currentInput = {
                name: lines[0],
                price: parseInt(lines[lines.length - 1].replace(/\D/g, '')) || 0,
                description: lines.slice(1, lines.length - 1).join('\n')
            };
            userDb.step = 'INPUT_STOCK';
            ctx.reply(`Berapa lembar untuk ${userDb.currentInput.name}?`);
            break;

        case 'INPUT_STOCK':
            userDb.currentInput.stock = parseInt(text) || 1;
            userDb.queue.push({...userDb.currentInput});
            userDb.step = 'IDLE';
            ctx.reply(`✅ Masuk antrian.`, menuUtama());
            break;

        case 'INPUT_FILENAME_SAVE':
            const base = text.replace(/\s/g, '_');
            const jFile = `${base}.json`;
            fs.writeFileSync(path.join(JSON_DIR, jFile), JSON.stringify({user: userDb.realName, items: userDb.queue}, null, 4));
            
            // Simpan state untuk Generate
            userDb.savedData = [...userDb.queue];
            userDb.lastBaseName = base; 
            userDb.step = 'IDLE';
            ctx.reply(`✅ Save berhasil: ${jFile}\nSekarang kamu bisa langsung klik GENERATE.`, menuUtama());
            break;
    }
});

log.system("BOT ONLINE");
bot.launch();