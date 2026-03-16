require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const { RSI } = require('technicalindicators');
const http = require('http');

// --- SERVIDOR DE VIDA (EVITA EL CIERRE EN RAILWAY) ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('FastCL Alpha Bot está cazando en el mercado...');
}).listen(process.env.PORT || 3000);

// --- CONFIGURACIÓN ---
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;
const SYMBOL = 'SOL/USDT';
const RIESGO_MINIMO = 1.0; // Tu Límite de Rescate

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

// --- LÓGICA DE TRADING INTELIGENTE ---
async function tradingLoop() {
    try {
        // 1. Verificación de Seguridad (Límite de Rescate)
        const balance = await exchange.fetchBalance();
        const saldoActual = balance.total['USDT'];

        if (saldoActual < RIESGO_MINIMO) {
            await avisar(`🚨 *ALERTA DE SEGURIDAD*\nEl saldo (${saldoActual.toFixed(2)} USDT) ha caído por debajo del límite de 1 USDT. \n*Apagando bot para proteger capital.*`);
            process.exit(0);
        }

        // 2. Obtención de datos del mercado (Velas de 1 min)
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, '1m', undefined, 14 + 1);
        const closes = ohlcv.map(val => val[4]);

        // 3. Cálculo de RSI
        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const currentRSI = rsiValues[rsiValues.length - 1];

        console.log(`[${new Date().toLocaleTimeString()}] SOL: ${closes[closes.length - 1]} | RSI: ${currentRSI.toFixed(2)} | Saldo: ${saldoActual.toFixed(2)}`);

        // 4. Estrategia Agresiva
        // RSI < 30 (Sobrevendido) -> COMPRAR (Long)
        // RSI > 70 (Sobrecomprado) -> VENDER (Cerrar Long)
        
        const positions = await exchange.fetchPositions([SYMBOL]);
        const pos = positions.find(p => p.symbol === SYMBOL);
        const hasPosition = pos && Math.abs(parseFloat(pos.contracts)) > 0;

        if (!hasPosition && currentRSI < 30) {
            await avisar(`🚀 *ENTRADA AGRESIVA*\nSOL está sobrevenda (RSI: ${currentRSI.toFixed(2)}). Abriendo posición LONG.`);
            // Aquí iría la orden real: 
            // await exchange.createMarketBuyOrder(SYMBOL, cantidad);
        } else if (hasPosition && currentRSI > 70) {
            await avisar(`💰 *TOMA DE GANANCIAS*\nRSI en ${currentRSI.toFixed(2)}. Cerrando posición con éxito.`);
            // Aquí iría el cierre real: 
            // await exchange.createMarketSellOrder(SYMBOL, Math.abs(pos.contracts));
        }

    } catch (e) {
        console.error("❌ Error en ciclo:", e.message);
    }
}

// --- COMANDOS DE CONTROL ---
bot.command('status', async (ctx) => {
    try {
        const balance = await exchange.fetchBalance();
        const ticker = await exchange.fetchTicker(SYMBOL);
        ctx.replyWithMarkdown(`📊 *STATUS EN VIVO*\n\n💰 *Saldo:* ${balance.total['USDT'].toFixed(2)} USDT\n🚀 *SOL:* ${ticker.last} USDT\n📍 *Límite:* 1.00 USDT`);
    } catch (e) { ctx.reply("Error: " + e.message); }
});

bot.command('stop', async (ctx) => {
    await avisar("🛑 *BOT DETENIDO MANUALLY*");
    process.exit(0);
});

// Inicio
bot.launch();
setInterval(tradingLoop, 60000);
console.log("🛡️ FastCL Alpha Bot: Sistema robusto iniciado.");