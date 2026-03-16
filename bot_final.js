require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const { RSI } = require('technicalindicators');

// --- CONFIGURACIÓN ---
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;
let botActivo = true; // Interruptor del bot

const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY, 
    secret: process.env.SECRET_KEY,
    options: { defaultType: 'future' }
});

// --- FUNCIONES DE TELEGRAM ---
async function avisar(msg) {
    try {
        await bot.telegram.sendMessage(chatId, `🤖 *FastCL Alpha Bot:*\n${msg}`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("Error Telegram:", e); }
}

// Comando Status: Te dice cómo va todo
bot.command('status', async (ctx) => {
    try {
        const balance = await exchange.fetchBalance();
        const ticker = await exchange.fetchTicker('SOL/USDT');
        const saldo = balance.total['USDT'].toFixed(2);
        ctx.replyWithMarkdown(`📊 *ESTADO ACTUAL*\n\n💰 *Saldo:* ${saldo} USDT\n🚀 *Precio SOL:* ${ticker.last} USDT\n⚙️ *Bot:* ${botActivo ? '🟢 Corriendo' : '🔴 Detenido'}`);
    } catch (e) { ctx.reply("Error: " + e.message); }
});

// Comando Stop: El botón de pánico
bot.command('stop', async (ctx) => {
    botActivo = false;
    await avisar("⚠️ *MODO PÁNICO ACTIVADO*\nCerrando todo y deteniendo operaciones...");
    try {
        await exchange.cancelAllOrders('SOL/USDT');
        const positions = await exchange.fetchPositions(['SOL/USDT']);
        const pos = positions.find(p => p.symbol === 'SOL/USDT');
        
        if (pos && Math.abs(pos.contracts) > 0) {
            const side = pos.side === 'long' ? 'sell' : 'buy';
            await exchange.createMarketOrder('SOL/USDT', side, Math.abs(pos.contracts));
            await avisar("✅ Posición cerrada. El bot no operará más.");
        }
    } catch (e) { await avisar(`❌ Error en stop: ${e.message}`); }
});

bot.launch();

// --- LÓGICA DE TRADING ---
async function tradingLoop() {
    if (!botActivo) return;

    try {
        // (Aquí va tu lógica de velas y RSI que ya funciona)
        // Simulamos una entrada para mostrarte cómo avisar:
        
        /* Si el bot decide entrar:
        await exchange.createOrder(...)
        await avisar(`🚀 *ENTRADA EJECUTADA*\n💰 Precio: ${precio} USDT\n📉 Stop Loss: ${sl}\n📈 Take Profit: ${tp}`);
        */

        /* Si el bot detecta cierre de posición:
        await avisar(`💰 *OPERACIÓN CERRADA*\n💸 PnL: +${ganancia} USDT\n🏦 Saldo final: ${nuevoSaldo} USDT`);
        */

    } catch (error) {
        console.error("Error en ciclo:", error);
    }
}

// Ejecutar cada minuto
setInterval(tradingLoop, 60000);
console.log("🛡️ FastCL Alpha Bot iniciado en la nube...");