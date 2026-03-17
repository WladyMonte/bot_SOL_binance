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
        await bot.telegram.sendMessage(chatId, `🤖 *FastCL Ultra:*\n${msg}`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("Error Telegram:", e.message); }
}

// --- SETUP INICIAL ---
async function setup() {
    try {
        await exchange.loadMarkets();
        console.log(`🚀 FastCL Ultra V4.0 (Universal Hunter) - Optimizado para Interés Compuesto iniciado: 10X GLOBAL`);
        await avisar("🔥 *SISTEMA EN LINEA V4.0 - Universal Hunter*\nEscaneando todo el mercado de Futuros > $15M Vol\nFiltro: RSI + EMA200 Global | Prioridad: Volatilidad 4h > 15%\nObjetivo: +$1.2 / -$0.5");
    } catch (e) { console.error("Error Setup:", e.message); }
}

async function ejecutarEntrada(data, marginCalculado) {
    const { symbol, signalType, currentRSI, precioActual, currentEMA200 } = data;
    
    // Configurar apalancamiento y margen para el símbolo elegido dinámicamente
    await exchange.setLeverage(LEVERAGE, symbol).catch(() => {});
    await exchange.setMarginMode('ISOLATED', symbol).catch(() => {});

    let amount = (marginCalculado * LEVERAGE) / precioActual;
    let notionalCalculado = amount * precioActual;
    if (notionalCalculado < 10) {
        amount = 11 / precioActual;
    }

    const formattedAmount = Number(exchange.amountToPrecision(symbol, amount));

    if (signalType === 'LONG') {
        await avisar(`[${symbol}] 🚀 *LONG DETECTADO*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}\nEMA200: ${currentEMA200.toFixed(2)}`);
        try {
            await exchange.createMarketBuyOrder(symbol, formattedAmount);
        } catch (err) {
            await avisar(`[${symbol}] ❌ *ERROR ABRIENDO LONG:*\n${err.message}`);
            console.error(`Error abriendo long en ${symbol}:`, err);
        }
    } else {
        await avisar(`[${symbol}] 📉 *SHORT DETECTADO*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}\nEMA200: ${currentEMA200.toFixed(2)}`);
        try {
            await exchange.createMarketSellOrder(symbol, formattedAmount);
        } catch (err) {
            await avisar(`[${symbol}] ❌ *ERROR ABRIENDO SHORT:*\n${err.message}`);
            console.error(`Error abriendo short en ${symbol}:`, err);
        }
    }
}

// --- CORE DEL BOT ---
async function tradingLoop() {
    try {
        const positions = await exchange.fetchPositions();
        // Filtrar cualquier posición global con contratos > 0
        const openPositions = positions.filter(p => Math.abs(Number(p.contracts || p.info?.positionAmt || p.amount || 0)) > 0);

        // 1. GESTIÓN DE SALIDAS (TP/SL) GLOBAL - UNA SOLA POSICIÓN PERMITIDA
        if (openPositions.length > 0) {
            const pos = openPositions[0];
            const activeSymbol = pos.symbol || (pos.info && pos.info.symbol);
            const contratos = Number(pos.contracts || pos.info?.positionAmt || pos.amount || 0);
            const precioEntrada = Number(pos.entryPrice || 0);
            
            const ticker = await exchange.fetchTicker(activeSymbol);
            const precioActual = ticker.last;

            const lado = contratos > 0 ? 'LONG' : 'SHORT';
            
            let pnlUSD = (precioActual - precioEntrada) * contratos;
            if (lado === 'SHORT') pnlUSD = (precioEntrada - precioActual) * Math.abs(contratos);

            console.log(`[${new Date().toLocaleTimeString()}] [${activeSymbol}] ${lado} Activo | PnL: $${pnlUSD.toFixed(2)}`);

            if (pnlUSD >= PROFIT_OBJETIVO || pnlUSD <= -LOSS_LIMITE) {
                const motivo = pnlUSD >= PROFIT_OBJETIVO ? "💰 PROFIT" : "🛑 STOP LOSS";
                const sideToClose = lado === 'LONG' ? 'sell' : 'buy';
                
                try {
                    await exchange.createMarketOrder(activeSymbol, sideToClose, Math.abs(contratos), { reduceOnly: true });
                    await avisar(`[${activeSymbol}] ${motivo}\nCerrado con: $${pnlUSD.toFixed(2)} USD`);
                } catch (err) {
                    await avisar(`[${activeSymbol}] ❌ *ERROR CERRANDO POSICIÓN:*\n${err.message}`);
                }
            }
            return; // Bloquea la búsqueda global mientras haya posición
        }

        // 2. DETECCION DE ENTRADAS UNIVERSAL
        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        let marginCalculado = availableBalance * 0.90;
        // Limitamos el máximo capital en juego
        if (marginCalculado > 50) marginCalculado = 50;
        if (marginCalculado < 1) return; // Saldo insuficiente

        const allTickers = await exchange.fetchTickers();
        const usdtFutures = Object.keys(exchange.markets).filter(s => {
            const m = exchange.markets[s];
            return m.active && m.linear && m.quote === 'USDT' && allTickers[s] && allTickers[s].quoteVolume > 15000000;
        });

        // Ordenamos por % de cambio 24h para analizar primero las más volátiles
        usdtFutures.sort((a, b) => Math.abs(allTickers[b].percentage || 0) - Math.abs(allTickers[a].percentage || 0));
        
        // Limitamos a top 15 para evitar golpear los límites de la API de Binance
        const topCandidates = usdtFutures.slice(0, 15);
        let secondarySignal = null;

        for (const symbol of topCandidates) {
            try {
                // Obtenemos 250 velas de 1m, lo que cubre ~4h y 10m y sirve para calcular RSI y EMA
                const ohlcv = await exchange.fetchOHLCV(symbol, '1m', undefined, 250);
                if (!ohlcv || ohlcv.length < 250) continue;

                const closes = ohlcv.map(v => v[4]);
                const rsiValues = RSI.calculate({ values: closes, period: 14 });
                const ema200Values = EMA.calculate({ values: closes, period: 200 });

                const currentRSI = rsiValues[rsiValues.length - 1];
                const currentEMA200 = ema200Values[ema200Values.length - 1];
                const precioActual = closes[closes.length - 1];

                // Movimiento 4h -> comparando precio de hace 240 velas (minutos) con el actual
                const open4h = ohlcv[250 - 240][1];
                const move4h = Math.abs((precioActual - open4h) / open4h) * 100;

                const tendenciaAlcista = precioActual > currentEMA200;
                const tendenciaBajista = precioActual < currentEMA200;

                let signalType = null;
                if (currentRSI <= RSI_ENTRADA_LONG && tendenciaAlcista) signalType = 'LONG';
                else if (currentRSI >= RSI_ENTRADA_SHORT && tendenciaBajista) signalType = 'SHORT';

                if (signalType) {
                    const signalData = { symbol, signalType, currentRSI, precioActual, currentEMA200 };
                    
                    if (move4h > 15) {
                        // Prioridad Absoluta: El mercado se movió más del 15% en 4h y además hay señal RSI + EMA
                        console.log(`[ALERTA] Movimiento extremo (>15%) detectado en ${symbol}! Priorizando orden.`);
                        await ejecutarEntrada(signalData, marginCalculado);
                        console.log(`[LOOP] Escaneo finalizado: ${topCandidates.length} monedas revisadas, 1 señales encontradas.`);
                        return; // Detener flujo para asegurar única posición
                    } else if (!secondarySignal) {
                        // Guardar la primera señal válida por si ninguna otra tiene >15% de movimiento
                        secondarySignal = signalData;
                    }
                }
            } catch (e) {
                // Ignorar error individual y continuar con la siguiente moneda
            }
        }

        let senalesEncontradas = secondarySignal ? 1 : 0;
        // Si terminó el escáner del top 15 sin ninguna moneda prioritaria (>15%), ejecuta la mejor señal standard si se encontró
        if (secondarySignal) {
            await ejecutarEntrada(secondarySignal, marginCalculado);
        }

        console.log(`[LOOP] Escaneo finalizado: ${topCandidates.length} monedas revisadas, ${senalesEncontradas} señales encontradas.`);

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
        const openPositions = positions.filter(p => Math.abs(Number(p.contracts || p.info?.positionAmt || p.amount || 0)) > 0);
        
        const enPosicion = openPositions.length > 0;
        const activeSymbol = enPosicion ? (openPositions[0].symbol || openPositions[0].info?.symbol) : "Ninguno";
        
        const estadoMsg = enPosicion ? `🟢 Operación Activa en [${activeSymbol}]` : "🔍 Escaneando V4.0 (Universal Hunter)";

        ctx.reply(`📊 Balance Total: $${totalBalance.toFixed(2)} USDT\n💸 Margen Próx. Operación: $${marginCalculado.toFixed(2)} USDT\n📈 Estado: ${estadoMsg}\n⚙️ Bot operando a ${LEVERAGE}X GLOBAL\n🎯 TP: $${PROFIT_OBJETIVO} | SL: $${LOSS_LIMITE}`);
    } catch (e) { ctx.reply("Error leyendo estado."); }
});

bot.command('testbuy', async (ctx) => {
    try {
        const msg = ctx.message.text.trim().split(' ');
        let testSymbolStr = msg.length > 1 ? msg[1].toUpperCase() : 'SOL';
        if(testSymbolStr.includes('/')) testSymbolStr = testSymbolStr.split('/')[0];
        
        await exchange.loadMarkets();
        const market = Object.values(exchange.markets).find(m => m.base === testSymbolStr && m.quote === 'USDT' && m.linear && m.active);
        const targetSymbol = market ? market.symbol : 'SOL/USDT';

        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        let marginCalculado = availableBalance * 0.90;
        if (marginCalculado > 50) marginCalculado = 50;

        await exchange.setLeverage(LEVERAGE, targetSymbol).catch(() => {});
        await exchange.setMarginMode('ISOLATED', targetSymbol).catch(() => {});

        const ticker = await exchange.fetchTicker(targetSymbol);
        let amount = (marginCalculado * LEVERAGE) / ticker.last;
        
        let notionalCalculado = amount * ticker.last;
        if (notionalCalculado < 10) {
            amount = 11 / ticker.last;
        }

        const formattedAmount = Number(exchange.amountToPrecision(targetSymbol, amount));
        await exchange.createMarketBuyOrder(targetSymbol, formattedAmount);
        ctx.reply(`[${targetSymbol}] 🔥 *ORDEN DE PRUEBA EJECUTADA*\nEntraste al mercado con $${(amount * ticker.last / LEVERAGE).toFixed(2)} USD de margen.`);
    } catch (e) { ctx.reply("❌ Error en test: " + e.message); }
});

bot.command('stop', (ctx) => {
    ctx.reply("🛑 Deteniendo bot...");
    process.exit(0);
});

bot.command('top', async (ctx) => {
    try {
        await exchange.loadMarkets();
        const allTickers = await exchange.fetchTickers();
        const usdtFutures = Object.keys(exchange.markets).filter(s => {
            const m = exchange.markets[s];
            return m.active && m.linear && m.quote === 'USDT' && allTickers[s] && allTickers[s].quoteVolume > 15000000;
        });

        usdtFutures.sort((a, b) => Math.abs(allTickers[b].percentage || 0) - Math.abs(allTickers[a].percentage || 0));
        
        const top3 = usdtFutures.slice(0, 3);
        let msg = "🏆 *Top 3 Monedas Volátiles (Futuros USDT-M):*\n\n";
        for (let i = 0; i < top3.length; i++) {
            const s = top3[i];
            const t = allTickers[s];
            msg += `${i+1}. *${s}*\n   Cambio 24h: ${t.percentage ? t.percentage.toFixed(2) : 0}%\n   Volumen: $${(t.quoteVolume / 1000000).toFixed(2)}M\n\n`;
        }
        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply("❌ Error obteniendo el Top 3: " + e.message);
    }
});

// INICIO
setup();

// Demora al iniciar Telegraf para evitar conflicto 409 de instancias previas reiniciándose rápidamente (Railway)
setTimeout(() => {
    bot.launch({ dropPendingUpdates: true }).then(() => {
        console.log("🤖 Telegram de FastCL Ultra iniciado correctamente.");
    }).catch(err => console.error("❌ Error en Telegram Launch:", err.message));
}, 5000); // 5 segundos de espera

setInterval(tradingLoop, 30000); // Cada 30 segs