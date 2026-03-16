const ccxt = require('ccxt');
require('dotenv').config();
const { RSI } = require('technicalindicators');

// CONFIGURACIÓN DE EXPERTO - MODO AGRESIVO
const SYMBOL = 'SOL/USDT';
const TIMEFRAME = '1m';
const LEVERAGE = 5;
const RISK_PCT = 0.90;       // 90% del saldo para alcanzar el mínimo de Binance
const STOP_LOSS_PCT = 0.02;  // 2% de pérdida máxima (10% con el apalancamiento)
const TAKE_PROFIT_PCT = 0.04; // 4% de ganancia (20% con el apalancamiento)

async function runSuperBot() {
    const exchange = new ccxt.binance({
        apiKey: process.env.BINANCE_API_KEY,
        secret: process.env.BINANCE_SECRET_KEY,
        options: { 'defaultType': 'future' }
    });

    console.log(`\n🛡️  BOT AGRESIVO INICIADO`);
    console.log(`📍 Monitoreando: ${SYMBOL} | ⏳ Intervalo: ${TIMEFRAME} | ⚡ Palanca: ${LEVERAGE}x\n`);

    while (true) {
        try {
            // 1. Configurar Apalancamiento
            await exchange.setLeverage(LEVERAGE, SYMBOL);

            // 2. Obtener Datos y Calcular RSI
            const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 100);
            const prices = ohlcv.map(c => c[4]);
            const currentPrice = prices[prices.length - 1];

            const rsiValues = RSI.calculate({ values: prices, period: 14 });
            const lastRSI = rsiValues[rsiValues.length - 1];

            console.log(`[${new Date().toLocaleTimeString()}] PRECIO: ${currentPrice} | RSI: ${lastRSI.toFixed(2)}`);

            // 3. Revisar si ya hay una posición abierta
            const positions = await exchange.fetchPositions([SYMBOL]);
            const hasPosition = positions.some(p => parseFloat(p.contracts) !== 0);

            if (!hasPosition) {
                // LÓGICA DE ENTRADA AGRESIVA
                if (lastRSI < 45) {
                    console.log("🟢 SEÑAL DE COMPRA (RSI < 45). Ejecutando LONG...");
                    await executeTrade(exchange, 'buy', currentPrice);
                } 
                else if (lastRSI > 55) {
                    console.log("🔴 SEÑAL DE VENTA (RSI > 55). Ejecutando SHORT...");
                    await executeTrade(exchange, 'sell', currentPrice);
                }
            } else {
                console.log("⏳ Posición abierta detectada. Esperando cierre...");
            }

            // Esperar 30 segundos para la próxima lectura
            await new Promise(resolve => setTimeout(resolve, 30000));

        } catch (e) {
            console.error("❌ Error en el ciclo:", e.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function executeTrade(exchange, side, price) {
    try {
        const balance = await exchange.fetchBalance();
        const freeUSDT = balance.total.USDT;
        
        // Cálculo de cantidad basado en riesgo y apalancamiento
        const amountToUse = freeUSDT * RISK_PCT;
        const quantity = (amountToUse * LEVERAGE) / price;
        const formattedQty = exchange.amountToPrecision(SYMBOL, quantity);

        // 1. Orden de Entrada (Mercado)
        const order = await exchange.createMarketOrder(SYMBOL, side, formattedQty);
        console.log(`✅ Orden ${side.toUpperCase()} abierta por ${formattedQty} SOL`);

        // 2. Definir Precios de Salida
        const slPrice = side === 'buy' ? price * (1 - STOP_LOSS_PCT) : price * (1 + STOP_LOSS_PCT);
        const tpPrice = side === 'buy' ? price * (1 + TAKE_PROFIT_PCT) : price * (1 - TAKE_PROFIT_PCT);

        // 3. Colocar Stop Loss y Take Profit en Binance
        const reverseSide = side === 'buy' ? 'sell' : 'buy';
        
        await exchange.createOrder(SYMBOL, 'STOP_MARKET', reverseSide, formattedQty, undefined, {
            stopPrice: exchange.priceToPrecision(SYMBOL, slPrice)
        });
        
        await exchange.createOrder(SYMBOL, 'TAKE_PROFIT_MARKET', reverseSide, formattedQty, undefined, {
            stopPrice: exchange.priceToPrecision(SYMBOL, tpPrice)
        });

        console.log(`🎯 Paracaídas listos -> SL: ${slPrice.toFixed(2)} | TP: ${tpPrice.toFixed(2)}`);

    } catch (error) {
        console.error("⚠️ Fallo al ejecutar trade:", error.message);
    }
}

runSuperBot();