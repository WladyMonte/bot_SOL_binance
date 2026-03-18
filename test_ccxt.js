const ccxt = require('ccxt');

async function test() {
    const exchange = new ccxt.binance({ options: { defaultType: 'future' } });
    await exchange.loadMarkets();
    const ohlcv = await exchange.fetchOHLCV('BTC/USDT', '1m', undefined, 2);
    console.log("OHLCV format:", ohlcv);
    
    // Also test fapiPublicGetKlines
    const klines = await exchange.fapiPublicGetKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 2 });
    console.log("fapiPublicGetKlines format:", klines);
    
    const ticker = await exchange.fetchTicker('BTC/USDT');
    console.log("Ticker percentage:", ticker.percentage);
}
test();
