require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const { RSI, EMA, Stochastic, ATR } = require('technicalindicators');
const http = require('http');

// --- UTILIDADES GLOBALES (JARVIS) ---
const cleanSymbol = (s) => (s || "").replace(/\//g, '').split(':')[0].toUpperCase();
const fetchCVDVolume = async (symbol, limit = 2) => {
    try {
        const cleaned = cleanSymbol(symbol);
        const rawKlines = await exchange.fapiPublicGetKlines({ symbol: cleaned, interval: '1m', limit });
        let takerBuyVol = 0, takerSellVol = 0;
        for (const k of rawKlines) {
            takerBuyVol += parseFloat(k[9]);
            takerSellVol += (parseFloat(k[5]) - parseFloat(k[9]));
        }
        return { takerBuyVol, takerSellVol };
    } catch (e) { return { takerBuyVol: 0, takerSellVol: 0 }; }
};

// --- SERVIDOR KEEP-ALIVE ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Jarvis V7.1 | Garbage Collector: Online');
}).listen(process.env.PORT || 3000);

// --- CONFIGURACIÓN TÉCNICA ---
let isEmaFilterActive = true;
let isBotPaused = false;
let globalSLPrice = null;       // SL price (para failsafe)
let botMode = 'HYBRID';         // Modos: ZEN, HYBRID, TIBURON
let lastClosedProfit = 0;       // Para lógica de re-entrada Surf
let lastClosedSymbol = null;
let lastClosedTime = 0;
let marketSentimentRSI = 50;    // Promedio RSI del Top 30
let activeTradeSymbol = null;   // Símbolo de la posición activa (V7.0)
let lastEntryTime = 0;          // Timestamp de entrada (V7.0 failsafe)

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;

let currentLeverage = 10;      // Survival Mode: Default 10X
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
        // Sanitización básica para evitar errores de parseo en Telegram (Markdown V1)
        // Escapamos caracteres que suelen romper el formato si no están balanceados
        const sanitizedMsg = msg.replace(/([_*\[`])/g, (match, p1) => {
            // Si el mensaje ya parece estar usando balanceo (p.ej. *texto*), lo dejamos pasar?
            // No, mejor escapamos todo lo que no sea explícitamente controlado.
            // Pero como 'msg' ya viene con asteriscos, vamos a ser selectivos.
            return match; 
        });
        
        // El error 'can't parse entities' suele ser por corchetes [ o asteriscos * huérfanos.
        // Reintentamos sin Markdown si falla.
        await bot.telegram.sendMessage(chatId, `🤖 *Jarvis | FastCL Oracle:*\n${msg}`, { parse_mode: 'Markdown' })
            .catch(async (err) => {
                if (err.message.includes('bad request') || err.message.includes('entities')) {
                    await bot.telegram.sendMessage(chatId, `🤖 Jarvis | FastCL Oracle:\n${msg.replace(/[*_`\[]/g, '')}`);
                }
            });
    } catch (e) { console.error("Error Telegram:", e.message); }
}

// --- SETUP INICIAL ---
async function setup() {
    try {
        await exchange.loadMarkets();
        console.log(`🏛️ V7.0 The Architect - [30s Scan] | Mode: ${botMode}`);
        await avisar(`🏛️ *PROTOCOLO JARVIS V7.0: THE ARCHITECT ACTIVADO*\nOrden Atomica (MARKET + SL + TP nativos): *ONLINE*\nMargen Conservador (30%): *ACTIVO*\nCancelacion Automatica de Ordenes Contrarias: *ONLINE*\nJarvis es indestructible ahora, señor.`);
    } catch (e) { console.error("Error Setup:", e.message); }
}

// ========================================================
// V7.0 - ARQUITECTURA DE ORDENES ATOMICAS (THE ARCHITECT)
// ========================================================
async function ejecutarEntrada(data, marginCalculado) {
    const { symbol, signalType, currentRSI, precioActual, calculatedATR } = data;
    const sym = cleanSymbol(symbol);

    // 1. Configurar apalancamiento y margen
    await exchange.setLeverage(currentLeverage, symbol).catch(() => {});
    await exchange.setMarginMode('ISOLATED', symbol).catch(() => {});

    // 2. Calcular cantidad
    let amount = (marginCalculado * currentLeverage) / precioActual;
    if ((amount * precioActual) < 10) amount = 11 / precioActual;
    const formattedAmount = Number(exchange.amountToPrecision(symbol, amount));

    // 3. Calcular precios de SL y TP
    const rawSL = signalType === 'LONG'
        ? precioActual - (1.5 * calculatedATR)
        : precioActual + (1.5 * calculatedATR);
    // TP: precio que genera $1 USD neto sobre el amount
    const tpDelta = PROFIT_OBJETIVO / formattedAmount;
    const rawTP = signalType === 'LONG'
        ? precioActual + tpDelta
        : precioActual - tpDelta;

    const formattedSL = Number(exchange.priceToPrecision(symbol, rawSL));
    const formattedTP = Number(exchange.priceToPrecision(symbol, rawTP));
    const entrySide   = signalType === 'LONG' ? 'buy'  : 'sell';
    const closeSide   = signalType === 'LONG' ? 'sell' : 'buy';

    const emoji = signalType === 'LONG' ? '🚀 LONG' : '📉 SHORT';
    await avisar(`${sym} ${emoji} *SEÑAL V7.0*\nRSI: ${currentRSI.toFixed(2)} | Precio: ${precioActual}\nSL: ${formattedSL} | TP: ${formattedTP}`);

    try {
        // 4. Orden de entrada a MERCADO (instantánea)
        await exchange.createMarketOrder(symbol, entrySide, formattedAmount);

        // 5. Esperar 1.5s para que Binance registre la posición
        await new Promise(r => setTimeout(r, 1500));

        // 6. Re-leer cantidad exacta del exchange (Total-Check)
        const updatedPos = await exchange.fetchPositions();
        const myPos = updatedPos.find(p =>
            (p.symbol === symbol || cleanSymbol(p.symbol) === sym) &&
            Math.abs(Number(p.contracts || p.info?.positionAmt || 0)) > 0
        );
        const exactAmount = myPos
            ? Math.abs(Number(myPos.contracts || myPos.info?.positionAmt || 0))
            : formattedAmount;

        // 7. STOP LOSS nativo en Binance (STOP_MARKET + reduceOnly)
        await exchange.createOrder(symbol, 'stop_market', closeSide, exactAmount, undefined, {
            stopPrice: formattedSL,
            reduceOnly: true
        });

        // 8. TAKE PROFIT nativo en Binance (TAKE_PROFIT_MARKET + reduceOnly)
        await exchange.createOrder(symbol, 'take_profit_market', closeSide, exactAmount, undefined, {
            stopPrice: formattedTP,
            reduceOnly: true
        });

        // 9. Guardar estado activo
        globalSLPrice     = formattedSL;
        activeTradeSymbol = symbol;
        lastEntryTime     = Date.now();
        lastClosedSymbol  = null;

        await avisar(`${sym} ✅ *POSICION ABIERTA + SL/TP EN BINANCE*\nAmt: ${exactAmount} | SL: ${formattedSL} | TP: ${formattedTP}\nLas ordenes estan visibles en tu panel de Binance, señor.`);

    } catch (err) {
        await avisar(`${sym} ❌ *ERROR ARQUITECTO:* ${err.message.substring(0, 100)}`);
        // Intentar cancelar ordenes huerfanas
        exchange.cancelAllOrders(symbol).catch(() => {});
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
        // ====================================================
        // V7.1 - GARBAGE COLLECTOR: limpiar ordenes huerfanas
        // Si hay ordenes abiertas pero NO hay posicion activa
        // para ese simbolo, las cancelamos automaticamente.
        // ====================================================
        try {
            const openOrders = await exchange.fetchOpenOrders();
            if (openOrders.length > 0) {
                const allPositions = await exchange.fetchPositions();
                const posSymbols = new Set(
                    allPositions
                        .filter(p => Math.abs(Number(p.contracts || p.info?.positionAmt || p.amount || 0)) > 0)
                        .map(p => p.symbol)
                );
                // Agrupar ordenes huerfanas por simbolo
                const orphanSymbols = new Set(
                    openOrders
                        .filter(o => !posSymbols.has(o.symbol))
                        .map(o => o.symbol)
                );
                for (const orphanSym of orphanSymbols) {
                    console.log(`🗑️ Garbage Collector: cancelando ordenes huerfanas de ${cleanSymbol(orphanSym)}`);
                    await exchange.cancelAllOrders(orphanSym).catch(() => {});
                    await avisar(`🗑️ *Garbage Collector:* Ordenes huerfanas de ${cleanSymbol(orphanSym)} canceladas. No habia posicion activa.`);
                }
            }
        } catch (gcErr) { console.error('Garbage Collector error:', gcErr.message); }

        const positions = await exchange.fetchPositions();
        const openPositions = positions.filter(p => Math.abs(Number(p.contracts || p.info?.positionAmt || p.amount || 0)) > 0);

        // 1. GESTIÓN DE SALIDA 글로벌 
        if (openPositions.length > 0) {
            const pos = openPositions[0];
            const activeSymbol = pos.symbol || (pos.info && pos.info.symbol);
            const contratos = Number(pos.contracts || pos.info?.positionAmt || pos.amount || 0);
            const precioEntrada = Number(pos.entryPrice || 0);
            const lado = contratos > 0 ? 'LONG' : 'SHORT';
            const sym = cleanSymbol(activeSymbol);
            const entryTimeRef = lastEntryTime || (Number(pos.timestamp || pos.info?.updateTime || 0));

            // V7.0: Las ordenes SL/TP nativas de Binance manejan la salida principal.
            // Aqui solo vigilamos por si el exchange ya cerro la posicion,
            // o si el failsafe de 5 minutos debe actuar.

            const ticker = await exchange.fetchTicker(activeSymbol);
            const precioActual = ticker.last;
            let pnlUSD = (precioActual - precioEntrada) * contratos;
            if (lado === 'SHORT') pnlUSD = (precioEntrada - precioActual) * Math.abs(contratos);

            // Failsafe de tiempo: 5 minutos sin que SL/TP firme = cierre manual de emergencia
            const timeOpenMs = entryTimeRef > 0 ? Date.now() - entryTimeRef : 0;
            if (timeOpenMs > TIME_LIMIT_MS && timeOpenMs < TIME_LIMIT_MS * 2) {
                const motivoTime = pnlUSD > 0
                    ? "⏱️ FAILSAFE 5m (asegurando ganancia)"
                    : "⏱️ FAILSAFE 5m (cerrando antes de mayor perdida)";

                // Cancelar ordenes pendientes de SL/TP en Binance
                await exchange.cancelAllOrders(activeSymbol).catch(() => {});
                await new Promise(r => setTimeout(r, 800));

                // Cierre de emergencia con Total-Check
                const freshPos = await exchange.fetchPositions();
                const fPos = freshPos.find(p => p.symbol === activeSymbol || cleanSymbol(p.symbol) === sym);
                const failAmt = fPos ? Math.abs(Number(fPos.contracts || fPos.info?.positionAmt || 0)) : Math.abs(contratos);
                if (failAmt > 0) {
                    const sideToClose = lado === 'LONG' ? 'sell' : 'buy';
                    await exchange.createMarketOrder(activeSymbol, sideToClose, failAmt, { reduceOnly: true })
                        .catch(async (e) => {
                            const cleaned = cleanSymbol(activeSymbol);
                            await exchange.createMarketOrder(cleaned, sideToClose, failAmt, { reduceOnly: true }).catch(() => {});
                        });
                    globalSLPrice = null;
                    activeTradeSymbol = null;
                    lastEntryTime = 0;
                    lastClosedProfit = pnlUSD;
                    lastClosedSymbol = activeSymbol;
                    lastClosedTime = Date.now();
                    await avisar(`${sym} ${motivoTime}\nCerrado emergencia: $${pnlUSD.toFixed(2)} USD`);
                }
            }
            return; // Posicion aun activa, SL/TP de Binance la controlan
        }

        // Si teniamos una posicion activa pero ya no existe: SL/TP de Binance la cerro
        if (activeTradeSymbol) {
            const sym = cleanSymbol(activeTradeSymbol);
            await exchange.cancelAllOrders(activeTradeSymbol).catch(() => {});
            await avisar(`${sym} \ud83c\udfc1 *POSICION CERRADA por Binance* (SL/TP nativo ejecutado)\nSistema listo para el siguiente trade, senor.`);
            lastClosedSymbol = activeTradeSymbol;
            lastClosedTime = Date.now();
            activeTradeSymbol = null;
            globalSLPrice = null;
            lastEntryTime = 0;
        }

        // Survival Mode Check
        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        
        if (availableBalance < 9.0) {
            if (currentLeverage !== 5) {
                currentLeverage = 5;
                await avisar("🛡️ *Survival Mode Activado*: Balance crítico (<$9). Reduciendo apalancamiento a 5X para preservar capital.");
            }
        } else {
            currentLeverage = 10;
        }

        let marginCalculado = availableBalance * 0.30;
        if (marginCalculado > 50) marginCalculado = 50;
        if (marginCalculado < 1) return; // Saldo insuficiente

        const allTickers = await exchange.fetchTickers();
        const usdtFutures = Object.keys(exchange.markets).filter(s => {
            const m = exchange.markets[s];
            return m.active && m.linear && m.quote === 'USDT' && allTickers[s] && allTickers[s].quoteVolume > 10000000;
        });

        usdtFutures.sort((a, b) => (allTickers[b].quoteVolume || 0) - (allTickers[a].quoteVolume || 0));
        const topCandidates = usdtFutures.slice(0, 30);
        
        // Sentimiento del Mercado (Jarvis)
        let totalRSI = 0;
        let rsiCount = 0;

        for (const symbol of topCandidates) {
            try {
                // Ghost Mode: Delay de 200ms para no saturar IP
                await new Promise(r => setTimeout(r, 200));

                // Fase 1: Filtro Inteligente (RSI Ligero - Solo 20 velas)
                const ohlcvLite = await exchange.fetchOHLCV(symbol, '1m', undefined, 25);
                if (!ohlcvLite || ohlcvLite.length < 20) continue;

                const closesLite = ohlcvLite.map(v => v[4]);
                const volumesLite = ohlcvLite.map(v => v[5]);
                
                // Lógica de Momentum Spike (Promedio de últimas 10 velas de volumen)
                const last10Vol = volumesLite.slice(-11, -1); 
                const avgVol10 = last10Vol.reduce((a,b) => a+b, 0) / (last10Vol.length || 1);
                const currentVol = volumesLite[volumesLite.length - 1];
                const momentumFactor = currentVol / (avgVol10 || 1);
                const isMomentumSpike = currentVol > (avgVol10 * 3.0);
                const isInstitutionalVol = currentVol > (avgVol10 * 4.0);

                const rsiLiteValues = RSI.calculate({ values: closesLite, period: 14 });
                const currentRSILite = rsiLiteValues[rsiLiteValues.length - 1];
                
                totalRSI += currentRSILite;
                rsiCount++;

                // Protocolo Centinela (Alertas sin entrada)
                if (isInstitutionalVol) {
                    await avisar(`⚠️ *Protocolo Centinela:* ${cleanSymbol(symbol)} registra volumen institucional masivo (*${momentumFactor.toFixed(1)}x*). Radar activado sobre esta moneda.`);
                }

                // Gate Zen Oracle: Si no hay volumen explosivo, aplicamos el filtro de RSI
                if (!isMomentumSpike) {
                    if (currentRSILite > 45 && currentRSILite < 55) continue;
                    if (botMode === 'TIBURON') continue; // Tiburón solo entra por volumen o spikes
                }

                // Fase 2: Carga de Datos Completa (Solo para monedas candidatas)
                const ohlcv = await exchange.fetchOHLCV(symbol, '1m', undefined, 250);
                if (!ohlcv || ohlcv.length < 250) continue;

                const closes = ohlcv.map(v => v[4]);
                const highs = ohlcv.map(v => v[2]);
                const lows = ohlcv.map(v => v[3]);
                const precioActual = closes[closes.length - 1];

                const rsiValues = RSI.calculate({ values: closes, period: 14 });
                const currentRSI = rsiValues[rsiValues.length - 1];

                const ema13Values = EMA.calculate({ values: closes, period: 13 });
                const ema26Values = EMA.calculate({ values: closes, period: 26 });
                const ema50Values = EMA.calculate({ values: closes, period: 50 });
                const ema13 = ema13Values[ema13Values.length - 1];
                const ema26 = ema26Values[ema26Values.length - 1];
                const ema50 = ema50Values[ema50Values.length - 1];

                const tripleEmaLong = ema13 > ema26 && ema26 > ema50;
                const tripleEmaShort = ema13 < ema26 && ema26 < ema50;

                const rsi7Values = RSI.calculate({ values: closes, period: 7 });
                const currentRsi7 = rsi7Values[rsi7Values.length - 1];
                const prevRsi7 = rsi7Values[rsi7Values.length - 2];
                const rsi7GiroLong = currentRsi7 > prevRsi7;
                const rsi7GiroShort = currentRsi7 < prevRsi7;

                const stochValues = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
                const currentStoch = stochValues[stochValues.length - 1];
                const prevStoch = stochValues[stochValues.length - 2];
                if(!currentStoch || !prevStoch) continue;

                const stochGiroLong = currentStoch.k > currentStoch.d && currentStoch.k > prevStoch.k;
                const stochGiroShort = currentStoch.k < currentStoch.d && currentStoch.k < prevStoch.k;

                const prevCandle = ohlcv[ohlcv.length - 2];
                const currCandle = ohlcv[ohlcv.length - 1];
                const prevHigh = prevCandle[2];
                const prevLow = prevCandle[3];
                const currentOpen = currCandle[1];
                
                const candleVerde = precioActual > currentOpen && precioActual > prevHigh;
                const candleRoja = precioActual < currentOpen && precioActual < prevLow;

                // Lógica de Inside Bar (BARD)
                const isInsideBar = highs[highs.length - 1] < highs[highs.length - 2] && lows[lows.length - 1] > lows[lows.length - 2];

                // Lógica Híbrida de Entrada
                const rsiEntryLong = currentRSI < RSI_ENTRADA_LONG && rsi7GiroLong && stochGiroLong;
                const rsiEntryShort = currentRSI > RSI_ENTRADA_SHORT && rsi7GiroShort && stochGiroShort;

                const opportunisticEntryLong = isMomentumSpike && (botMode === 'HYBRID' || botMode === 'TIBURON');
                const opportunisticEntryShort = isMomentumSpike && (botMode === 'HYBRID' || botMode === 'TIBURON');

                // Lógica Surf: Si cerramos profit hace poco y el volumen sigue, permitimos re-entrada inmediata
                const isSurfMode = (symbol === lastClosedSymbol && lastClosedProfit > 0 && (Date.now() - lastClosedTime < 180000));

                let pre1mLong = (botMode !== 'TIBURON' && rsiEntryLong && tripleEmaLong && candleVerde) || (opportunisticEntryLong && candleVerde);
                let pre1mShort = (botMode !== 'TIBURON' && rsiEntryShort && tripleEmaShort && candleRoja) || (opportunisticEntryShort && candleRoja);
                
                // Forzar surf si el spike persiste
                if (isSurfMode && isMomentumSpike) {
                    if (candleVerde) pre1mLong = true;
                    if (candleRoja) pre1mShort = true;
                }

                if (!pre1mLong && !pre1mShort) {
                    // Zen Oracle Evolution (Jarvis BARD)
                    if (currentRSILite < 30 && botMode === 'ZEN') {
                         /* Silencioso para evitar spam automático, pero Jarvis sabe */
                    }
                    continue;
                }

                // Fase 2: Confirmación Pesada usando Promise.allSettled
                const results = await Promise.allSettled([
                    exchange.fetchOHLCV(symbol, '5m', undefined, 100),
                    exchange.fetchOHLCV(symbol, '15m', undefined, 100)
                ]);
                if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') continue;
                
                const ohlcv5m = results[0].value;
                const ohlcv15m = results[1].value;
                if (!ohlcv5m || ohlcv5m.length < 50 || !ohlcv15m || ohlcv15m.length < 50) continue;

                const closes15m = ohlcv15m.map(v => v[4]);
                const ema50_15mValues = EMA.calculate({ values: closes15m, period: 50 });
                const currentEMA50_15m = ema50_15mValues[ema50_15mValues.length - 1];

                const vwapActual = calcularVWAPIntradia(ohlcv15m) || currentEMA50_15m; 
                
                const rsi5mValues = RSI.calculate({ values: ohlcv5m.map(v => v[4]), period: 14 });
                const currentRSI5m = rsi5mValues[rsi5mValues.length - 1];

                const vwapLongCheck = !isEmaFilterActive || precioActual > vwapActual;
                const vwapShortCheck = !isEmaFilterActive || precioActual < vwapActual;
                
                const rsiFuerteLong = currentRSI < RSI_ENTRADA_LONG && currentRSI5m < RSI_ENTRADA_LONG;
                const rsiFuerteShort = currentRSI > RSI_ENTRADA_SHORT && currentRSI5m > RSI_ENTRADA_SHORT;

                const ema15mLongCheck = !isEmaFilterActive || precioActual > currentEMA50_15m || rsiFuerteLong;
                const ema15mShortCheck = !isEmaFilterActive || precioActual < currentEMA50_15m || rsiFuerteShort;

                const precondicionLong = pre1mLong && vwapLongCheck && ema15mLongCheck;
                const precondicionShort = pre1mShort && vwapShortCheck && ema15mShortCheck;

                let signalType = null;
                if (precondicionLong) signalType = 'LONG';
                else if (precondicionShort) signalType = 'SHORT';

                if (!signalType && (pre1mLong || pre1mShort)) {
                    // Feedback Jarvis (Automático)
                    const sideWanted = pre1mLong ? 'LONG' : 'SHORT';
                    const closingJarvis = "\nSigo monitorizando cada latido del Top 30, señor.";
                    
                    if (isInsideBar) {
                        await avisar(`${cleanSymbol(symbol)} ❌ *Señor, BARD fue rechazada.* La vela ${sideWanted === 'LONG' ? 'Verde' : 'Roja'} es un "Inside Bar" (atrapada en el rango anterior). Las ballenas están absorbiendo la liquidez, no hay fuerza real.${closingJarvis}`);
                    }
                }

                if (signalType) {
                    const isMomentumEntry = isMomentumSpike && signalType === (precondicionLong ? 'LONG' : 'SHORT');
                    
                    const ob = await exchange.fetchOrderBook(symbol, 20);
                    const bidVol = ob.bids.reduce((acc, val) => acc + val[1], 0);
                    const askVol = ob.asks.reduce((acc, val) => acc + val[1], 0);
                    
                    let imbalancePass = (signalType === 'LONG' && bidVol > askVol * 1.2) || (signalType === 'SHORT' && askVol > bidVol * 1.2);

                    let deltaPass = false;
                    const { takerBuyVol, takerSellVol } = await fetchCVDVolume(symbol, 2);
                    deltaPass = (signalType === 'LONG' && takerBuyVol > takerSellVol) || (signalType === 'SHORT' && takerSellVol > takerBuyVol);

                    if (imbalancePass && deltaPass) {
                        if (isMomentumEntry) await avisar(`🦾 *Jarvis:* ${cleanSymbol(symbol)} Momentum Spike (${momentumFactor.toFixed(1)}x).`);
                        else if (isSurfMode) await avisar(`🏄‍♂️ *Jarvis:* ${cleanSymbol(symbol)} Surfeando ola.`);

                        const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop() || (precioActual * 0.01);
                        await ejecutarEntrada({ symbol, signalType, currentRSI, precioActual, calculatedATR: atr, isMarginHalved: Math.abs(allTickers[symbol].percentage) > 20 }, marginCalculado);
                        return;
                    }
                }
            } catch (e) {}
        }
        if (rsiCount > 0) marketSentimentRSI = totalRSI / rsiCount;
    } catch (e) { console.error("❌ Error Ciclo:", e.message); }
}

// --- COMANDOS DE TELEGRAM ---
async function reportarEstadoBot(ctx = null) {
    try {
        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        const totalBalance = balance.total['USDT'] || 0;
        let marginCalculado = availableBalance * 0.30;
        if (marginCalculado > 50) marginCalculado = 50;

        const positions = await exchange.fetchPositions();
        const openPositions = positions.filter(p => Math.abs(Number(p.contracts || p.info?.positionAmt || p.amount || 0)) > 0);
        
        const enPosicion = openPositions.length > 0;
        const activeSymbol = enPosicion ? (openPositions[0].symbol || openPositions[0].info?.symbol) : "Ninguno";

        // V7.1: PNL real de trades cerrados en las ultimas 4 horas
        let sessionPnl = 0;
        let pnlStr = "";
        try {
            const since = Date.now() - (4 * 60 * 60 * 1000);
            const myTrades = await exchange.fetchMyTrades(undefined, since, 50);
            for (const t of myTrades) {
                if (t.info && t.info.realizedPnl) {
                    sessionPnl += parseFloat(t.info.realizedPnl);
                }
            }
            const pnlEmoji = sessionPnl >= 0 ? '🟢' : '🔴';
            pnlStr = `\n${pnlEmoji} PNL (4h sesion): *$${sessionPnl.toFixed(3)} USD*`;
        } catch (e) {}
        
        const sentimentStr = marketSentimentRSI > 50 ? "🐂 ALCISTA" : "🐻 BAJISTA";
        let estadoStr = `🏛️ Jarvis V7.1 Garbage Collector (Mode: ${botMode})`;
        if (isBotPaused) estadoStr = "⏸️ PAUSADO";
        const cleanedActive = cleanSymbol(activeSymbol);
        const estadoMsg = enPosicion ? `🟢 Operacion Activa en ${cleanedActive}` : estadoStr;
        const emaEstatus = isEmaFilterActive ? "ON 🟢" : "OFF 🔴";

        const msg = `🏛️ Jarvis V7.1 | Balance: $${totalBalance.toFixed(2)} USDT\n💸 Margen (30%): $${marginCalculado.toFixed(2)} USDT${pnlStr}\n📈 Sentimiento: *${sentimentStr}* (RSI Avg: ${marketSentimentRSI.toFixed(1)})\n🧬 Modo: *${botMode}*\n⚙️ Estado: ${estadoMsg}\n🛡️ Palanca: ${currentLeverage}X | SL/TP nativos Binance\n⚙️ Filtros (VWAP EMA Flow): ${emaEstatus}`;
        
        if (ctx) ctx.reply(msg, { parse_mode: 'Markdown' });
        else await avisar(`⏳ *Heartbeat 1H* ⏳\n${msg}`);

    } catch (e) { 
        if (ctx) ctx.reply("Error leyendo estado.");
    }
}

bot.command('status', async (ctx) => { await reportarEstadoBot(ctx); });

bot.command('testbuy', async (ctx) => {
    try {
        const args = ctx.message.text.trim().split(' ').slice(1);
        let testSymbolStr = null;
        let testSideStr = null;

        for (const p of args) {
            const part = p.toUpperCase();
            if (part === 'LONG' || part === 'SHORT') testSideStr = part;
            else testSymbolStr = part;
        }

        await exchange.loadMarkets();

        if (!testSymbolStr) {
            ctx.reply("🤖 Jarvis: Buscando la unidad con mayor convergencia RSI...");
            const allTickers = await exchange.fetchTickers();
            const usdtFutures = Object.keys(exchange.markets).filter(s => {
                const m = exchange.markets[s];
                return m.active && m.linear && m.quote === 'USDT' && allTickers[s] && allTickers[s].quoteVolume > 10000000;
            });
            usdtFutures.sort((a, b) => (allTickers[b].quoteVolume || 0) - (allTickers[a].quoteVolume || 0));
            const top30 = usdtFutures.slice(0, 30);
            
            let bestRSI = testSideStr === 'SHORT' ? 0 : 100;
            let bestSymbol = 'SOL/USDT';
            
            for(const s of top30) {
                try {
                    const ohlcv = await exchange.fetchOHLCV(s, '1m', undefined, 20);
                    if(!ohlcv || ohlcv.length < 15) continue;
                    const closes = ohlcv.map(v => v[4]);
                    const rsiValues = RSI.calculate({ values: closes, period: 14 });
                    const currentRSI = rsiValues[rsiValues.length - 1];
                    
                    if (testSideStr === 'SHORT') {
                        if (currentRSI > bestRSI) { bestRSI = currentRSI; bestSymbol = s; }
                    } else { 
                        if (currentRSI < bestRSI) { bestRSI = currentRSI; bestSymbol = s; }
                    }
                } catch(e) {}
            }
            testSymbolStr = bestSymbol.split('/')[0];
            testSideStr = testSideStr || 'LONG';
        } else if (!testSideStr) {
            testSideStr = 'LONG';
        }

        // Limpieza Crítica Jarvis
        testSymbolStr = cleanSymbol(testSymbolStr);
        const market = Object.values(exchange.markets).find(m => cleanSymbol(m.symbol) === testSymbolStr && m.quote === 'USDT' && m.linear && m.active);
        const targetSymbol = market ? market.symbol : `${testSymbolStr}/USDT`;

        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        let marginCalculado = availableBalance * 0.30;
        if (marginCalculado > 50) marginCalculado = 50;

        await exchange.setLeverage(currentLeverage, targetSymbol).catch(() => {});
        await exchange.setMarginMode('ISOLATED', targetSymbol).catch(() => {});

        const ticker = await exchange.fetchTicker(targetSymbol);
        
        // Verificación BARD (Jarvis Protocol)
        const ohlcvTest = await exchange.fetchOHLCV(targetSymbol, '1m', undefined, 5);
        if (ohlcvTest && ohlcvTest.length >= 2) {
            const prevCandle = ohlcvTest[ohlcvTest.length - 2];
            const currCandle = ohlcvTest[ohlcvTest.length - 1];
            const prevHigh = prevCandle[2];
            const prevLow = prevCandle[3];
            const currentHigh = currCandle[2];
            const currentLow = currCandle[3];
            const currentOpen = currCandle[1];
            const precioActualTest = ticker.last;

            const rsiValues = RSI.calculate({ values: ohlcvTest.map(v=>v[4]), period: 14 }); // Fallback rsi short period
            const rsi1mActual = rsiValues[rsiValues.length - 1] || 50;
            const colorVela = precioActualTest > currentOpen ? 'Verde' : 'Roja';
            const isInsideBar = currentHigh < prevHigh && currentLow > prevLow;
            
            const dataJarvis = `\n📊 RSI 1m: ${rsi1mActual.toFixed(1)} | Vela: ${colorVela}${isInsideBar ? ' (Inside Bar)' : ''}`;
            const closingJarvis = "\nSigo monitorizando cada latido del mercado, señor. No hay prisa.";

            if (testSideStr === 'LONG' && colorVela === 'Roja') {
                return ctx.reply(`${finalSymbol} ❌ *Señor, no voy a dejar que atrapes un cuchillo.*${dataJarvis}\nEl precio sigue cayendo (Vela Roja). Esperaré a que el mercado me confirme un giro con una vela verde.${closingJarvis}`);
            }
            if (testSideStr === 'LONG' && isInsideBar) {
                return ctx.reply(`${finalSymbol} ❌ *Señor, BARD fue rechazada.*${dataJarvis}\nLa vela verde es un "Inside Bar" (atrapada en el rango anterior). Las ballenas están absorbiendo la liquidez, no hay fuerza real.${closingJarvis}`);
            }
            if (testSideStr === 'SHORT' && rsi1mActual < 30) {
                return ctx.reply(`${finalSymbol} ❌ *Señor, la moneda ya está muy agotada.*${dataJarvis}\nEl RSI está en ${rsi1mActual.toFixed(1)}. Hacer un Short aquí es lanzarse al vacío. ¡Tranquilo, yo cuido tu balance!${closingJarvis}`);
            }
        }

        let amount = (marginCalculado * currentLeverage) / ticker.last;
        let notionalCalculado = amount * ticker.last;
        if (notionalCalculado < 10) amount = 11 / ticker.last;

        const formattedAmount = Number(exchange.amountToPrecision(targetSymbol, amount));
        const formattedPrice = Number(exchange.priceToPrecision(targetSymbol, testSideStr === 'LONG' ? ticker.last * 1.001 : ticker.last * 0.999));
        
        const order = await exchange.createOrder(targetSymbol, 'limit', testSideStr === 'LONG' ? 'buy' : 'sell', formattedAmount, formattedPrice, { timeInForce: 'GTC' });
        setTimeout(() => { exchange.cancelOrder(order.id, targetSymbol).catch(() => {}); }, 30000);
        
        const finalSymbol = cleanSymbol(targetSymbol);
        ctx.reply(`${finalSymbol} 🦾 *Jarvis: Orden de prueba ${testSideStr} ejecutada.*\nMargen base: $${(amount * ticker.last / currentLeverage).toFixed(2)} USD. Apalancamiento: ${currentLeverage}X.`);
    } catch (e) { ctx.reply("🤖 Jarvis: Error en telemetría: " + e.message); }
});

bot.command('toggleema', (ctx) => {
    isEmaFilterActive = !isEmaFilterActive;
    ctx.reply(`⚡ Filtros de Trend Cambiados a: ${isEmaFilterActive ? 'ON 🟢' : 'OFF 🔴'}`);
});

bot.command('modozen', (ctx) => {
    botMode = 'ZEN';
    ctx.reply(`🧘 *Modo ZEN Activado*\nEntradas estrictas por RSI (Solo 5.4 Clásica). El bot ignorará spikes de volumen si el RSI no está en zona.`);
});

bot.command('modohibrido', (ctx) => {
    botMode = 'HYBRID';
    ctx.reply(`🧬 *Modo HIBRIDO Activado*\nEl bot buscará RSI y también aprovechará Momentum Spikes si la tendencia lo permite.`);
});

bot.command('modotiburon', (ctx) => {
    botMode = 'TIBURON';
    ctx.reply(`🦈 *Modo TIBURON Activado*\nPrioridad absoluta al Volumen y Momentum Spikes. El RSI es secundario. ¡Preparado para la caza!`);
});

bot.command('pause', (ctx) => {
    isBotPaused = true;
    ctx.reply(`⏸️ Bot PAUSADO.`);
});

bot.command('resume', (ctx) => {
    isBotPaused = false;
    ctx.reply(`▶️ Jarvis V7.1 Garbage Collector REANUDADO.`);
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
        console.log("🤖 FastCL V7.1 Garbage Collector (Telegram) Init OK.");
    }).catch(err => console.error("❌ Error en Telegram Launch:", err.message));
}, 5000);

setInterval(tradingLoop, 30000);
setInterval(() => reportarEstadoBot(), 3600000);