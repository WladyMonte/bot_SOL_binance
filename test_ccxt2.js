const ccxt = require('ccxt');
const fs = require('fs');

async function test() {
    const exchange = new ccxt.binance({ options: { defaultType: 'future' } });
    await exchange.loadMarkets();
    const ohlcv = await exchange.fetchOHLCV('BTC/USDT', '1m', undefined, 2);
    const klines = await exchange.fapiPublicGetKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 2 });
    const ticker = await exchange.fetchTicker('BTC/USDT');
    
    fs.writeFileSync('test_output.json', JSON.stringify({
        ohlcv: ohlcv,
        klines: klines,
        ticker_percentage: ticker.percentage
    }, null, 2));
}
test();
