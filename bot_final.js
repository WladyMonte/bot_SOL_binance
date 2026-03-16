require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const http = require('http'); // Para engañar a Railway y que no nos apague

// --- DUMMY SERVER (PARA RAILWAY) ---
// Esto evita el error SIGTERM. Le dice a Railway "estoy vivo".
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('FastCL Alpha Bot está operando...');
}).listen(process.env.PORT || 3000);

// --- DIAGNÓSTICO DE VARIABLES ---
console.log("🔍 Verificando configuración...");
console.log("- API_KEY detectada:", process.env.API_KEY ? "SÍ ✅" : "NO ❌");
console.log("- SECRET_KEY detectada:", process.env.SECRET_KEY ? "SÍ ✅" : "NO ❌");
console.log("- TELEGRAM_TOKEN detectado:", process.env.TELEGRAM_TOKEN ? "SÍ ✅" : "NO ❌");

// --- CONFIGURACIÓN ---
const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '');
const chatId = process.env.TELEGRAM_CHAT_ID;

const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY, 
    secret: process.env.SECRET_KEY,
    options: { defaultType: 'future' }
});

async function avisar(msg) {
    if (!process.env.TELEGRAM_TOKEN) return;
    try {
        await bot.telegram.sendMessage(chatId, `🤖 *FastCL Alpha:* \n${msg}`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("Error Telegram:", e.message); }
}

// --- COMANDOS ---
bot.command('status', async (ctx) => {
    try {
        const balance = await exchange.fetchBalance();
        ctx.reply(`💰 Saldo: ${balance.total['USDT'].toFixed(2)} USDT`);
    } catch (e) { ctx.reply("Error: " + e.message); }
});

bot.command('stop', () => {
    avisar("🛑 Bot detenido manualmente.");
    process.exit(0);
});

// Lanzar bot de Telegram
if (process.env.TELEGRAM_TOKEN) {
    bot.launch().then(() => console.log("📱 Telegram listo."));
}

// --- BUCLE DE TRADING ---
setInterval(async () => {
    try {
        const ticker = await exchange.fetchTicker('SOL/USDT');
        console.log(`[${new Date().toLocaleTimeString()}] SOL: ${ticker.last} | Esperando señal...`);
    } catch (e) {
        console.error("❌ Error en Binance:", e.message);
    }
}, 60000);

console.log("🛡️ FastCL Alpha Bot iniciado y protegido contra SIGTERM");