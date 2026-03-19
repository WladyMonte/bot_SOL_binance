require('dotenv').config();
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');
const { RSI, EMA, Stochastic, ATR } = require('technicalindicators');
const http = require('http');

// --- SERVIDOR KEEP-ALIVE ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('FastCL V5.5 Hybrid Oracle: Sistema Operativo');
}).listen(process.env.PORT || 3000);

// --- CONFIGURACIÓN TÉCNICA ---
let isEmaFilterActive = true;
let isBotPaused = false;
let globalSLPrice = null;     // SL Calculado por ATR
let positionExitReason = null; // Para control en debug
let botMode = 'HYBRID';       // Modos: ZEN, HYBRID, TIBURON
let lastClosedProfit = 0;     // Para lógica de re-entrada Surf
let lastClosedSymbol = null;
let lastClosedTime = 0;

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
        console.log(`🚀 V5.5 Hybrid Oracle - 30s Scan | Mode: ${botMode}`);
        await avisar(`🔥 *SISTEMA EN LINEA V5.5 - Hybrid Oracle*\nModo Actual: *${botMode}*\nEscaneando Top 30 mercado Futuros por Volumen (>10M)\nFiltros: VWAP, Triple EMA, OrderBook Flow, RSI(7), Stoch, ATR.\nTP: +$1.0 / SL: 1.5x ATR | Limit GTC (30s timeout)\n\n*NUEVOS COMANDOS:*\n🧘 /modozen - Solo entradas por RSI clásicas.\n🧬 /modohibrido - Entradas RSI + Volumen.\n🦈 /modotiburon - Prioridad absoluta a Momentum Spike (Volumen).`);
    } catch (e) { console.error("Error Setup:", e.message); }
}

async function ejecutarEntrada(data, marginCalculado) {
    const { symbol, signalType, currentRSI, precioActual, calculatedATR, isMarginHalved } = data;
    
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
    
    // GTC Limit Order Config con Timeout
    // Usamos el precio actual +- 0.1% para la orden límite agresiva
    let orderPrice = signalType === 'LONG' ? precioActual * 1.001 : precioActual * 0.999;
    const formattedPrice = Number(exchange.priceToPrecision(symbol, orderPrice));

    if (signalType === 'LONG') {
        globalSLPrice = precioActual - (1.5 * calculatedATR);
        const msgMargin = isMarginHalved ? "\n⚠️ *Margen Reducido 50% (>20% Variación)*" : "";
        await avisar(`[${symbol}] 🚀 *LONG DETECTADO (V5.4)*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}\nSL_ATR (-1.5x): ${globalSLPrice.toFixed(4)}${msgMargin}`);
        try {
            const order = await exchange.createOrder(symbol, 'limit', 'buy', formattedAmount, formattedPrice, { timeInForce: 'GTC' });
            setTimeout(() => { exchange.cancelOrder(order.id, symbol).catch(() => {}); }, 30000);
        } catch (err) {
            await avisar(`[${symbol}] ❌ *ERROR ABRIENDO LONG:*\n${err.message}`);
        }
    } else {
        globalSLPrice = precioActual + (1.5 * calculatedATR);
        const msgMargin = isMarginHalved ? "\n⚠️ *Margen Reducido 50% (>20% Variación)*" : "";
        await avisar(`[${symbol}] 📉 *SHORT DETECTADO (V5.4)*\nRSI: ${currentRSI.toFixed(2)}\nPrecio: ${precioActual}\nSL_ATR (+1.5x): ${globalSLPrice.toFixed(4)}${msgMargin}`);
        try {
            const order = await exchange.createOrder(symbol, 'limit', 'sell', formattedAmount, formattedPrice, { timeInForce: 'GTC' });
            setTimeout(() => { exchange.cancelOrder(order.id, symbol).catch(() => {}); }, 30000);
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
            
            // Recalcular SL si se reinició el bot
            if (!globalSLPrice) {
                const ohlcvSL = await exchange.fetchOHLCV(activeSymbol, '1m', undefined, 100);
                if (ohlcvSL && ohlcvSL.length > 50) {
                    const atrV = ATR.calculate({ high: ohlcvSL.map(v=>v[2]), low: ohlcvSL.map(v=>v[3]), close: ohlcvSL.map(v=>v[4]), period: 14 });
                    const currATR = atrV[atrV.length - 1] || (precioEntrada * 0.01);
                    globalSLPrice = lado === 'LONG' ? precioEntrada - (1.5 * currATR) : precioEntrada + (1.5 * currATR);
                }
            }

            let pnlUSD = (precioActual - precioEntrada) * contratos;
            if (lado === 'SHORT') pnlUSD = (precioEntrada - precioActual) * Math.abs(contratos);

            let motivo = null;
            if (pnlUSD >= PROFIT_OBJETIVO) {
                motivo = `💰 TAKE PROFIT ($${PROFIT_OBJETIVO})`;
            } else if (globalSLPrice) {
                if (lado === 'LONG' && precioActual <= globalSLPrice) motivo = "🛑 STOP LOSS (1.5x ATR)";
                if (lado === 'SHORT' && precioActual >= globalSLPrice) motivo = "🛑 STOP LOSS (1.5x ATR)";
            } else if (pnlUSD <= -10.0) { // Failsafe extremo
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
                    lastClosedProfit = pnlUSD;
                    lastClosedSymbol = activeSymbol;
                    lastClosedTime = Date.now();
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
                // Ghost Mode: Delay de 200ms para no saturar IP
                await new Promise(r => setTimeout(r, 200));

                // Fase 1: Filtro Inteligente (RSI Ligero - Solo 20 velas)
                const ohlcvLite = await exchange.fetchOHLCV(symbol, '1m', undefined, 20);
                if (!ohlcvLite || ohlcvLite.length < 15) continue;

                const closesLite = ohlcvLite.map(v => v[4]);
                const volumesLite = ohlcvLite.map(v => v[5]);
                
                // Lógica de Momentum Spike (Promedio de últimas 10 velas de volumen)
                const last10Vol = volumesLite.slice(-11, -1); 
                const avgVol10 = last10Vol.reduce((a,b) => a+b, 0) / (last10Vol.length || 1);
                const currentVol = volumesLite[volumesLite.length - 1];
                const isMomentumSpike = currentVol > (avgVol10 * 3.0);

                const rsiLiteValues = RSI.calculate({ values: closesLite, period: 14 });
                const currentRSILite = rsiLiteValues[rsiLiteValues.length - 1];

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
                    // Si el bot detectó RSI cerca pero no pasó el filtro de confirmación, loggeamos Zen Oracle (opcional)
                    /* console.log(`[${symbol}] Candle/Stoch fail: RSI ${currentRSI.toFixed(1)}`); */
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
                    // Zen Oracle: Feedback de rechazo automático para movimientos agotados
                    const sideWanted = pre1mLong ? 'LONG' : 'SHORT';
                    const closingAviso = "\nNo hay prisa, el mercado da oportunidades cada minuto. Sigo escaneando el Top 30.";
                    
                    if (sideWanted === 'SHORT' && currentRSI < 30) {
                        await avisar(`[${symbol}] ❌ *Oportunidad Reprimida (Zen Oracle)*\nRechazado: El RSI 1m está en ${currentRSI.toFixed(1)}, la moneda ya está muy agotada. Hacer un Short aquí es lanzarse al vacío. Esperaré a que suba para buscar una mejor entrada. ¡Tranquilo, yo cuido tu balance!${closingAviso}`);
                    }
                }

                if (signalType) {
                    const isMomentumEntry = isMomentumSpike && signalType === (precondicionLong ? 'LONG' : 'SHORT');
                    const momentumFactor = (currentVol / avgVol10).toFixed(1);
                    
                    // --- Capa de Flujo (Order Flow & DOM) ---
                    // 1. Imbalance del order book (Relajado a 1.2x)
                    const ob = await exchange.fetchOrderBook(symbol, 20);
                    const bidVol = ob.bids.reduce((acc, val) => acc + val[1], 0);
                    const askVol = ob.asks.reduce((acc, val) => acc + val[1], 0);
                    
                    let imbalancePass = false;
                    if (signalType === 'LONG' && bidVol > askVol * 1.2) imbalancePass = true;
                    if (signalType === 'SHORT' && askVol > bidVol * 1.2) imbalancePass = true;

                    // 2. CVD Check (Taker Buy vs Sell Volume real en últimos 2 min)
                    let deltaPass = false;
                    try {
                        const rawKlines = await exchange.fapiPublicGetKlines({ symbol: symbol.replace('/', ''), interval: '1m', limit: 2 });
                        let takerBuyVol = 0;
                        let takerSellVol = 0;
                        for (const k of rawKlines) {
                            const totalVol = parseFloat(k[5]);
                            const tBuyVol = parseFloat(k[9]);
                            takerBuyVol += tBuyVol;
                            takerSellVol += (totalVol - tBuyVol);
                        }
                        if (signalType === 'LONG' && takerBuyVol > takerSellVol) deltaPass = true;
                        if (signalType === 'SHORT' && takerSellVol > takerBuyVol) deltaPass = true;
                    } catch (e) {
                        console.error("Error fetching CVD volume:", e.message);
                    }

                    if (imbalancePass && deltaPass) {
                         // Feedback especial Zen Oracle + Opportunistic
                         if (isMomentumEntry) {
                            await avisar(`[${symbol}] 🚀 *Entrando por Momentum Spike (Vol: ${momentumFactor}x). ¡Subiéndome al cohete!*`);
                         } else if (isSurfMode) {
                            await avisar(`[${symbol}] 🏄‍♂️ *Surfing Mode: Re-entrada detectada por persistencia de fuerza.*`);
                         }

                        // Calcular ATR (Stop Loss dinámico)
                        const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
                        const calculatedATR = atrValues[atrValues.length - 1] || ((precioActual * 0.01));

                        // 3. Margin Adjustment 20% Variación Protection (Symmetry)
                        let tradeMargin = marginCalculado;
                        let isMarginHalved = false;
                        if (allTickers[symbol] && Math.abs(allTickers[symbol].percentage) > 20) {
                            tradeMargin = tradeMargin / 2;
                            isMarginHalved = true;
                        }

                        const signalData = { symbol, signalType, currentRSI, precioActual, calculatedATR, isMarginHalved };
                        await ejecutarEntrada(signalData, tradeMargin);
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
        
        let estadoStr = `🔍 Escaneando V5.5 (Mode: ${botMode})`;
        if (isBotPaused) estadoStr = "⏸️ PAUSADO";
        const estadoMsg = enPosicion ? `🟢 Operación Activa en [${activeSymbol}]` : estadoStr;
        const emaEstatus = isEmaFilterActive ? "ON 🟢" : "OFF 🔴";

        const msg = `📊 Balance Total: $${totalBalance.toFixed(2)} USDT\n💸 Margen: $${marginCalculado.toFixed(2)} USDT\n📈 Modo Activo: *${botMode}*\n⚙️ Estado: ${estadoMsg}\n🛡️ Filtros (VWAP, EMA, Flow): ${emaEstatus}`;
        
        if (ctx) ctx.reply(msg);
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
        let testSideStr = null; // Autodetect if null

        for (const p of args) {
            const part = p.toUpperCase();
            if (part === 'LONG' || part === 'SHORT') testSideStr = part;
            else testSymbolStr = part.includes('/') ? part.split('/')[0] : part;
        }

        await exchange.loadMarkets();

        if (!testSymbolStr) {
            ctx.reply("Buscando mejor moneda (Top 30 + RSI)...");
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
                    } else { // default as LONG checks for lowest RSI
                        if (currentRSI < bestRSI) { bestRSI = currentRSI; bestSymbol = s; }
                    }
                } catch(e) {}
            }
            testSymbolStr = bestSymbol.split('/')[0];
            testSideStr = testSideStr || 'LONG'; // fallback para la orden
        } else if (!testSideStr) {
            testSideStr = 'LONG';
        }

        const market = Object.values(exchange.markets).find(m => m.base === testSymbolStr && m.quote === 'USDT' && m.linear && m.active);
        const targetSymbol = market ? market.symbol : `${testSymbolStr}/USDT`;

        const balance = await exchange.fetchBalance();
        const availableBalance = balance.free['USDT'] || 0;
        let marginCalculado = availableBalance * 0.90;
        if (marginCalculado > 50) marginCalculado = 50;

        await exchange.setLeverage(LEVERAGE, targetSymbol).catch(() => {});
        await exchange.setMarginMode('ISOLATED', targetSymbol).catch(() => {});

        const ticker = await exchange.fetchTicker(targetSymbol);
        
        // Verificación de Estructura de Vela para TestBuy
        const ohlcvTest = await exchange.fetchOHLCV(targetSymbol, '1m', undefined, 2);
        if (ohlcvTest && ohlcvTest.length >= 2) {
            const prevCandle = ohlcvTest[0];
            const currCandle = ohlcvTest[1];
            const prevHigh = prevCandle[2];
            const prevLow = prevCandle[3];
            const currentOpen = currCandle[1];
            const precioActualTest = ticker.last;

            // Zen Oracle: Obtener RSIs para el feedback detallado
            const closesTest = ohlcvTest.map(v => v[4]); // Nota: ohlcvTest solo tiene 2 velas por el fetch 2 original
            // Re-petición para RSI real si queremos datos técnicos exactos
            const ohlcvRSI = await exchange.fetchOHLCV(targetSymbol, '1m', undefined, 30);
            const ohlcvRSI5 = await exchange.fetchOHLCV(targetSymbol, '5m', undefined, 20);
            const r1 = RSI.calculate({ values: ohlcvRSI.map(v=>v[4]), period: 14 });
            const r5 = RSI.calculate({ values: ohlcvRSI5.map(v=>v[4]), period: 14 });
            const rsi1mActual = r1[r1.length - 1];
            const rsi5mActual = r5[r5.length - 1];
            const colorVela = precioActualTest > currentOpen ? 'Verde' : 'Roja';
            const dataTecnica = `\n📊 RSI 1m: ${rsi1mActual.toFixed(1)} | RSI 5m: ${rsi5mActual.toFixed(1)} | Vela: ${colorVela}`;
            const closingAviso = "\nNo hay prisa, el mercado da oportunidades cada minuto. Sigo escaneando el Top 30.";

            if (testSideStr === 'LONG' && colorVela === 'Roja') {
                return ctx.reply(`[${targetSymbol}] ❌ *Rechazado: El precio sigue cayendo (Vela Roja).*${dataTecnica}\nNo voy a dejar que 'atrapes un cuchillo' ahora. Esperaré a que el mercado me confirme un giro con una vela verde. Sigo vigilando por ti.${closingAviso}`);
            }
            if (testSideStr === 'SHORT' && rsi1mActual < 30) {
                return ctx.reply(`[${targetSymbol}] ❌ *Rechazado: La moneda ya está muy agotada.*${dataTecnica}\nEl RSI está en ${rsi1mActual.toFixed(1)}. Hacer un Short aquí es lanzarse al vacío. Esperaré a que suba para buscar una mejor entrada. ¡Tranquilo, yo cuido tu balance!${closingAviso}`);
            }

            // Fallback genéricos si no cumple las reglas de la V5.2 pero no entran en Zen Oracle específico
            if (testSideStr === 'LONG' && !(precioActualTest > currentOpen && precioActualTest > prevHigh)) {
                return ctx.reply(`[${targetSymbol}] ❌ *TestBuy Rechazado (V5.2 Fallback)*${dataTecnica}\nEstructura de Vela Verde no confirmada para LONG.${closingAviso}`);
            }
            if (testSideStr === 'SHORT' && !(precioActualTest < currentOpen && precioActualTest < prevLow)) {
                return ctx.reply(`[${targetSymbol}] ❌ *TestBuy Rechazado (V5.2 Fallback)*${dataTecnica}\nEstructura de Vela Roja no confirmada para SHORT.${closingAviso}`);
            }
        }

        let amount = (marginCalculado * LEVERAGE) / ticker.last;
        let notionalCalculado = amount * ticker.last;
        if (notionalCalculado < 10) amount = 11 / ticker.last;

        const formattedAmount = Number(exchange.amountToPrecision(targetSymbol, amount));
        
        let orderPrice = testSideStr === 'LONG' ? ticker.last * 1.001 : ticker.last * 0.999;
        const formattedPrice = Number(exchange.priceToPrecision(targetSymbol, orderPrice));
        const orderSide = testSideStr === 'LONG' ? 'buy' : 'sell';
        
        const order = await exchange.createOrder(targetSymbol, 'limit', orderSide, formattedAmount, formattedPrice, { timeInForce: 'GTC' });
        setTimeout(() => { exchange.cancelOrder(order.id, targetSymbol).catch(() => {}); }, 30000);
        
        ctx.reply(`[${targetSymbol}] 🔥 *ORDEN DE PRUEBA ${testSideStr} (Limit GTC 30s) EJECUTADA*\nMargen base: $${(amount * ticker.last / LEVERAGE).toFixed(2)} USD.`);
    } catch (e) { ctx.reply("❌ Error en test: " + e.message); }
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
    ctx.reply(`▶️ Bot REANUDADO V5.5.`);
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
        console.log("🤖 FastCL V5.5 Hybrid Oracle (Telegram) Init OK.");
    }).catch(err => console.error("❌ Error en Telegram Launch:", err.message));
}, 5000);

setInterval(tradingLoop, 30000);
setInterval(() => reportarEstadoBot(), 3600000);