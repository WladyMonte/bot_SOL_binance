require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const { RSI, EMA, Stochastic, ATR } = require('technicalindicators');
const http = require('http');

// --- SERVIDOR KEEP-ALIVE ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('FastCL V5.0 The Oracle: Sistema Operativo');
}).listen(process.env.PORT || 3000);

// --- CONFIGURACIÓN TÉCNICA ---
let isEmaFilterActive = true;
let isBotPaused = false;
let globalSLPrice = null;     // SL Calculado por ATR
let positionExitReason = null; // Para control en debug

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;

const LEVERAGE = 10;            
const PROFIT_OBJETIVO = 1.0;    // Fijo a $1.00 USD neto
const RSI_ENTRADA_LONG = 40;    // Modificado para The Oracle
const RSI_ENTRADA_SHORT = 60;   
const TIME_LIMIT_MS = 5 * 60 * 1000; // Límite de 5 min para trades

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
        console.log(`🚀 V5.0 The Oracle - 15s Scan | Institutional Build`);
        await avisar("🔥 *SISTEMA EN LINEA V5.0 - The Oracle*\nEscaneando Top 30 mercado Futuros por Volumen (>10M)\nFiltros: VWAP, Triple EMA, OrderBook Flow, RSI(7), Stoch, ATR.\nTP: +$1.0 / SL: 1.5x ATR | Limit IOC Orders\n\n*COMANDOS DISPONIBLES:*\n📊 /status - Estado actual y balance.\n🏆 /top - Ver las 30 monedas en vigilancia.\n⚡ /toggleema - Activar/Desactivar filtro de tendencia.\n⏸️ /pause / ▶️ /resume - Pausar o reanudar el bot.\n🚨 /panic - Cerrar todo y apagar.\n🧪 /testbuy [MONEDA] - Operación de prueba manual.");
    } catch (e) { console.error("Error Setup:", e.message); }
}

async function ejecutarEntrada(data, marginCalculado) {
    const { symbol, signalType, currentRSI, precioActual, calculatedATR } = data;
    
    await exchange.setLeverage(LEVERAGE, symbol).catch(() => {});
    await exchange.setMarginMode('ISOLATED', symbol).catch(() => {});

    let amount = (marginCalculado * LEVERAGE) / precioActual;
    let notionalCalculado = amount * precioActual;
    if (notionalCalculado < 10) {
        amount = 11 / precioActual;
    }

    const formattedAmount = Number(exchange.amountToPrecision(symbol, amount));
    const marketInfo = exchange.markets[symbol];
    const pricePrecision = marketInfo.precision ? marketInfo.precision.price : 4;
    
    // IOC Limit Order Config
    // Usamos el precio actual +- 0.1% para la orden límite agresiva IOC
    let orderPrice = signalType === 'LONG' ? precioActual * 1.001 : precioActual * 0.999;
    const formattedPrice = Number(exchange.priceToPrecision(symbol, orderPrice));

    if (signalType === 'LONG') {
        globalSLPrice = precioActual - (1.5 * calculatedATR);
        await avisar(`[${symbol}] 🚀 *LONG DETECTADO (The Oracle)*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}\nSL_ATR (-1.5x): ${globalSLPrice.toFixed(4)}`);
        try {
            await exchange.createOrder(symbol, 'limit', 'buy', formattedAmount, formattedPrice, { timeInForce: 'IOC' });
        } catch (err) {
            await avisar(`[${symbol}] ❌ *ERROR ABRIENDO LONG:*\n${err.message}`);
        }
    } else {
        globalSLPrice = precioActual + (1.5 * calculatedATR);
        await avisar(`[${symbol}] 📉 *SHORT DETECTADO (The Oracle)*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}\nSL_ATR (+1.5x): ${globalSLPrice.toFixed(4)}`);
        try {
            await exchange.createOrder(symbol, 'limit', 'sell', formattedAmount, formattedPrice, { timeInForce: 'IOC' });
        } catch (err) {
            await avisar(`[${symbol}] ❌ *ERROR ABRIENDO SHORT:*\n${err.message}`);
        }
    }
}

// Función auxiliar VWAP Intradía (usando velas de 15m)
function calcularVWAPIntradia(velas15m) {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startObjTime = startOfDay.getTime();

    let cumulativeVolume = 0;
    let cumulativePriceVolume = 0;

    for (const v of velas15m) {
        if (v[0] >= startObjTime) {
            const typicalPrice = (v[2] + v[3] + v[4]) / 3;
            cumulativePriceVolume += typicalPrice * v[5];
            cumulativeVolume += v[5];
        }
    }
    return cumulativeVolume > 0 ? (cumulativePriceVolume / cumulativeVolume) : null;
}

// --- CORE DEL BOT ---
async function tradingLoop() {
    if (isBotPaused) return;

    try {
        const positions = await exchange.fetchPositions();
        const openPositions = positions.filter(p => Math.abs(Number(p.contracts || p.info?.positionAmt || p.amount || 0)) > 0);

        // 1. GESTIÓN DE SALIDA 글로벌 
        if (openPositions.length > 0) {
            const pos = openPositions[0];
            const activeSymbol = pos.symbol || (pos.info && pos.info.symbol);
            const contratos = Number(pos.contracts || pos.info?.positionAmt || pos.amount || 0);
            const precioEntrada = Number(pos.entryPrice || 0);
            const updateTime = Number(pos.timestamp || (pos.info && pos.info.updateTime) || Date.now());
            
            const ticker = await exchange.fetchTicker(activeSymbol);
            const precioActual = ticker.last;
            const lado = contratos > 0 ? 'LONG' : 'SHORT';
            
            let pnlUSD = (precioActual - precioEntrada) * contratos;
            if (lado === 'SHORT') pnlUSD = (precioEntrada - precioActual) * Math.abs(contratos);

            let motivo = null;
            if (pnlUSD >= PROFIT_OBJETIVO) {
                motivo = `💰 TAKE PROFIT ($${PROFIT_OBJETIVO})`;
            } else if (globalSLPrice) {
                if (lado === 'LONG' && precioActual <= globalSLPrice) motivo = "🛑 STOP LOSS (1.5x ATR)";
                if (lado === 'SHORT' && precioActual >= globalSLPrice) motivo = "🛑 STOP LOSS (1.5x ATR)";
            } else if (pnlUSD <= -10.0) { // Failsafe fuerte si se pierde el SL global en un reinicio
                motivo = "🛑 STOP LOSS (Failsafe)";
            }

            // Capa de Ejecución y Gestión: Límite de 5 Minutos
            const timeOpenMs = Date.now() - updateTime;
            if (!motivo && timeOpenMs > TIME_LIMIT_MS) {
                if (pnlUSD > -0.2 && pnlUSD < 0.2) {
                    motivo = "⏱️ TIME LIMIT 5m (Cierre en Breakeven, pulso perdido)";
                } else if (pnlUSD > 0.2) {
                     motivo = "⏱️ TIME LIMIT 5m (Asegurando ganancias tras expiración)";
                } else if (pnlUSD <= -0.2) {
                     motivo = "⏱️ TIME LIMIT 5m (Impulso muerto, cerrando pérdida controlada)";
                }
            }

            if (motivo) {
                const sideToClose = lado === 'LONG' ? 'sell' : 'buy';
                try {
                    await exchange.createMarketOrder(activeSymbol, sideToClose, Math.abs(contratos), { reduceOnly: true });
                    globalSLPrice = null;
                    await avisar(`[${activeSymbol}] ${motivo}\nCerrado con: $${pnlUSD.toFixed(2)} USD`);
                } catch (err) {
                    await avisar(`[${activeSymbol}] ❌ *ERROR CERRANDO POSICIÓN:*\n${err.message}`);
                }
            }
            return; // Bloquea la búsqueda global mientras haya posición
        }

        // 2. DETECCION DE ENTRADAS UNIVERSAL (THE ORACLE)
        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        let marginCalculado = availableBalance * 0.90;
        if (marginCalculado > 50) marginCalculado = 50;
        if (marginCalculado < 1) return; // Saldo insuficiente

        const allTickers = await exchange.fetchTickers();
        const usdtFutures = Object.keys(exchange.markets).filter(s => {
            const m = exchange.markets[s];
            return m.active && m.linear && m.quote === 'USDT' && allTickers[s] && allTickers[s].quoteVolume > 10000000;
        });

        usdtFutures.sort((a, b) => (allTickers[b].quoteVolume || 0) - (allTickers[a].quoteVolume || 0));
        const topCandidates = usdtFutures.slice(0, 30);
        
        for (const symbol of topCandidates) {
            try {
                // Obtenemos velas de 1m (250) y 15m (100)
                const [ohlcv, ohlcv15m] = await Promise.all([
                    exchange.fetchOHLCV(symbol, '1m', undefined, 250),
                    exchange.fetchOHLCV(symbol, '15m', undefined, 100)
                ]);
                
                if (!ohlcv || ohlcv.length < 250 || !ohlcv15m || ohlcv15m.length < 50) continue;

                // --- Capa de Confluencia (Bias & Trend) ---
                const closes15m = ohlcv15m.map(v => v[4]);
                const ema50_15mValues = EMA.calculate({ values: closes15m, period: 50 });
                const currentEMA50_15m = ema50_15mValues[ema50_15mValues.length - 1];

                const closes = ohlcv.map(v => v[4]);
                const highs = ohlcv.map(v => v[2]);
                const lows = ohlcv.map(v => v[3]);
                const precioActual = closes[closes.length - 1];

                const vwapActual = calcularVWAPIntradia(ohlcv15m) || currentEMA50_15m; 
                
                // Triple EMA Cross (13, 26, 50 en 1m)
                const ema13Values = EMA.calculate({ values: closes, period: 13 });
                const ema26Values = EMA.calculate({ values: closes, period: 26 });
                const ema50Values = EMA.calculate({ values: closes, period: 50 });
                const ema13 = ema13Values[ema13Values.length - 1];
                const ema26 = ema26Values[ema26Values.length - 1];
                const ema50 = ema50Values[ema50Values.length - 1];

                // Filtros tendenciales base The Oracle
                const vwapLongCheck = !isEmaFilterActive || precioActual > vwapActual;
                const vwapShortCheck = !isEmaFilterActive || precioActual < vwapActual;
                
                const ema15mLongCheck = !isEmaFilterActive || precioActual > currentEMA50_15m;
                const ema15mShortCheck = !isEmaFilterActive || precioActual < currentEMA50_15m;

                const tripleEmaLong = ema13 > ema26 && ema26 > ema50;
                const tripleEmaShort = ema13 < ema26 && ema26 < ema50;

                // --- Capa Sniper (Gatillos) ---
                const rsiValues = RSI.calculate({ values: closes, period: 14 });
                const currentRSI = rsiValues[rsiValues.length - 1];

                const rsi7Values = RSI.calculate({ values: closes, period: 7 });
                const currentRsi7 = rsi7Values[rsi7Values.length - 1];
                const prevRsi7 = rsi7Values[rsi7Values.length - 2];
                // RSI 7 girando
                const rsi7GiroLong = currentRsi7 > prevRsi7;
                const rsi7GiroShort = currentRsi7 < prevRsi7;

                // Stochastic (14, 3, 3)
                const stochValues = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
                const currentStoch = stochValues[stochValues.length - 1];
                const prevStoch = stochValues[stochValues.length - 2];
                if(!currentStoch || !prevStoch) continue;

                // Stoch alineado (K y D) y girando
                const stochGiroLong = currentStoch.k > currentStoch.d && currentStoch.k > prevStoch.k;
                const stochGiroShort = currentStoch.k < currentStoch.d && currentStoch.k < prevStoch.k;

                // Condiciones Long y Short
                const precondicionLong = currentRSI < RSI_ENTRADA_LONG && tripleEmaLong && vwapLongCheck && ema15mLongCheck && rsi7GiroLong && stochGiroLong;
                const precondicionShort = currentRSI > RSI_ENTRADA_SHORT && tripleEmaShort && vwapShortCheck && ema15mShortCheck && rsi7GiroShort && stochGiroShort;

                let signalType = null;
                if (precondicionLong) signalType = 'LONG';
                else if (precondicionShort) signalType = 'SHORT';

                if (signalType) {
                    // --- Capa de Flujo (Order Flow & DOM) ---
                    // 1. Imbalance del order book
                    const ob = await exchange.fetchOrderBook(symbol, 20);
                    const bidVol = ob.bids.reduce((acc, val) => acc + val[1], 0);
                    const askVol = ob.asks.reduce((acc, val) => acc + val[1], 0);
                    
                    let imbalancePass = false;
                    if (signalType === 'LONG' && bidVol > askVol * 1.5) imbalancePass = true;
                    if (signalType === 'SHORT' && askVol > bidVol * 1.5) imbalancePass = true;

                    // 2. Delta Check
                    const trades = await exchange.fetchTrades(symbol, undefined, 100);
                    const twoMinsAgo = Date.now() - 2 * 60 * 1000;
                    let buyerVolume = 0;
                    let sellerVolume = 0;
                    for (const t of trades) {
                        if (t.timestamp >= twoMinsAgo) {
                            if (t.side === 'buy') buyerVolume += t.amount;
                            else if (t.side === 'sell') sellerVolume += t.amount;
                        }
                    }
                    let deltaPass = false;
                    if (signalType === 'LONG' && buyerVolume > sellerVolume) deltaPass = true;
                    if (signalType === 'SHORT' && sellerVolume > buyerVolume) deltaPass = true;

                    if (imbalancePass && deltaPass) {
                        // Calcular ATR (Stop Loss dinámico)
                        const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
                        const calculatedATR = atrValues[atrValues.length - 1] || ((precioActual * 0.01));

                        const signalData = { symbol, signalType, currentRSI, precioActual, calculatedATR };
                        await ejecutarEntrada(signalData, marginCalculado);
                        return; // 1 trade máximo
                    }
                }
            } catch (e) {
                // Ignore error for this coin
            }
        }
    } catch (e) { 
        console.error("❌ Error Ciclo:", e.message); 
    }
}

// --- COMANDOS DE TELEGRAM ---
async function reportarEstadoBot(ctx = null) {
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
        
        let estadoStr = "🔍 Escaneando V5.0 (Oracle)";
        if (isBotPaused) estadoStr = "⏸️ PAUSADO";
        const estadoMsg = enPosicion ? `🟢 Operación Activa en [${activeSymbol}]` : estadoStr;
        const emaEstatus = isEmaFilterActive ? "ON 🟢" : "OFF 🔴";

        const msg = `📊 Balance Total: $${totalBalance.toFixed(2)} USDT\n💸 Margen: $${marginCalculado.toFixed(2)} USDT\n📈 Estado: ${estadoMsg}\n⚙️ Global: ${LEVERAGE}X | Limit IOC\n🎯 TP: $${PROFIT_OBJETIVO} | SL: 1.5x ATR\n📉 Filtros (VWAP, EMA, Flow): ${emaEstatus}`;
        
        if (ctx) ctx.reply(msg);
        else await avisar(`⏳ *Heartbeat 1H* ⏳\n${msg}`);

    } catch (e) { 
        if (ctx) ctx.reply("Error leyendo estado.");
    }
}

bot.command('status', async (ctx) => { await reportarEstadoBot(ctx); });

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
        if (notionalCalculado < 10) amount = 11 / ticker.last;

        const formattedAmount = Number(exchange.amountToPrecision(targetSymbol, amount));
        const orderPrice = Number(exchange.priceToPrecision(targetSymbol, ticker.last * 1.001));
        
        await exchange.createOrder(targetSymbol, 'limit', 'buy', formattedAmount, orderPrice, { timeInForce: 'IOC' });
        ctx.reply(`[${targetSymbol}] 🔥 *ORDEN DE PRUEBA (Limit IOC) EJECUTADA*\nMargen base: $${(amount * ticker.last / LEVERAGE).toFixed(2)} USD.`);
    } catch (e) { ctx.reply("❌ Error en test: " + e.message); }
});

bot.command('toggleema', (ctx) => {
    isEmaFilterActive = !isEmaFilterActive;
    ctx.reply(`⚡ Filtros de Trend Cambiados a: ${isEmaFilterActive ? 'ON 🟢' : 'OFF 🔴'}`);
});

bot.command('pause', (ctx) => {
    isBotPaused = true;
    ctx.reply(`⏸️ Bot PAUSADO.`);
});

bot.command('resume', (ctx) => {
    isBotPaused = false;
    ctx.reply(`▶️ Bot REANUDADO V5.0.`);
});

bot.command('panic', async (ctx) => {
    ctx.reply("🚨 PANIC MODE ACTIVADO...");
    isBotPaused = true;
    try {
        const positions = await exchange.fetchPositions();
        const openPositions = positions.filter(p => Math.abs(Number(p.contracts || p.info?.positionAmt || p.amount || 0)) > 0);
        for (const pos of openPositions) {
            const activeSymbol = pos.symbol || pos.info?.symbol;
            const contratos = Number(pos.contracts || pos.info?.positionAmt || pos.amount || 0);
            const lado = contratos > 0 ? 'LONG' : 'SHORT';
            const sideToClose = lado === 'LONG' ? 'sell' : 'buy';
            await exchange.createMarketOrder(activeSymbol, sideToClose, Math.abs(contratos), { reduceOnly: true });
            ctx.reply(`✅ Posición ${lado} de ${activeSymbol} cerrada.`);
        }
        process.exit(0);
    } catch (e) { ctx.reply(`❌ Error en panic: ${e.message}`); }
});

bot.command('top', async (ctx) => {
    try {
        await exchange.loadMarkets();
        const allTickers = await exchange.fetchTickers();
        const usdtFutures = Object.keys(exchange.markets).filter(s => {
            const m = exchange.markets[s];
            return m.active && m.linear && m.quote === 'USDT' && allTickers[s] && allTickers[s].quoteVolume > 10000000;
        });
        usdtFutures.sort((a, b) => (allTickers[b].quoteVolume || 0) - (allTickers[a].quoteVolume || 0));
        
        const top30 = usdtFutures.slice(0, 30);
        let msg = "🏆 *Top 30 Binance Futures (Oracle Mode):*\n";
        for (let i = 0; i < top30.length; i++) {
            const s = top30[i];
            const t = allTickers[s];
            msg += `${i+1}. *${s}* | Chg: ${t.percentage ? t.percentage.toFixed(2) : 0}% | Vol: $${(t.quoteVolume / 1000000).toFixed(2)}M\n`;
        }
        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) { ctx.reply("❌ Error: " + e.message); }
});

setup();
setTimeout(() => {
    bot.launch({ dropPendingUpdates: true }).then(() => {
        console.log("🤖 FastCL V5.0 The Oracle (Telegram) Init OK.");
    }).catch(err => console.error("❌ Error en Telegram Launch:", err.message));
}, 5000);

setInterval(tradingLoop, 15000);
setInterval(() => reportarEstadoBot(), 3600000);