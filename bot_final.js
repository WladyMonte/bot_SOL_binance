require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const { RSI } = require('technicalindicators');
const http = require('http');

// --- SERVIDOR PARA RAILWAY (KEEP-ALIVE) ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('FastCL Alpha Bot: Operando en vivo...');
}).listen(process.env.PORT || 3000);

// --- CONFIGURACIÓN ---
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;
const SYMBOL = 'SOL/USDT';
const CANTIDAD_SOL = 0.5; // <-- Ajusta aquí cuánto SOL comprar por operación
const LÍMITE_RESCATE = 1.0; // Se apaga si el saldo baja de 1 USDT

const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY,
    secret: process.env.SECRET_KEY,
    options: { defaultType: 'future' }
});

async function avisar(msg) {
    try {
        await bot.telegram.sendMessage(chatId, `🤖 *FastCL Alpha:* \n${msg}`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("Error Telegram:", e.message); }
}

// --- INICIALIZACIÓN DE CUENTA ---
async function setup() {
    try {
        await exchange.setLeverage(5, SYMBOL); // <--- APALANCAMIENTO A 5X
        console.log(`✅ Apalancamiento ajustado a 5x para ${SYMBOL}`);
    } catch (e) { console.error("⚠️ Error configurando apalancamiento:", e.message); }
}

// --- LÓGICA DE TRADING ---
async function tradingLoop() {
    try {
        // 1. Verificación de Saldo
        const balance = await exchange.fetchBalance();
        const saldoActual = balance.total['USDT'];

        if (saldoActual < LÍMITE_RESCATE) {
            await avisar(`🚨 *SALDO CRÍTICO:* ${saldoActual.toFixed(2)} USDT.\nDeteniendo bot por seguridad.`);
            process.exit(0);
        }

        // 2. Obtención de RSI (Velas de 1 min)
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, '1m', undefined, 20);
        const closes = ohlcv.map(val => val[4]);
        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const currentRSI = rsiValues[rsiValues.length - 1];

        // 3. Verificación de Posición
        const positions = await exchange.fetchPositions([SYMBOL]);
        const pos = positions.find(p => p.symbol === SYMBOL);
        const hasPosition = pos && Math.abs(parseFloat(pos.contracts)) > 0;

        console.log(`[${new Date().toLocaleTimeString()}] RSI: ${currentRSI.toFixed(2)} | SOL: ${closes[closes.length-1]}`);

        // --- ESTRATEGIA EJECUTABLE ---
        if (!hasPosition && currentRSI < 30) {
            await avisar(`🚀 *ORDEN DE COMPRA ENVIADA*\nRSI: ${currentRSI.toFixed(2)}\nCantidad: ${CANTIDAD_SOL} SOL`);
            await exchange.createMarketBuyOrder(SYMBOL, CANTIDAD_SOL); // COMPRA REAL
        } 
        else if (hasPosition && currentRSI > 70) {
            await avisar(`💰 *ORDEN DE VENTA ENVIADA*\nRSI: ${currentRSI.toFixed(2)}\nCerrando posición...`);
            await exchange.createMarketSellOrder(SYMBOL, Math.abs(pos.contracts)); // VENTA REAL
        }

    } catch (e) { console.error("❌ Error en ciclo:", e.message); }
}

// --- COMANDOS TELEGRAM ---
bot.command('status', async (ctx) => {
    try {
        const balance = await exchange.fetchBalance();
        const ticker = await exchange.fetchTicker(SYMBOL);
        ctx.replyWithMarkdown(`📊 *STATUS*\n💰 *Saldo:* ${balance.total['USDT'].toFixed(2)} USDT\n🚀 *SOL:* ${ticker.last} USDT\n⚙️ *Apalancamiento:* 5x`);
    } catch (e) { ctx.reply("Error: " + e.message); }
});

bot.command('stop', () => {
    avisar("🛑 Bot detenido.");
    process.exit(0);
});

// ARRANCAR
setup();
bot.launch();
setInterval(tradingLoop, 60000);
console.log("🚀 FastCL Alpha: OPERANDO EN VIVO A 5X");