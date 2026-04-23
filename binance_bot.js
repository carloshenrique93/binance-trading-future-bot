import ccxt from 'ccxt';
import dotenv from 'dotenv';
import fs from 'fs';
import { RSI, EMA, BollingerBands } from 'technicalindicators';
import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';

dotenv.config({ path: '.env.trading' });

// Configuration
const SYMBOL = 'BTC/USDT';
const TIMEFRAME_ENTRY = '1m';
const LEVERAGE = 5; 
const BANK_BRL = 1000.0; 
const DAILY_TARGET_BRL = 10.0; 
const POSITION_AMOUNT = 0.005; // Aprox. $325 (Seguro para banca de $185 com 5x alavancagem)
const STATE_FILE = 'bot_state.json';
const LOG_FILE = 'trading_logs.json';
const PORT = process.env.PORT || 5000;
const DASHBOARD_PWD = process.env.DASHBOARD_PASSWORD || '1234';

// --- VACINA DEFINITIVA: SILENCIADOR DE FIREWALL ---
const testnet = 'https://testnet.binancefuture.com/fapi/v1';

const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
    enableRateLimit: true,
    options: { 
        defaultType: 'future',
        adjustForTimeDifference: true,
    },
    urls: {
        api: {
            fapiPublic: testnet,
            fapiPrivate: testnet,
            public: testnet,
            private: testnet,
            sapi: 'http://127.0.0.1:9999' // Redireciona SAPI (bloqueado) para o nada
        }
    }
});

// Monkey-patching: Interceptamos a função de rede para ignorar bloqueios do firewall
const originalFetch = exchange.fetch;
exchange.fetch = async function (url, method, headers, body) {
    // Se a URL contém o endereço oficial bloqueado, nós simplesmente "matamos" a requisição
    if (url.includes('api.binance.com')) {
        // Retornamos um erro vazio que o robô possa ignorar
        return {}; 
    }
    try {
        return await originalFetch.apply(this, arguments);
    } catch (e) {
        // Se falhar qualquer coisa que não seja essencial, silenciamos
        if (url.includes('fapi')) throw e; // Só reportamos erro se for nos Futuros
        return {};
    }
};
// -------------------------------------------
let isPaused = false;

let priceHistory = [];
let state = {
    dailyProfitBRL: 0,
    lastUpdate: new Date().toLocaleDateString(),
    inPosition: false,
    direction: '', 
    entryPrice: 0,
    amount: 0,
    maxProfitReached: 0,
    trades: []
};

if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE));
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(message, isBox = false) {
    const timestamp = new Date().toLocaleString('pt-BR');
    const entry = isBox ? message : `[${timestamp}] 🤖 ${message}`;
    console.log(entry);
    fs.appendFileSync(LOG_FILE, entry + '\n');
}

async function setupTradeMode() {
    log(`Iniciando Sincronização Silenciosa...`);
    try {
        // Tentamos o básico sem travar o bot
        try { await exchange.setLeverage(LEVERAGE, SYMBOL); } catch (e) {}
        log(`Pronto para agir.`);
    } catch (e) {}
}

async function getIndicators() {
    try {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME_ENTRY, undefined, 250);
        const closes = ohlcv.map(x => x[4]);
        const currentPrice = closes[closes.length - 1];
        
        const rsiValues = RSI.calculate({ values: closes, period: 7 }); 
        const ema200Values = EMA.calculate({ period: 200, values: closes });
        const bbValues = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
        
        priceHistory = ohlcv.map(x => ({ 
            time: x[0] / 1000, 
            open: x[1], 
            high: x[2], 
            low: x[3], 
            close: x[4] 
        })).slice(-30); // Mantemos apenas 30 para o dashboard não travar
        
        return {
            currentPrice: currentPrice,
            rsi: rsiValues[rsiValues.length - 1],
            ema200: ema200Values[ema200Values.length - 1],
            bb: bbValues[bbValues.length - 1]
        };
    } catch (error) {
        if (error.message.includes('fetch failed')) return null;
        log(`Erro de Dados: ${error.message}`);
        return null;
    }
}

async function run() {
    const today = new Date().toLocaleDateString();
    if (state.lastUpdate !== today) {
        state.dailyProfitBRL = 0;
        state.lastUpdate = today;
        saveState();
    }

    if (isPaused) return;
    if (state.dailyProfitBRL >= DAILY_TARGET_BRL) return;

    try {
        const data = await getIndicators();
        if (!data || !data.ema200 || !data.bb) return;

        const { currentPrice, rsi, ema200, bb } = data;
        const status = isPaused ? '⏸️ PAUSADO' : (state.inPosition ? `🔘 EM ${state.direction}` : '🔍 MONITORANDO');
        process.stdout.write(`\r${status} | P: ${currentPrice.toFixed(2)} | RSI: ${rsi?.toFixed(1)} | EMA200: ${ema200?.toFixed(2)}    `);

        if (!state.inPosition) {
            let side = '';
            // ESTRATÉGIA QUANT-MASTER: Tripla Confirmação
            const isTrendUp = currentPrice > ema200;
            const isTrendDown = currentPrice < ema200;
            const isOversold = rsi < 40 && currentPrice <= bb.lower;
            const isOverbought = rsi > 60 && currentPrice >= bb.upper;

            if (isTrendUp && isOversold) side = 'LONG';
            if (isTrendDown && isOverbought) side = 'SHORT';

            if (side) {
                log(`🚀 Abrindo ${side} (Tripla Confirmação)...`);
                try {
                    const orderSide = side === 'LONG' ? 'buy' : 'sell';
                    await exchange.createMarketOrder(SYMBOL, orderSide, POSITION_AMOUNT);
                    
                    state.inPosition = true;
                    state.direction = side;
                    state.entryPrice = currentPrice;
                    state.amount = POSITION_AMOUNT;
                    state.maxProfitReached = 0;
                    state.trades.push({ type: side, price: currentPrice, time: new Date().toISOString() });
                    
                    const statusMsg = `🚀 NOVO TRADE ABERTO: ${side} | Preço: ${currentPrice.toFixed(2)} | Alavancagem: ${LEVERAGE}x`;
                    log(statusMsg);
                    saveState();
                } catch (e) { log(`❌ Ordem negada: ${e.message}`); }
            }
        } else {
            const isLong = state.direction === 'LONG';
            const priceChange = isLong ? 
                (currentPrice - state.entryPrice) / state.entryPrice :
                (state.entryPrice - currentPrice) / state.entryPrice;
            
            const currentBRLResult = priceChange * BANK_BRL * LEVERAGE;

            // Atualiza o lucro máximo para o Trailing Stop
            if (currentBRLResult > state.maxProfitReached) {
                state.maxProfitReached = currentBRLResult;
            }

            // GESTÃO DE SAÍDA AVANÇADA
            const takeProfit = currentBRLResult >= 5.00; // Alvo de lucro R$ 5,00
            const stopLoss = currentBRLResult <= -5.00; // Stop Loss R$ 5,00
            
            // Trailing Stop: Se já lucrou R$ 1,00 e caiu R$ 0,50 do topo, fecha.
            const trailingStop = state.maxProfitReached >= 1.00 && currentBRLResult < (state.maxProfitReached - 0.50);
            
            // Inversão de Tendência: Cruzou a EMA 200 contra a posição
            const trendReversal = isLong ? currentPrice < ema200 : currentPrice > ema200;

            if (takeProfit || stopLoss || trailingStop || trendReversal) {
                const reason = stopLoss ? '🛑 STOP' : (trailingStop ? '📈 TRAILING' : (trendReversal ? '🔄 TENDÊNCIA' : '💰 ALVO'));
                try {
                    const orderSide = isLong ? 'sell' : 'buy';
                    await exchange.createMarketOrder(SYMBOL, orderSide, state.amount, { 'reduceOnly': true });
                    
                    state.dailyProfitBRL += currentBRLResult;
                    const statusMsg = `🏁 POSIÇÃO ENCERRADA (${reason}) | Lucro: R$ ${currentBRLResult.toFixed(2)} | Total Hoje: R$ ${state.dailyProfitBRL.toFixed(2)} / Meta: R$ ${DAILY_TARGET_BRL.toFixed(2)}`;
                    log(statusMsg);

                    state.inPosition = false;
                    state.trades.push({ type: 'CLOSE', price: currentPrice, profit: currentBRLResult, time: new Date().toISOString(), reason });
                    saveState();
                } catch (e) { log(`❌ Erro no fechamento: ${e.message}`); }
            }
        }
    } catch (e) {}
}

log(`🚀 NÍVEL 5: QUANT-MASTER ATIVADO (Tripla Confirmação + Trailing Stop)`);
const app = express();
app.use(cors());
app.use(basicAuth({ users: { 'admin': DASHBOARD_PWD }, challenge: true }));
app.get('/api/stats', (req, res) => res.json({...state, priceHistory, isPaused })); 
app.get('/api/logs', (req, res) => {
    if (fs.existsSync(LOG_FILE)) res.json(fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-60));
    else res.json([]);
});

app.post('/api/toggle-pause', (req, res) => {
    isPaused = !isPaused;
    log(isPaused ? '⏸️ Bot Pausado manualmente' : '▶️ Bot Retomado manualmente');
    res.json({ isPaused });
});

app.post('/api/close-position', async (req, res) => {
    if (!state.inPosition) return res.status(400).json({ error: 'Nenhuma posição aberta' });
    log('⚠️ Fechamento manual solicitado via Dashboard');
    
    try {
        const isLong = state.direction === 'LONG';
        const orderSide = isLong ? 'sell' : 'buy';
        await exchange.createMarketOrder(SYMBOL, orderSide, state.amount, { 'reduceOnly': true });
        
        // Calculamos o lucro aproximado no momento do fechamento manual
        const data = await getIndicators();
        let profit = 0;
        if (data) {
            const currentPrice = data.currentPrice;
            const priceChange = isLong ? 
                (currentPrice - state.entryPrice) / state.entryPrice :
                (state.entryPrice - currentPrice) / state.entryPrice;
            profit = priceChange * BANK_BRL * LEVERAGE;
        }

        state.inPosition = false;
        state.dailyProfitBRL += profit;
        state.trades.push({ type: 'CLOSE_MANUAL', time: new Date().toISOString(), profit });
        saveState();
        res.json({ success: true });
    } catch (e) {
        log(`❌ Erro no fechamento manual: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => log(`🌐 API Dashboard ativa.`));

setupTradeMode();
setInterval(run, 15000); 
run();
