require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const { RSI, EMA } = require('technicalindicators');
const http = require('http');

// --- SERVIDOR KEEP-ALIVE ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('FastCL Ultra-Aggressive: Sistema Operativo');
}).listen(process.env.PORT || 3000);

// --- CONFIGURACIÓN TÉCNICA ---
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;
const SYMBOL = 'SOL/USDT';
const LEVERAGE = 10;            
const PROFIT_OBJETIVO = 1.2;    
const LOSS_LIMITE = 0.5;        
const RSI_ENTRADA_LONG = 28;    
const RSI_ENTRADA_SHORT = 72;   

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

// --- SETUP INICIAL ---
async function setup() {
    try {
        await exchange.loadMarkets();
        await exchange.setLeverage(LEVERAGE, SYMBOL);
        await exchange.setMarginMode('ISOLATED', SYMBOL).catch(() => {}); // Intenta ponerlo en aislado
        console.log(`🚀 FastCL Ultra V3.1 - Optimizado para Interés Compuesto iniciado: 10X en ${SYMBOL}`);
        await avisar("🔥 *SISTEMA EN LINEA V3.1 - Optimizado para Interés Compuesto*\nConfiguración: 28/72 RSI\nObjetivo: +$1.2 / -$0.5");
    } catch (e) { console.error("Error Setup:", e.message); }
}

// --- CORE DEL BOT ---
async function tradingLoop() {
    try {
        const ticker = await exchange.fetchTicker(SYMBOL);
        const precioActual = ticker.last;
        
        const positions = await exchange.fetchPositions();
        const pos = positions.find(p => p.symbol === SYMBOL || (p.info && p.info.symbol === "SOLUSDT"));
        let contratos = 0;
        let precioEntrada = 0;

        if (pos) {
            if (pos.contracts !== undefined) contratos = Number(pos.contracts);
            else if (pos.info && pos.info.positionAmt) contratos = Number(pos.info.positionAmt);
            else if (pos.amount !== undefined) contratos = Number(pos.amount);
            
            precioEntrada = Number(pos.entryPrice || 0);
        }
        
        const enPosicion = Math.abs(contratos) > 0;

        // OBTENER RSI Y EMA ANTES DE LA TOMA DE DECISIONES PARA LOGS
        // Buscamos 250 velas para poder calcular EMA de 200
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, '1m', undefined, 250);
        const closes = ohlcv.map(val => val[4]);
        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const currentRSI = rsiValues[rsiValues.length - 1];

        const ema200Values = EMA.calculate({ values: closes, period: 200 });
        const currentEMA200 = ema200Values.length > 0 ? ema200Values[ema200Values.length - 1] : precioActual;

        // 1. GESTIÓN DE SALIDAS (TP/SL)
        if (enPosicion) {
            const lado = contratos > 0 ? 'LONG' : 'SHORT';
            
            let pnlUSD = (precioActual - precioEntrada) * contratos;
            if (lado === 'SHORT') pnlUSD = (precioEntrada - precioActual) * Math.abs(contratos);

            console.log(`[${new Date().toLocaleTimeString()}] ${lado} Activo | RSI: ${currentRSI.toFixed(2)} | PnL: $${pnlUSD.toFixed(2)}`);

            if (pnlUSD >= PROFIT_OBJETIVO || pnlUSD <= -LOSS_LIMITE) {
                const motivo = pnlUSD >= PROFIT_OBJETIVO ? "💰 PROFIT" : "🛑 STOP LOSS";
                const sideToClose = lado === 'LONG' ? 'sell' : 'buy';
                
                try {
                    await exchange.createMarketOrder(SYMBOL, sideToClose, Math.abs(contratos), { reduceOnly: true });
                    await avisar(`${motivo}\nCerrado con: $${pnlUSD.toFixed(2)} USD`);
                } catch (err) {
                    await avisar(`❌ *ERROR CERRANDO POSICIÓN:*\n${err.message}`);
                }
            } else {
                // Filtro de Seguridad Estricto: Logs de señales ignoradas por posición existente
                if ((currentRSI <= RSI_ENTRADA_LONG && precioActual > currentEMA200) || (currentRSI >= RSI_ENTRADA_SHORT && precioActual < currentEMA200)) {
                    console.log(`[ALERTA] Señal detectada (RSI: ${currentRSI.toFixed(2)}), pero ya hay una operación activa. Ignorando.`);
                }
            }
            return; // RETORNAR PARA NO ABRIR MULTIPLES POSICIONES
        }

        // 2. DETECCION DE ENTRADAS
        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        let marginCalculado = availableBalance * 0.90;
        if (marginCalculado > 50) marginCalculado = 50;

        let amount = (marginCalculado * LEVERAGE) / precioActual;
        
        // Protección Notional > 10 USDT
        let notionalCalculado = amount * precioActual;
        if (notionalCalculado < 10) {
            amount = 11 / precioActual; // Ajuste forzado para que supere los 10 USDT
        }

        const formattedAmount = Number(exchange.amountToPrecision(SYMBOL, amount));

        console.log(`[SCAN] RSI: ${currentRSI.toFixed(2)} | EMA200: ${currentEMA200.toFixed(2)} | SOL: ${precioActual}`);

        // Verificamos filtros de RSI + Tendencia (EMA 200)
        const tendenciaAlcista = precioActual > currentEMA200;
        const tendenciaBajista = precioActual < currentEMA200;

        if (currentRSI <= RSI_ENTRADA_LONG && tendenciaAlcista) {
            await avisar(`🚀 *LONG DETECTADO*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}\nEMA200: ${currentEMA200.toFixed(2)}`);
            try {
                await exchange.createMarketBuyOrder(SYMBOL, formattedAmount);
            } catch (err) {
                await avisar(`❌ *ERROR ABRIENDO LONG:*\n${err.message}`);
                console.error("Error abriendo long:", err);
            }
        } 
        else if (currentRSI >= RSI_ENTRADA_SHORT && tendenciaBajista) {
            await avisar(`📉 *SHORT DETECTADO*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}\nEMA200: ${currentEMA200.toFixed(2)}`);
            try {
                await exchange.createMarketSellOrder(SYMBOL, formattedAmount);
            } catch (err) {
                await avisar(`❌ *ERROR ABRIENDO SHORT:*\n${err.message}`);
                console.error("Error abriendo short:", err);
            }
        }

    } catch (e) { 
        console.error("❌ Error Ciclo:", e.message); 
    }
}

// --- COMANDOS DE TELEGRAM ---
bot.command('status', async (ctx) => {
    try {
        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        const totalBalance = balance.total['USDT'] || 0;
        
        let marginCalculado = availableBalance * 0.90;
        if (marginCalculado > 50) marginCalculado = 50;

        const positions = await exchange.fetchPositions();
        const pos = positions.find(p => p.symbol === SYMBOL || (p.info && p.info.symbol === "SOLUSDT"));
        let contratos = 0;
        if (pos) {
            if (pos.contracts !== undefined) contratos = Number(pos.contracts);
            else if (pos.info && pos.info.positionAmt) contratos = Number(pos.info.positionAmt);
            else if (pos.amount !== undefined) contratos = Number(pos.amount);
        }
        const enPosicion = Math.abs(contratos) > 0;
        
        const estadoMsg = enPosicion ? "🟢 Operación Activa" : "⏳ Esperando señal";

        ctx.reply(`📊 Balance Total: $${totalBalance.toFixed(2)} USDT\n💸 Margen Próx. Operación: $${marginCalculado.toFixed(2)} USDT\n📈 Estado: ${estadoMsg}\n⚙️ Bot operando a ${LEVERAGE}X\n🎯 TP: $${PROFIT_OBJETIVO} | SL: $${LOSS_LIMITE}`);
    } catch (e) { ctx.reply("Error leyendo estado."); }
});

bot.command('testbuy', async (ctx) => {
    try {
        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        let marginCalculado = availableBalance * 0.90;
        if (marginCalculado > 50) marginCalculado = 50;

        const ticker = await exchange.fetchTicker(SYMBOL);
        let amount = (marginCalculado * LEVERAGE) / ticker.last;
        
        let notionalCalculado = amount * ticker.last;
        if (notionalCalculado < 10) {
            amount = 11 / ticker.last;
        }

        const formattedAmount = Number(exchange.amountToPrecision(SYMBOL, amount));
        await exchange.createMarketBuyOrder(SYMBOL, formattedAmount);
        ctx.reply(`🔥 *ORDEN DE PRUEBA EJECUTADA*\nEntraste al mercado con $${(amount * ticker.last / LEVERAGE).toFixed(2)} USD de margen.`);
    } catch (e) { ctx.reply("❌ Error en test: " + e.message); }
});

bot.command('stop', (ctx) => {
    ctx.reply("🛑 Deteniendo bot...");
    process.exit(0);
});

// INICIO
setup();
bot.launch();
setInterval(tradingLoop, 30000); // Cada 30 segs