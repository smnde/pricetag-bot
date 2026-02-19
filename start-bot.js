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
const WIDE = "\n" + "⠀".repeat(40) + "\n"; 

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

    return `<html><head><style>
        * { box-sizing: border-box; }
        body { font-family: sans-serif; margin: 0; padding: 0; -webkit-print-color-adjust: exact; }
        .page { width: 29.7cm; height: 21cm; padding: 1.2cm; display: grid; grid-template-columns: repeat(3, 8.7cm); grid-template-rows: repeat(3, 5.7cm); gap: 0.4cm; page-break-after: always; justify-content: center; align-content: center; }
        .page:last-child { page-break-after: avoid !important; }
        .label { width: 8.7cm; height: 5.7cm; border: 1px solid #000; display: flex; flex-direction: column; justify-content: space-between; }
        .product-name { font-size: 14pt; font-weight: bold; background: #0da11aff; color: #fff; text-align: center; padding: 8px 5px; text-transform: uppercase; }
        .spec-box { font-size: 10pt; flex-grow: 1; padding: 10px; line-height: 1.3; }
        .price { font-size: 13pt; font-weight: bold; background: #0da11aff; color: #fff; text-align: center; padding: 8px 5px; }
    </style></head><body>${pageHtml}</body></html>`;
};

// --- DYNAMIC MENU SYSTEM ---
const getMenu = (ctx) => {
    const userDb = DB[ctx.chat.id];
    const buttons = [];

    if (userDb.state === 'MAIN') {
        buttons.push([Markup.button.callback('➕ TAMBAH DATA BARU', 'menu_tambah')]);
        buttons.push([Markup.button.callback('⚙️ GENERATE DARI DATA LAMA', 'menu_gen_archive')]);
        buttons.push([Markup.button.callback('📂 DOWNLOAD ARSIP', 'menu_archive_type')]);
    } 
    else if (userDb.state === 'INPUTTING') {
        // Hanya tampilkan tombol jika tidak sedang menunggu input stok
        if (!userDb.tempData) {
            buttons.push([Markup.button.callback('➕ TAMBAH DATA LAGI', 'menu_tambah')]);
            if (userDb.queue.length > 0) {
                buttons.push([Markup.button.callback('💾 SAVE KE JSON', 'menu_save_json')]);
            }
        }
    } 
    else if (userDb.state === 'POST_SAVE') {
        buttons.push([Markup.button.callback(`⚙️ GENERATE [ ${userDb.lastBaseName} ]`, 'menu_generate_current')]);
    }
    else if (userDb.state === 'POST_GENERATE') {
        buttons.push([Markup.button.callback(`📥 DOWNLOAD PDF`, `dl:${userDb.lastBaseName}.pdf`)]);
        buttons.push([Markup.button.callback(`📥 DOWNLOAD CSV`, `dl:${userDb.lastBaseName}.csv`)]);
        buttons.push([Markup.button.callback('📂 ARSIP LAMA', 'menu_archive_type')]);
        buttons.push([Markup.button.callback('🏠 KEMBALI KE MENU UTAMA', 'back_main')]);
    }

    return Markup.inlineKeyboard(buttons);
};

// --- HANDLERS ---
bot.start((ctx) => {
    DB[ctx.chat.id] = { realName: null, queue: [], savedData: null, lastBaseName: null, state: 'WAITING_NAME' };
    ctx.reply("Halo! Nama kamu siapa?");
});

bot.action('back_main', (ctx) => {
    const userDb = DB[ctx.chat.id];
    userDb.state = 'MAIN';
    userDb.queue = []; userDb.savedData = null; userDb.lastBaseName = null;
    ctx.editMessageText(`📌 Menu Utama:${WIDE}`, getMenu(ctx));
});

bot.action('menu_tambah', (ctx) => {
    DB[ctx.chat.id].state = 'INPUTTING';
    ctx.reply("Kirim data laptop (Nama, Spek, Harga di baris terakhir):");
});

bot.action('menu_save_json', (ctx) => {
    DB[ctx.chat.id].state = 'ASK_FILENAME';
    ctx.reply("Mau kasih nama apa untuk file JSON ini?");
});

bot.action('menu_generate_current', async (ctx) => {
    const userDb = DB[ctx.chat.id];
    ctx.reply(`⏳ Menghasilkan file...`);
    const base = userDb.lastBaseName;
    
    let csv = "Nama,Spek,Harga,Qty\n";
    userDb.savedData.forEach(i => csv += `"${i.name}","${i.description.replace(/\n/g, ' | ')}",${i.price},${i.stock}\n`);
    fs.writeFileSync(path.join(CSV_DIR, `${base}.csv`), csv);

    const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(generateHtml(userDb.savedData), { waitUntil: "networkidle0" });
    await page.pdf({ path: path.join(PDF_DIR, `${base}.pdf`), format: "A4", landscape: true, printBackground: true, margin: {top:0,right:0,bottom:0,left:0}});
    await browser.close();

    userDb.state = 'POST_GENERATE';
    ctx.reply(`✅ Selesai Generate!${WIDE}`, getMenu(ctx));
});

// Archive & Download logic tetap sama...
bot.action('menu_gen_archive', (ctx) => {
    const files = fs.readdirSync(JSON_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) return ctx.answerCbQuery("Kosong!");
    ctx.editMessageText(`Pilih file JSON untuk di-generate:${WIDE}`, Markup.inlineKeyboard([
        ...files.slice(-8).map(f => [Markup.button.callback(f, `gen_old:${f}`)]),
        [Markup.button.callback('🔙 KEMBALI', 'back_main')]
    ]));
});

bot.action(/^gen_old:(.+)$/, async (ctx) => {
    const fileName = ctx.match[1];
    const userDb = DB[ctx.chat.id];
    userDb.lastBaseName = fileName.replace('.json', '');
    const content = JSON.parse(fs.readFileSync(path.join(JSON_DIR, fileName), 'utf-8'));
    userDb.savedData = content.items || content;
    userDb.state = 'POST_SAVE';
    ctx.editMessageText(`File dimuat. Siap generate?${WIDE}`, getMenu(ctx));
});

bot.action('menu_archive_type', (ctx) => {
    ctx.editMessageText(`Pilih kategori:${WIDE}`, Markup.inlineKeyboard([
        [Markup.button.callback('📄 JSON', 'arc:json')], [Markup.button.callback('📊 CSV', 'arc:csv')], [Markup.button.callback('🖨️ PDF', 'arc:pdf')],
        [Markup.button.callback('🔙 KEMBALI', 'back_main')]
    ]));
});

bot.action(/^arc:(json|csv|pdf)$/, (ctx) => {
    const type = ctx.match[1];
    const folder = type === 'json' ? JSON_DIR : (type === 'csv' ? CSV_DIR : PDF_DIR);
    const files = fs.readdirSync(folder).filter(f => f.endsWith(`.${type}`));
    ctx.editMessageText(`Daftar ${type.toUpperCase()}:${WIDE}`, Markup.inlineKeyboard([
        ...files.slice(-10).map(f => [Markup.button.callback(f, `dl:${f}`)]),
        [Markup.button.callback('🔙 KEMBALI', 'menu_archive_type')]
    ]));
});

bot.action(/^dl:(.+)$/, (ctx) => {
    const fName = ctx.match[1];
    const fDir = fName.endsWith('.json') ? JSON_DIR : (fName.endsWith('.csv') ? CSV_DIR : PDF_DIR);
    ctx.replyWithDocument({ source: path.join(fDir, fName) });
});

// --- TEXT HANDLER (REVISED FLOW) ---
bot.on('text', async (ctx) => {
    const userDb = DB[ctx.chat.id];
    if (!userDb || ctx.message.text.startsWith('/')) return;
    const text = ctx.message.text;

    // 1. STATE: KENALAN
    if (userDb.state === 'WAITING_NAME') {
        userDb.realName = text;
        userDb.state = 'MAIN';
        return ctx.reply(`Halo ${text}!${WIDE}`, getMenu(ctx));
    }

    // 2. STATE: ASK FILENAME (Setelah klik Save)
    if (userDb.state === 'ASK_FILENAME') {
        const base = text.replace(/\s/g, '_');
        fs.writeFileSync(path.join(JSON_DIR, `${base}.json`), JSON.stringify({user: userDb.realName, items: userDb.queue}, null, 4));
        userDb.savedData = [...userDb.queue];
        userDb.lastBaseName = base;
        userDb.state = 'POST_SAVE'; 
        return ctx.reply(`✅ Data disimpan sebagai ${base}.json${WIDE}`, getMenu(ctx));
    }

    // 3. STATE: INPUTTING (Data Laptop & Lembar)
    if (userDb.state === 'INPUTTING') {
        // Jika belum ada tempData, berarti user baru kirim spek
        if (!userDb.tempData) {
            const lines = text.split('\n').filter(l => l.trim() !== "");
            if (lines.length < 2) return ctx.reply("Format salah. Kirim minimal Nama dan Harga (baris terakhir).");

            userDb.tempData = { 
                name: lines[0], 
                price: parseInt(lines[lines.length - 1].replace(/\D/g, '')) || 0, 
                description: lines.slice(1, lines.length - 1).join('\n') 
            };
            return ctx.reply(`Berapa lembar untuk ${userDb.tempData.name}?`);
        } 
        // Jika sudah ada tempData, berarti user kirim jumlah lembar (stok)
        else {
            const stock = parseInt(text.replace(/\D/g, '')) || 1;
            userDb.tempData.stock = stock;
            userDb.queue.push({...userDb.tempData});
            delete userDb.tempData; // Hapus temp agar siap untuk input data laptop berikutnya
            
            return ctx.reply(`✅ Berhasil menambahkan ${stock} lembar.${WIDE}`, getMenu(ctx));
        }
    }
});

bot.launch();
console.log(`[SYSTEM] BOT ONLINE`);