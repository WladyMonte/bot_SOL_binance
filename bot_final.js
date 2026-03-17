require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const { RSI } = require('technicalindicators');
const http = require('http');

// --- SERVIDOR PARA RAILWAY (KEEP-ALIVE) ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('FastCL Ultra-Aggressive: Running...');
}).listen(process.env.PORT || 3000);

// --- CONFIGURACIÓN AGRESIVA ---
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;
const SYMBOL = 'SOL/USDT';
const LEVERAGE = 10;            // Apalancamiento 10X
const MARGEN_USD = 10;          // Dólares a usar por operación
const PROFIT_OBJETIVO = 1.2;    // Ganancia en USD para cerrar
const LOSS_LIMITE = 0.5;        // Pérdida en USD para cerrar
const UMBRAL_RSI_LONG = 28;     // RSI bajo para comprar
const UMBRAL_RSI_SHORT = 72;    // RSI alto para vender

const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY,
    secret: process.env.SECRET_KEY,
    options: { defaultType: 'future' }
});

async function avisar(msg) {
    try {
        await bot.telegram.sendMessage(chatId, `🤖 *FastCL Ultra:* \n${msg}`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("Error Telegram:", e.message); }
}

// --- CONFIGURACIÓN INICIAL ---
async function setup() {
    try {
        await exchange.setLeverage(LEVERAGE, SYMBOL);
        console.log(`✅ Configuración lista: ${LEVERAGE}x en ${SYMBOL}`);
        await avisar(`SISTEMA INICIADO\nModo: Agresivo 10X\nTP: $${PROFIT_OBJETIVO} | SL: $${LOSS_LIMITE}`);
    } catch (e) { console.error("⚠️ Error en Setup:", e.message); }
}

// --- LÓGICA DE TRADING ---
async function tradingLoop() {
    try {
        // 1. Datos de Mercado y Posición
        const ticker = await exchange.fetchTicker(SYMBOL);
        const precioActual = ticker.last;
        
        const positions = await exchange.fetchPositions([SYMBOL]);
        const pos = positions.find(p => p.symbol === SYMBOL);
        const contratos = pos ? parseFloat(pos.contracts) : 0;
        const enPosicion = Math.abs(contratos) > 0;

        // 2. GESTIÓN DE POSICIÓN ACTIVA (TP / SL en dólares)
        if (enPosicion) {
            const precioEntrada = parseFloat(pos.entryPrice);
            const lado = contratos > 0 ? 'LONG' : 'SHORT';
            
            // Cálculo de PnL real en USD
            let pnlUSD = (precioActual - precioEntrada) * contratos;
            if (lado === 'SHORT') pnlUSD = (precioEntrada - precioActual) * Math.abs(contratos);

            console.log(`[${lado}] PnL actual: $${pnlUSD.toFixed(2)} USD`);

            if (pnlUSD >= PROFIT_OBJETIVO || pnlUSD <= -LOSS_LIMITE) {
                const motivo = pnlUSD >= PROFIT_OBJETIVO ? "✅ PROFIT" : "❌ STOP LOSS";
                const sideToClose = lado === 'LONG' ? 'sell' : 'buy';
                
                await exchange.createMarketOrder(SYMBOL, sideToClose, Math.abs(contratos));
                await avisar(`${motivo}\nCerrado con: $${pnlUSD.toFixed(2)} USD`);
            }
            return; // Salimos del loop para no abrir otra posición
        }

        // 3. LÓGICA DE ENTRADA (Solo si no hay posición)
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, '1m', undefined, 20);
        const closes = ohlcv.map(val => val[4]);
        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const currentRSI = rsiValues[rsiValues.length - 1];

        // Calcular tamaño de la orden (Margen * Palanca / Precio)
        const amount = (MARGEN_USD * LEVERAGE) / precioActual;

        console.log(`[Analizando] RSI: ${currentRSI.toFixed(2)} | Precio: ${precioActual}`);

        if (currentRSI <= UMBRAL_RSI_LONG) {
            await avisar(`🚀 *ENTRADA LONG*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}`);
            await exchange.createMarketBuyOrder(SYMBOL, amount);
        } 
        else if (currentRSI >= UMBRAL_RSI_SHORT) {
            await avisar(`📉 *ENTRADA SHORT*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}`);
            await exchange.createMarketSellOrder(SYMBOL, amount);
        }

    } catch (e) { 
        console.error("❌ Error en ciclo:", e.message); 
        if(e.message.includes("margin")) await avisar("🚨 Error: Margen insuficiente en Binance.");
    }
}

// --- COMANDOS ---
bot.command('status', async (ctx) => {
    try {
        const balance = await exchange.fetchBalance();
        ctx.reply(`📊 Saldo: ${balance.total['USDT'].toFixed(2)} USDT\nBot operando a 10X`);
    } catch (e) { ctx.reply("Error leyendo balance."); }
});

// ARRANCAR
setup();
bot.launch();
setInterval(tradingLoop, 30000); // Revisión cada 30 segundos para mayor velocidad
console.log("🔥 FastCL Ultra-Aggressive: OPERANDO");